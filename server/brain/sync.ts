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

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const searchTermKey = (campaignId: string, keywordExternalId: string, term: string) =>
  hash(['search-term', campaignId, keywordExternalId, normalizeTerm(term)]);

/**
 * Collects account structure and daily performance from the platform and
 * stores it at the same grains the rest of Orbit already uses: campaign/day
 * observations, keyword/day target cells, and search-term/day cells. The
 * trailing attribution window is always re-pulled so late conversions replace
 * earlier provisional values. Missing cells inside the window become explicit
 * zero rows only where the parent campaign reported a day.
 */
export async function syncAccount(
  store: Store,
  account: AdAccount,
  connector: Connector,
  now = new Date(),
): Promise<SyncRun> {
  const startedAt = new Date().toISOString();
  const clock = accountNow(store, account.dataset, now);
  const observedAt = clock.toISOString();
  const endDate = dayAt(clock, -1);
  const watermark = account.health.watermarkDate;
  const startDate =
    watermark && watermark <= endDate
      ? dayAt(new Date(`${watermark}T00:00:00Z`), -(account.attributionDays + 2))
      : dayAt(clock, -56);
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
    const success = status === 'ok' || status === 'partial';
    const health = {
      status,
      message,
      lastAttemptAt: run.finishedAt,
      lastSuccessAt: success ? run.finishedAt : account.health.lastSuccessAt,
      watermarkDate: success && links.length ? endDate : account.health.watermarkDate,
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
        success ? 'Account synchronized' : 'Account synchronization failed',
        `${account.name}: ${message}`,
      );
    });
    return run;
  };
  let snapshot: PlatformSnapshot;
  try {
    const campaigns = await connector.listCampaigns();
    const ids = campaigns.map((c) => c.externalId);
    const [adGroups, keywords, negatives] = await Promise.all([
      connector.listAdGroups(ids),
      connector.listKeywords(ids),
      connector.listNegativeKeywords(ids),
    ]);
    snapshot = { observedAt, campaigns, adGroups, keywords, negatives };
  } catch (error) {
    return finish(classify(error), describe(error), null);
  }
  if (!links.length)
    return finish(
      'partial',
      'Structure captured. Link local campaigns to platform campaigns to collect performance.',
      snapshot,
    );
  let reports: Record<'campaign' | 'keyword' | 'searchTerm', ReportRow[]>;
  try {
    const [campaign, keyword, searchTerm] = await Promise.all(
      (['campaign', 'keyword', 'searchTerm'] as const).map((kind) =>
        connector.report(kind, startDate, endDate, account.attributionDays),
      ),
    );
    reports = { campaign, keyword, searchTerm };
  } catch (error) {
    return finish(classify(error), describe(error), snapshot);
  }
  const notes: string[] = [];
  store.transaction(() => {
    for (const link of links) {
      const campaign = store.campaign(account.dataset, link.campaignId);
      const parentRows = reports.campaign
        .filter(
          (r) =>
            r.campaignExternalId === link.externalCampaignId &&
            r.date >= startDate &&
            r.date <= endDate,
        )
        .map((r) => toObservation(campaign.id, r, observedAt, notes));
      if (!parentRows.length) {
        notes.push(`${campaign.name}: no campaign rows in the window.`);
        continue;
      }
      const refunds = new Map(store.observations(campaign.id).map((r) => [r.date, r.refundsCents]));
      store.importRows(parentRows.map((r) => ({ ...r, refundsCents: refunds.get(r.date) || 0 })));
      if (campaign.status === 'draft') store.saveCampaign({ ...campaign, status: 'observing' });
      run.rows.campaigns += parentRows.length;
      const parentDates = parentRows.map((r) => r.date);

      const keywordCells = new Map<string, { target: Target; rows: Observation[] }>();
      for (const row of reports.keyword) {
        if (row.campaignExternalId !== link.externalCampaignId || !row.keywordExternalId) continue;
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
        cell.rows.push(toObservation(campaign.id, row, observedAt, notes));
        keywordCells.set(target.id, cell);
      }
      // Refund adjustments are operator corrections, not platform facts; keep them.
      const keywordEntries = [...keywordCells.values()].map((cell) => {
        const priorRefunds = new Map(
          store.targetRows(cell.target.id).map((r) => [r.date, r.refundsCents]),
        );
        return {
          target: cell.target,
          rows: fillZeros(campaign.id, cell.rows, parentDates, observedAt).map((r) => ({
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
        cell.rows.push(toObservation(campaign.id, row, observedAt, notes));
        termCells.set(term.id, cell);
      }
      const termEntries = [...termCells.values()].map((cell) => ({
        term: cell.term,
        rows: fillZeros(campaign.id, cell.rows, parentDates, observedAt),
      }));
      if (termEntries.length) {
        store.importSearchTerms(termEntries);
        run.rows.searchTerms += termEntries.length;
      }
    }
  });
  const summary = `${run.rows.campaigns} campaign days, ${run.rows.keywords} keyword days, ${run.rows.searchTerms} search terms from ${startDate} to ${endDate}.`;
  return finish(
    notes.length ? 'partial' : 'ok',
    notes.length ? `${summary} ${[...new Set(notes)].slice(0, 5).join(' ')}` : summary,
    snapshot,
  );
}

function toObservation(
  campaignId: string,
  row: ReportRow,
  observedAt: string,
  notes: string[],
): Observation {
  const clicks = Math.min(row.clicks, Math.max(row.impressions, row.clicks));
  let orders = row.purchases;
  if (orders > clicks) {
    notes.push(
      'Some rows reported more purchases than clicks; purchases were capped at clicks for the conversion model.',
    );
    orders = clicks;
  }
  return {
    campaignId,
    date: row.date,
    impressions: Math.max(row.impressions, clicks),
    clicks,
    orders,
    spendCents: row.costCents,
    salesCents: row.salesCents,
    refundsCents: 0,
    observedAt,
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
  error instanceof ConnectorError ? (error.kind === 'throttled' ? 'throttled' : 'error') : 'error';
const describe = (error: unknown) =>
  error instanceof ConnectorError
    ? `${error.kind}: ${error.message}`
    : 'Unexpected synchronization failure.';

export const linkedCampaigns = (
  store: Store,
  account: AdAccount,
): { link: AccountLink; campaignId: string }[] =>
  store.links(account.id).map((link) => ({ link, campaignId: link.campaignId }));
