import { createHash, randomUUID } from 'node:crypto';
import type {
  AccountLink,
  AdAccount,
  Observation,
  PlatformSnapshot,
  SearchTerm,
  SyncRun,
  Target,
} from '../../shared/types.js';
import { Store } from '../store.js';
import { dayAt } from '../engine.js';
import { targetKey } from '../targets.js';
import {
  ConnectorError,
  normalizeTerm,
  type Connector,
  type ReportRow,
} from '../connectors/connector.js';
import { accountNow } from './accounts.js';
import { syncPlan, finishSyncPlan, reportGenerationTime } from './report-jobs.js';
import { AmazonAdsConnector } from '../connectors/amazon.js';
import { AppError } from '../validation.js';
import { saveProductReport } from '../books.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const searchTermKey = (campaignId: string, keywordExternalId: string, term: string) =>
  hash(['search-term', campaignId, keywordExternalId, normalizeTerm(term)]);

/**
 * Collects account structure and daily performance from the platform and
 * stores it at the same grains the rest of Orbit already uses: campaign/day
 * observations, keyword/day target cells, and search-term/day cells. The
 * live restatement window is re-pulled, with report jobs persisted across
 * restarts. Activity-only reports never create synthetic live zero rows.
 */
const inFlight = new WeakMap<Store, Map<string, Promise<SyncRun>>>();
export function syncAccount(
  store: Store,
  account: AdAccount,
  connector: Connector,
  now = new Date(),
): Promise<SyncRun> {
  const running = inFlight.get(store) || new Map<string, Promise<SyncRun>>();
  inFlight.set(store, running);
  const prior = running.get(account.id);
  if (prior) return prior;
  const task = synchronize(store, account, connector, now).finally(() =>
    running.delete(account.id),
  );
  running.set(account.id, task);
  return task;
}

async function synchronize(
  store: Store,
  account: AdAccount,
  connector: Connector,
  now = new Date(),
): Promise<SyncRun> {
  const startedAt = new Date().toISOString();
  const clock = accountNow(store, account.dataset, now);
  const observedAt = clock.toISOString();
  const live = connector.kind === 'amazon-ads';
  const plan = live ? syncPlan(store, account, clock) : null;
  const endDate = plan?.endDate || dayAt(clock, -1, account.timezone);
  const watermark = account.health.watermarkDate;
  const startDate =
    plan?.startDate ||
    (watermark && watermark <= endDate
      ? dayAt(new Date(`${watermark}T00:00:00Z`), -(account.attributionDays + 2))
      : dayAt(clock, -56, account.timezone));
  const links = store.links(account.id).filter((l) => {
    try {
      return store.campaign(account.dataset, l.campaignId).dataset === account.dataset;
    } catch {
      return false;
    }
  });
  const run: SyncRun = {
    id: randomUUID(),
    accountId: account.id,
    dataset: account.dataset,
    startedAt,
    finishedAt: startedAt,
    status: 'ok',
    message: '',
    startDate,
    endDate,
    rows: { campaigns: 0, keywords: 0, searchTerms: 0 },
  };
  const finish = (
    status: SyncRun['status'],
    message: string,
    snapshot: PlatformSnapshot | null,
  ) => {
    run.status = status;
    run.message = message;
    run.finishedAt = new Date().toISOString();
    const success = status === 'ok';
    const health = {
      status,
      message,
      lastAttemptAt: run.finishedAt,
      lastSuccessAt: success ? run.finishedAt : account.health.lastSuccessAt,
      watermarkDate: success ? endDate : account.health.watermarkDate,
      coverage: snapshot
        ? {
            campaigns: snapshot.campaigns.length,
            keywords: snapshot.keywords.length,
            negatives: snapshot.negatives.length,
            searchTerms: run.rows.searchTerms,
          }
        : account.health.coverage,
    };
    store.transaction(() => {
      if (snapshot) store.saveSnapshot(account.id, snapshot);
      store.saveAccount({ ...store.account(account.dataset, account.id), health });
      store.saveSyncRun(run);
      store.activity(
        account.dataset,
        'import',
        success
          ? 'Account synchronized'
          : status === 'pending'
            ? 'Amazon reports queued'
            : 'Account synchronization needs attention',
        `${account.name}: ${message}`,
      );
    });
    return run;
  };
  let snapshot: PlatformSnapshot;
  try {
    if (live && (!account.verifiedAt || !account.region))
      throw new ConnectorError(
        'invalid',
        'Verify this Amazon Ads profile before collecting performance.',
      );
    const savedSnapshot = live ? store.snapshot(account.id) : null;
    const resumesCurrentGeneration =
      plan &&
      savedSnapshot &&
      ['pending', 'throttled'].includes(account.health.status) &&
      Date.parse(savedSnapshot.observedAt) >= Date.parse(plan.createdAt);
    if (resumesCurrentGeneration) {
      // Report polling can last hours. Reuse the structure captured for this fixed
      // generation so one-minute job checks do not relist a large account.
      snapshot = savedSnapshot;
    } else {
      if (connector instanceof AmazonAdsConnector) {
        const profile = (await connector.listProfiles()).find(
          (p) => p.profileId === account.profileId,
        );
        if (
          !profile ||
          profile.currencyCode !== account.currency ||
          profile.timezone !== account.timezone ||
          profile.countryCode !== account.marketplace
        )
          throw new ConnectorError(
            'invalid',
            'The profile is unavailable or its reporting settings changed. Reconcile the connection before importing data.',
          );
      }
      const campaigns = await connector.listCampaigns();
      const ids = campaigns.map((c) => c.externalId);
      const [adGroups, keywords, negatives] = await Promise.all([
        connector.listAdGroups(ids),
        connector.listKeywords(ids),
        connector.listNegativeKeywords(ids),
      ]);
      snapshot = { observedAt, campaigns, adGroups, keywords, negatives };
    }
  } catch (error) {
    return finish(classify(error), describe(error), null);
  }
  if (!links.length && !live)
    return finish(
      'partial',
      'Structure captured. Link local campaigns to platform campaigns to collect performance.',
      snapshot,
    );
  let reports: Record<'campaign' | 'keyword' | 'searchTerm' | 'advertisedProduct', ReportRow[]>;
  try {
    const kinds = live
      ? (['campaign', 'keyword', 'searchTerm', 'advertisedProduct'] as const)
      : (['campaign', 'keyword', 'searchTerm'] as const);
    const outcomes = await Promise.allSettled(
      kinds.map((kind) => connector.report(kind, startDate, endDate, account.attributionDays)),
    );
    const failures = outcomes.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const hardFailure = failures.find(
      (r) => !(r.reason instanceof ConnectorError) || r.reason.kind !== 'pending',
    );
    if (hardFailure || failures.length) throw (hardFailure || failures[0]).reason;
    reports = { campaign: [], keyword: [], searchTerm: [], advertisedProduct: [] };
    outcomes.forEach((r, index) => {
      if (r.status === 'fulfilled') reports[kinds[index]] = r.value;
    });
  } catch (error) {
    return finish(classify(error), describe(error), snapshot);
  }
  const notes: string[] = [];
  try {
    store.transaction(() => {
      if (live)
        saveProductReport(
          store,
          account.id,
          reports.advertisedProduct,
          startDate,
          endDate,
          plan
            ? reportGenerationTime(
                store,
                account.id,
                'advertisedProduct',
                startDate,
                endDate,
                account.attributionDays,
                plan.createdAt,
              )
            : null,
        );
      for (const link of links) {
        const campaign = store.campaign(account.dataset, link.campaignId);
        if ((campaign.reportingTimezone || 'UTC') !== account.timezone)
          throw new AppError('Campaign and account reporting timezones differ.');
        const parentRows = reports.campaign
          .filter(
            (r) =>
              r.campaignExternalId === link.externalCampaignId &&
              r.date >= startDate &&
              r.date <= endDate,
          )
          .map((r) => toObservation(campaign.id, r, observedAt));
        if (!parentRows.length) {
          notes.push(`${campaign.name}: no campaign rows in the window.`);
          continue;
        }
        const refunds = new Map(
          store.observations(campaign.id).map((r) => [r.date, r.refundsCents]),
        );
        store.importRows(parentRows.map((r) => ({ ...r, refundsCents: refunds.get(r.date) || 0 })));
        if (campaign.status === 'draft') store.saveCampaign({ ...campaign, status: 'observing' });
        run.rows.campaigns += parentRows.length;
        const parentDates = parentRows.map((r) => r.date);
        if (live) {
          const prior = store
            .observations(campaign.id)
            .filter((r) => r.date >= startDate && r.date <= endDate);
          if (prior.some((r) => !parentDates.includes(r.date)))
            notes.push(
              campaign.name +
                ': previously reported days are missing from this report; reconcile coverage.',
            );
        }

        const keywordCells = new Map<string, { target: Target; rows: Observation[] }>();
        for (const row of reports.keyword) {
          if (row.campaignExternalId !== link.externalCampaignId || !row.keywordExternalId)
            continue;
          if (row.date < startDate || row.date > endDate) continue;
          const matchType = row.matchType && row.matchType !== 'auto' ? row.matchType : 'auto';
          const target: Target = {
            id: targetKey(campaign.id, row.keywordExternalId),
            campaignId: campaign.id,
            sourceId: row.keywordExternalId,
            label: row.keywordText || row.keywordExternalId,
            kind: 'keyword',
            matchType,
          };
          const cell = keywordCells.get(target.id) || { target, rows: [] };
          cell.rows.push(toObservation(campaign.id, row, observedAt));
          keywordCells.set(target.id, cell);
        }
        // Refund adjustments are operator corrections, not platform facts; keep them.
        const keywordEntries = [...keywordCells.values()].map((cell) => {
          const priorRefunds = new Map(
            store.targetRows(cell.target.id).map((r) => [r.date, r.refundsCents]),
          );
          return {
            target: cell.target,
            rows: (live
              ? cell.rows
              : fillZeros(campaign.id, cell.rows, parentDates, observedAt)
            ).map((r) => ({
              ...r,
              refundsCents: priorRefunds.get(r.date) || 0,
            })),
          };
        });
        if (keywordEntries.length) {
          store.importTargets(keywordEntries);
          run.rows.keywords += keywordEntries.reduce((n, e) => n + e.rows.length, 0);
        }

        const termCells = new Map<string, { term: SearchTerm; rows: Observation[] }>();
        for (const row of reports.searchTerm) {
          if (row.campaignExternalId !== link.externalCampaignId || !row.searchTerm) continue;
          if (row.date < startDate || row.date > endDate) continue;
          const keywordExternalId = row.keywordExternalId || 'auto';
          const term: SearchTerm = {
            id: searchTermKey(campaign.id, keywordExternalId, row.searchTerm),
            campaignId: campaign.id,
            term: normalizeTerm(row.searchTerm),
            keywordExternalId,
            keywordText: row.keywordText || 'automatic targeting',
            matchType: row.matchType || 'auto',
            adGroupExternalId: row.adGroupExternalId || link.adGroupExternalId,
          };
          const cell = termCells.get(term.id) || { term, rows: [] };
          cell.rows.push(toObservation(campaign.id, row, observedAt));
          termCells.set(term.id, cell);
        }
        const termEntries = [...termCells.values()].map((cell) => ({
          term: cell.term,
          rows: live ? cell.rows : fillZeros(campaign.id, cell.rows, parentDates, observedAt),
        }));
        if (termEntries.length) {
          store.importSearchTerms(termEntries);
          run.rows.searchTerms += termEntries.length;
        }
      }
      if (live) {
        const retainFrom = dayAt(clock, -94, account.timezone);
        store.db
          .prepare('DELETE FROM advertised_product_rows WHERE account_id=? AND date<?')
          .run(account.id, retainFrom);
        for (const link of links) {
          store.db
            .prepare(
              'DELETE FROM search_term_observations WHERE date<? AND term_id IN (SELECT id FROM search_terms WHERE campaign_id=?)',
            )
            .run(retainFrom, link.campaignId);
          store.db
            .prepare(
              'DELETE FROM search_terms WHERE campaign_id=? AND NOT EXISTS (SELECT 1 FROM search_term_observations o WHERE o.term_id=search_terms.id)',
            )
            .run(link.campaignId);
        }
        finishSyncPlan(store, account.id);
      }
    });
  } catch (error) {
    run.rows = { campaigns: 0, keywords: 0, searchTerms: 0 };
    return finish('error', error instanceof AppError ? error.message : describe(error), snapshot);
  }
  const summary = `${run.rows.campaigns} campaign days, ${run.rows.keywords} keyword days, ${run.rows.searchTerms} search terms from ${startDate} to ${endDate}.`;
  return finish(
    notes.length ? 'partial' : 'ok',
    notes.length ? `${summary} ${[...new Set(notes)].slice(0, 5).join(' ')}` : summary,
    snapshot,
  );
}

function toObservation(campaignId: string, row: ReportRow, observedAt: string): Observation {
  if (
    ![row.impressions, row.clicks, row.purchases, row.costCents, row.salesCents].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    ) ||
    row.clicks > row.impressions ||
    row.purchases > row.clicks
  )
    throw new ConnectorError(
      'invalid',
      'Reported counts do not fit the click-conversion model. Original report facts are retained for review; counts were not capped or changed.',
    );
  return {
    campaignId,
    date: row.date,
    impressions: row.impressions,
    clicks: row.clicks,
    orders: row.purchases,
    spendCents: row.costCents,
    salesCents: row.salesCents,
    refundsCents: 0,
    observedAt: row.observedAt || observedAt,
  };
}

function fillZeros(
  campaignId: string,
  rows: Observation[],
  parentDates: string[],
  observedAt: string,
): Observation[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const merged: Observation[] = [];
  for (const date of parentDates) {
    const existing = byDate.get(date);
    merged.push(
      existing ?? {
        campaignId,
        date,
        impressions: 0,
        clicks: 0,
        orders: 0,
        spendCents: 0,
        salesCents: 0,
        refundsCents: 0,
        observedAt,
      },
    );
  }
  // Keep rows outside the parent date list too (a keyword row without a parent
  // row is surfaced by the existing reconciliation gate rather than dropped).
  for (const row of rows) if (!parentDates.includes(row.date)) merged.push(row);
  return merged.sort((a, b) => a.date.localeCompare(b.date));
}

const classify = (error: unknown): SyncRun['status'] =>
  error instanceof ConnectorError
    ? error.kind === 'pending'
      ? 'pending'
      : error.kind === 'throttled'
        ? 'throttled'
        : 'error'
    : 'error';
const describe = (error: unknown) =>
  error instanceof ConnectorError
    ? `${error.kind}: ${error.message}`
    : 'Unexpected synchronization failure.';

export const linkedCampaigns = (
  store: Store,
  account: AdAccount,
): { link: AccountLink; campaignId: string }[] =>
  store.links(account.id).map((link) => ({ link, campaignId: link.campaignId }));
