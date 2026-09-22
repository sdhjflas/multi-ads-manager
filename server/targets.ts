import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type { Campaign, Observation, Target, TargetView } from '../shared/types.js';
import { decide, metrics, dayAt } from './engine.js';
import { importInput, AppError } from './validation.js';
import { parseImport } from './importer.js';

export const targetImportInput = importInput.extend({ format: z.literal('targets') });
export const targetHeaders = [
  'date',
  'target_id',
  'target',
  'kind',
  'match_type',
  'impressions',
  'clicks',
  'orders',
  'spend_cents',
  'sales_cents',
  'refunds_cents',
];
export const targetKey = (campaignId: string, sourceId: string) =>
  createHash('sha256')
    .update(JSON.stringify([campaignId, sourceId]))
    .digest('hex');

export function parseTargetImport(
  input: z.infer<typeof targetImportInput>,
  campaign: Campaign,
  now = new Date(),
): { target: Target; rows: Observation[] }[] {
  let parsed: Record<string, string>[];
  try {
    parsed = parse(input.csv, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 20000,
      columns: (names: string[]) => {
        if (
          names.length !== targetHeaders.length ||
          new Set(names).size !== names.length ||
          names.some((n) => !targetHeaders.includes(n))
        )
          throw new Error('Wrong columns');
        return names;
      },
    }) as Record<string, string>[];
  } catch {
    throw new AppError(`Use the exact target template headers: ${targetHeaders.join(', ')}.`);
  }
  if (parsed.length < 1 || parsed.length > 10000)
    throw new AppError('Import 1–10,000 target/day rows.');
  const groups = new Map<string, { target: Target; source: Record<string, string>[] }>();
  for (const row of parsed) {
    if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(row.target_id))
      throw new AppError(
        'Target IDs must be stable IDs with letters, digits, periods, underscores, colons, or hyphens.',
      );
    const shape = z
      .object({
        label: z.string().trim().min(1).max(200),
        kind: z.enum(['keyword', 'product-target', 'creative']),
        matchType: z.enum(['exact', 'phrase', 'broad', 'auto', 'product', 'creative']),
      })
      .parse({ label: row.target, kind: row.kind, matchType: row.match_type });
    if ((campaign.vertical === 'commerce') !== (shape.kind === 'creative'))
      throw new AppError(
        'Product campaigns accept creative cells; book campaigns accept keyword or product targets.',
      );
    if (
      (shape.kind === 'creative' && shape.matchType !== 'creative') ||
      (shape.kind === 'product-target' && shape.matchType !== 'product') ||
      (shape.kind === 'keyword' && !['exact', 'phrase', 'broad', 'auto'].includes(shape.matchType))
    )
      throw new AppError('Target kind and match type disagree.');
    const target: Target = {
      id: targetKey(campaign.id, row.target_id),
      campaignId: campaign.id,
      sourceId: row.target_id,
      ...shape,
    };
    const existing = groups.get(target.id);
    if (existing && JSON.stringify(existing.target) !== JSON.stringify(target))
      throw new AppError('One target ID has multiple definitions in this report.');
    if (existing) existing.source.push(row);
    else groups.set(target.id, { target, source: [row] });
  }
  if (groups.size > 500)
    throw new AppError('A single report can contain at most 500 target definitions.');
  return [...groups.values()].map(({ target, source }) => {
    const headers = [
      'date',
      'impressions',
      'clicks',
      'orders',
      'spend_cents',
      'sales_cents',
      'refunds_cents',
    ];
    const csv = [
      headers.join(','),
      ...source.map((row) => headers.map((h) => `"${row[h].replaceAll('"', '""')}"`).join(',')),
    ].join('\n');
    return { target, rows: parseImport({ ...input, format: 'canonical', csv }, campaign, now) };
  });
}

export function targetView(
  target: Target,
  campaign: Campaign,
  rows: Observation[],
  campaignRows: Observation[],
  days: number,
  exceedsCampaign: boolean,
  now = new Date(),
): TargetView {
  const decision = decide({ ...campaign, id: target.id, name: target.label }, rows, now);
  const campaignDecision = decide(campaign, campaignRows, now);
  let kind: TargetView['signal']['kind'] =
    decision.kind === 'scale'
      ? target.kind === 'keyword' && target.matchType !== 'exact'
        ? 'harvest'
        : 'confirm'
      : decision.kind === 'reduce'
        ? 'review-waste'
        : decision.kind === 'repair'
          ? 'repair'
          : 'hold';
  let title =
    kind === 'harvest'
      ? 'Candidate for an exact test'
      : kind === 'confirm'
        ? 'Confirm this candidate'
        : kind === 'review-waste'
          ? 'Review inefficient delivery'
          : decision.title;
  let reason =
    kind === 'harvest'
      ? 'Mature target data supports an exact-match hypothesis. Inspect the actual search terms and their relevance before harvesting; a broad keyword is not itself a search-term report.'
      : kind === 'confirm'
        ? 'Promising modeled economics. Keep a control and verify the result before changing bids or scaling delivery.'
        : kind === 'review-waste'
          ? 'This cell is missing its acquisition economics. Inspect relevance, placement, and lag before a negative-target or pause decision.'
          : decision.reason;
  if (
    campaignDecision.kind === 'repair' ||
    campaignDecision.title === 'Learning budget reached' ||
    exceedsCampaign
  ) {
    kind = 'repair';
    title = 'Reconcile the parent campaign';
    reason = exceedsCampaign
      ? 'Target totals exceed the matching campaign/day report, or target dates lack a campaign row. Refresh both at the same grain before interpreting this target.'
      : 'The parent campaign has an evidence or learning-budget blocker. Resolve it before acting on a target-level signal.';
  }
  return {
    ...target,
    campaignName: campaign.name,
    channel: campaign.channel,
    metrics: metrics(
      campaign,
      rows.filter(
        (r) =>
          r.date >= dayAt(now, -days, campaign.reportingTimezone) &&
          r.date < dayAt(now, 0, campaign.reportingTimezone),
      ),
    ),
    signal: {
      kind,
      title,
      reason,
      probabilityProfitable: decision.probabilityProfitable,
      matureClicks: decision.matureClicks,
      matureOrders: decision.matureOrders,
      matureThrough: decision.matureThrough,
      maxAffordableCpcCents: decision.maxAffordableCpcCents,
    },
  };
}

export function targetsExceedCampaign(
  entries: { rows: Observation[] }[],
  campaignRows: Observation[],
): boolean {
  const totals = new Map<
    string,
    { clicks: number; orders: number; spendCents: number; salesCents: number }
  >();
  for (const { rows } of entries)
    for (const row of rows) {
      const old = totals.get(row.date) || { clicks: 0, orders: 0, spendCents: 0, salesCents: 0 };
      totals.set(row.date, {
        clicks: old.clicks + row.clicks,
        orders: old.orders + row.orders,
        spendCents: old.spendCents + row.spendCents,
        salesCents: old.salesCents + row.salesCents,
      });
    }
  return [...totals.entries()].some(([date, total]) => {
    const parent = campaignRows.find((r) => r.date === date);
    return (
      !parent ||
      total.clicks > parent.clicks ||
      total.orders > parent.orders ||
      total.spendCents > parent.spendCents ||
      total.salesCents > parent.salesCents
    );
  });
}
