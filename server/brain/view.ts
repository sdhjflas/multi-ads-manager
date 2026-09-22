import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type {
  AdAccount,
  BrainView,
  Campaign,
  Dataset,
  LedgerEntry,
  PlatformSnapshot,
  Scorecard,
  TestWave,
} from '../../shared/types.js';
import { Store } from '../store.js';
import { AppError, datasetSchema, dateOnly } from '../validation.js';
import { campaignView, dayAt, unitContribution } from '../engine.js';
import { holdForOpenWave } from '../waves.js';
import { analyzeAccount, OPEN_STATUSES } from './policy.js';
import { accountNow } from './accounts.js';
import { aiStatus } from '../ai/provider.js';
import { amazonConfigured } from '../connectors/amazon.js';

export const brainScope = z
  .object({ dataset: datasetSchema.default('demo'), days: z.enum(['7', '28', '56']).default('28') })
  .strict();

export function brainView(
  store: Store,
  dataset: Dataset,
  days: number,
  now = new Date(),
): BrainView {
  const clock = accountNow(store, dataset, now);
  const accounts = store.accounts(dataset);
  const links = store.links().filter((l) => accounts.some((a) => a.id === l.accountId));
  const linksByCampaign = new Map(links.map((link) => [link.campaignId, link]));
  const platform: Record<string, PlatformSnapshot> = {};
  for (const account of accounts) {
    const snapshot = store.snapshot(account.id);
    if (snapshot) platform[account.id] = snapshot;
  }
  const analyses = accounts.flatMap((account) => analyzeAccount(store, account, clock, days));
  const analysesByCampaign = new Map(analyses.map((analysis) => [analysis.campaign.id, analysis]));
  const open = accounts.flatMap((account) => store.accountProposals(account.id, OPEN_STATUSES));
  const openIds = new Set(open.map((proposal) => proposal.id));
  const proposals = [
    ...open,
    ...store.proposals(dataset, 500).filter((proposal) => !openIds.has(proposal.id)),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const waves = store.records<TestWave>(dataset, 'wave', 200);
  const ai = aiStatus();
  const scorecards: Scorecard[] = store.campaigns(dataset).map((campaign) => {
    const link = linksByCampaign.get(campaign.id);
    const snapshot = link ? platform[link.accountId] : undefined;
    const platformCampaign = snapshot?.campaigns.find(
      (c) => c.externalId === link?.externalCampaignId,
    );
    const rows = store.observations(campaign.id);
    const view = campaignView(campaign, rows, days, clock);
    const unit = unitContribution(campaign);
    const ledgerRows = store
      .ledger(campaign.id)
      .filter(
        (r) =>
          r.date >= dayAt(clock, -days, campaign.reportingTimezone) &&
          r.date < dayAt(clock, 0, campaign.reportingTimezone),
      );
    const ledger = ledgerRows.length
      ? {
          units: ledgerRows.reduce((s, r) => s + r.units, 0),
          netReceiptsCents: ledgerRows.reduce((s, r) => s + r.netReceiptsCents, 0),
          refundsCents: ledgerRows.reduce((s, r) => s + r.refundsCents, 0),
          days: ledgerRows.length,
        }
      : null;
    const analysis = analysesByCampaign.get(campaign.id);
    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      entityName: campaign.entityName,
      linked: Boolean(link),
      platformState: platformCampaign?.state ?? null,
      platformDailyBudgetCents: platformCampaign?.dailyBudgetCents ?? null,
      metrics: view.metrics,
      breakEvenAcos: view.breakEvenAcos,
      targetAcos:
        unit !== null && unit - campaign.targetProfitCents > 0
          ? (unit - campaign.targetProfitCents) / campaign.retailPriceCents
          : null,
      keywords:
        snapshot?.keywords.filter((k) => k.campaignExternalId === link?.externalCampaignId)
          .length ?? 0,
      searchTerms: analysis?.terms.length ?? 0,
      ledger,
      ledgerContributionCents:
        ledger && campaign.economicsVerified
          ? ledger.netReceiptsCents -
            ledger.units * campaign.variableCostCents -
            ledger.refundsCents -
            view.metrics.spendCents
          : null,
      decision: holdForOpenWave(view.decision, waves, campaign.id),
      openProposals: store.proposalCount(dataset, campaign.id, OPEN_STATUSES),
    };
  });
  return {
    dataset,
    generatedAt: now.toISOString(),
    days,
    accounts,
    links,
    platform,
    scorecards,
    proposals,
    searchTerms: analyses
      .flatMap((a) => a.terms)
      .sort((a, b) => b.metrics.spendCents - a.metrics.spendCents)
      .slice(0, 500),
    executions: store.executions(dataset, 200),
    syncRuns: store.syncRuns(dataset, 50),
    ai: {
      provider: ai.provider,
      model: ai.model,
      requestsToday: store.aiRequests(),
      dailyLimit: ai.dailyLimit,
    },
    integrations: {
      amazonAds: {
        configured: amazonConfigured(),
        writesEnabled: process.env.AMAZON_ADS_WRITES_ENABLED === 'true',
      },
      anthropic: ai.anthropic,
      openai: ai.openai,
    },
  };
}

export const ledgerInput = z
  .object({
    dataset: z.literal('workspace'),
    campaignId: z.string().min(1).max(160),
    csv: z.string().min(1).max(1_000_000),
    reconciled: z.literal(true),
  })
  .strict();
export const ledgerHeaders = ['date', 'units', 'net_receipts_cents', 'refunds_cents'];

/** Business ledger rows: reconciled units and receipts, independent of platform attribution. */
export function parseLedger(campaign: Campaign, csv: string, now = new Date()): LedgerEntry[] {
  let rows: Record<string, string>[];
  try {
    rows = parse(csv, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 20_000,
      columns: (names: string[]) => {
        if (names.length !== ledgerHeaders.length || names.some((n) => !ledgerHeaders.includes(n)))
          throw new Error('Wrong columns');
        return names;
      },
    }) as Record<string, string>[];
  } catch {
    throw new AppError(`Use the exact ledger headers: ${ledgerHeaders.join(', ')}.`);
  }
  if (!rows.length || rows.length > 2000) throw new AppError('Import 1–2,000 ledger days.');
  const seen = new Set<string>();
  return rows.map((r, i) => {
    const label = `Row ${i + 2}`;
    if (!dateOnly(r.date) || r.date >= dayAt(now, 0, campaign.reportingTimezone))
      throw new AppError(`${label}: use a completed date in YYYY-MM-DD format.`);
    if (seen.has(r.date)) throw new AppError(`${label}: duplicate date.`);
    seen.add(r.date);
    const whole = (v: string, name: string) => {
      if (!/^\d+$/.test(v || ''))
        throw new AppError(`${label}: ${name} must be a nonnegative whole number.`);
      const n = Number(v);
      if (n > 100_000_000) throw new AppError(`${label}: ${name} is out of range.`);
      return n;
    };
    return {
      campaignId: campaign.id,
      date: r.date,
      units: whole(r.units, 'units'),
      netReceiptsCents: whole(r.net_receipts_cents, 'net_receipts_cents'),
      refundsCents: whole(r.refunds_cents, 'refunds_cents'),
      observedAt: now.toISOString(),
    };
  });
}

export const isAccountOf = (account: AdAccount, dataset: Dataset) => account.dataset === dataset;
