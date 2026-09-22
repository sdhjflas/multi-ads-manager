import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type {
  Learning,
  Observation,
  ReportChangeCounts,
  ReportPreview,
  ReportReceipt,
  ReportRevision,
  ReportSource,
  Target,
  TestWave,
} from '../shared/types.js';
import { Store } from './store.js';
import { AppError, datasetSchema } from './validation.js';
import { importTemplate, parseImport } from './importer.js';
import { parseTargetImport, targetHeaders, targetsExceedCampaign } from './targets.js';

const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const label = z.string().trim().min(1).max(160);
export const sourceInput = z
  .object({
    dataset: z.literal('workspace'),
    name: label,
    provider: z.enum(['meta', 'amazon', 'tiktok']),
    accountRef: z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/),
    profile: z.enum(['orbit-campaigns', 'orbit-targets', 'amazon-campaigns']),
    attributionDays: z.number().int().min(1).max(30),
    currency: z.literal('USD'),
    timezone: z.literal('UTC'),
    mappings: z
      .array(z.object({ externalCampaignId: label, campaignId: label }).strict())
      .min(1)
      .max(200),
    contractVerified: z.literal(true),
  })
  .strict();
export const batchInput = z
  .object({
    dataset: z.literal('workspace'),
    sourceId: z.string().uuid(),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\\/\x00-\x1F]+$/),
    exportedAt: z.iso.datetime(),
    csv: z.string().min(1).max(1_000_000),
    exportVerified: z.literal(true),
  })
  .strict();
export const reportScope = z.object({ dataset: datasetSchema }).strict();
type Group = {
  campaignId: string;
  rows: Observation[];
  targets: { target: Target; rows: Observation[] }[];
};
type Payload = { groups: Group[] };
const canonical = importTemplate.trim().split(',');
const grain = (source: ReportSource) =>
  source.profile === 'orbit-targets' ? 'target' : 'campaign';
const counters = (): ReportChangeCounts => ({
  inserted: 0,
  corrected: 0,
  refreshed: 0,
  unchanged: 0,
});
const facts = (row: Observation | null) =>
  row
    ? [
        row.campaignId,
        row.date,
        row.impressions,
        row.clicks,
        row.orders,
        row.spendCents,
        row.salesCents,
        row.refundsCents,
      ]
    : null;
const changed = (a: Observation | null, b: Observation) => hash(facts(a)) !== hash(facts(b));
const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
const csvFor = (headers: string[], rows: Record<string, string>[]) =>
  [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');

export function reportSources(store: Store, dataset: string): ReportSource[] {
  return (
    store.db
      .prepare('SELECT body FROM report_sources WHERE dataset=? ORDER BY id')
      .all(dataset) as { body: string }[]
  ).map((r) => JSON.parse(r.body));
}
export function reportSource(store: Store, dataset: string, id: string): ReportSource {
  const row = store.db
    .prepare('SELECT body FROM report_sources WHERE dataset=? AND id=?')
    .get(dataset, id) as { body: string } | undefined;
  if (!row) throw new AppError('Report source not found in this workspace.', 404);
  return JSON.parse(row.body);
}
export function createSource(store: Store, input: z.infer<typeof sourceInput>): ReportSource {
  if (reportSources(store, input.dataset).length >= 100)
    throw new AppError('This local release supports 100 report sources per workspace.');
  if (input.profile === 'amazon-campaigns' && input.provider !== 'amazon')
    throw new AppError('The Amazon console profile requires Amazon campaigns.');
  if (
    new Set(input.mappings.map((m) => m.campaignId)).size !== input.mappings.length ||
    new Set(input.mappings.map((m) => m.externalCampaignId)).size !== input.mappings.length
  )
    throw new AppError(
      'Each external campaign and local campaign can appear only once in a source.',
    );
  const peers = reportSources(store, input.dataset).filter(
    (s) => s.provider === input.provider && s.accountRef === input.accountRef,
  );
  for (const mapping of input.mappings) {
    const c = store.campaign(input.dataset, mapping.campaignId);
    if (store.links().some((l) => l.campaignId === c.id))
      throw new AppError(
        'This campaign receives API reporting. Use a separate campaign for file-based report sources.',
      );
    if ((c.reportingTimezone || 'UTC') !== input.timezone)
      throw new AppError('Campaign and source reporting timezones must match.');
    if (
      c.channel !== input.provider ||
      c.currency !== input.currency ||
      c.attributionDays !== input.attributionDays
    )
      throw new AppError(
        `${c.name}: provider, currency, and attribution must match the report source.`,
      );
    if (
      input.profile !== 'amazon-campaigns' &&
      !/^[a-zA-Z0-9_.:-]{1,120}$/.test(mapping.externalCampaignId)
    )
      throw new AppError(
        'Normalized profiles require stable external IDs using letters, digits, periods, underscores, colons, or hyphens.',
      );
    for (const peer of peers) {
      const sameIdentityType =
        (peer.profile === 'amazon-campaigns') === (input.profile === 'amazon-campaigns');
      if (
        sameIdentityType &&
        peer.mappings.some(
          (m) => m.externalCampaignId === mapping.externalCampaignId && m.campaignId !== c.id,
        )
      )
        throw new AppError(
          'This external campaign already maps to another local campaign in the account. Reuse its existing mapping to avoid double counting.',
        );
      if (
        sameIdentityType &&
        peer.mappings.some(
          (m) => m.campaignId === c.id && m.externalCampaignId !== mapping.externalCampaignId,
        )
      )
        throw new AppError(
          `${c.name}: campaign and target sources must use the same external campaign ID.`,
        );
    }
    const old = store.db
      .prepare('SELECT source_id FROM report_bindings WHERE campaign_id=? AND grain=?')
      .get(c.id, input.profile === 'orbit-targets' ? 'target' : 'campaign');
    if (old)
      throw new AppError(
        `${c.name} already has a saved source for this report grain. Reuse that source.`,
      );
    const bindings = store.db
      .prepare('SELECT source_id FROM report_bindings WHERE campaign_id=?')
      .all(c.id) as { source_id: string }[];
    for (const binding of bindings) {
      const other = reportSource(store, input.dataset, binding.source_id);
      if (other.accountRef !== input.accountRef || other.provider !== input.provider)
        throw new AppError(
          `${c.name}: campaign and target sources must refer to the same account.`,
        );
    }
  }
  const { contractVerified: _verified, ...contract } = input;
  const source: ReportSource = {
    ...contract,
    id: randomUUID(),
    contractId: hash(contract),
    createdAt: new Date().toISOString(),
  };
  store.db
    .prepare('INSERT INTO report_sources(id,dataset,body) VALUES(?,?,?)')
    .run(source.id, source.dataset, JSON.stringify(source));
  for (const mapping of source.mappings)
    store.db
      .prepare(
        'INSERT INTO report_bindings(campaign_id,grain,source_id,external_id) VALUES(?,?,?,?)',
      )
      .run(mapping.campaignId, grain(source), source.id, mapping.externalCampaignId);
  store.activity(
    source.dataset,
    'import',
    'Report source registered',
    `${source.name}: ${source.mappings.length} explicit campaign mappings; ${source.currency}/${source.timezone}, ${source.attributionDays}-day click attribution. No platform connection was created.`,
  );
  return source;
}

export function sourceTemplate(source: ReportSource): string {
  if (source.profile === 'amazon-campaigns')
    return `Date,Campaign Name,Impressions,Clicks,Spend,${source.attributionDays} Day Total Orders (#),${source.attributionDays} Day Total Sales\n`;
  return (
    [
      'account_id',
      'campaign_id',
      ...(source.profile === 'orbit-targets' ? targetHeaders : canonical),
    ].join(',') + '\n'
  );
}

function normalizeBatch(
  store: Store,
  source: ReportSource,
  input: z.infer<typeof batchInput>,
  now: Date,
): Payload {
  let rows: Record<string, string>[];
  let headers: string[] = [];
  try {
    rows = parse(input.csv, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 20000,
      columns: (names: string[]) => {
        headers = names;
        if (new Set(names).size !== names.length) throw new Error('Duplicate headers');
        return names;
      },
    }) as Record<string, string>[];
  } catch {
    throw new AppError('Invalid CSV. Use unique headers and quote fields containing commas.');
  }
  if (!rows.length || rows.length > 10000)
    throw new AppError('Stage between 1 and 10,000 report rows, within the 1 MB CSV limit.');
  if (headers.some((h) => /email|phone|customer|address|session|order.?id|ip.?address/i.test(h)))
    throw new AppError(
      'Only aggregate report fields are allowed. Remove personal or order-level data.',
    );
  const required = sourceTemplate(source).trim().split(',');
  if (
    required.some((h) => !headers.includes(h)) ||
    (source.profile !== 'amazon-campaigns' && headers.some((h) => !required.includes(h)))
  )
    throw new AppError(`Use this source’s report headers: ${required.join(', ')}.`);
  const grouped = new Map<string, Record<string, string>[]>();
  for (const row of rows) {
    if (source.profile !== 'amazon-campaigns' && row.account_id !== source.accountRef)
      throw new AppError(
        'A row belongs to a different account. Every account_id must match the source reference.',
      );
    if (row.Currency && row.Currency !== source.currency)
      throw new AppError('The report currency differs from the source contract.');
    const key = source.profile === 'amazon-campaigns' ? row['Campaign Name'] : row.campaign_id;
    if (!source.mappings.some((m) => m.externalCampaignId === key))
      throw new AppError(
        `Unmapped campaign “${String(key).slice(0, 160)}”. No rows were staged. Include only this source’s mapped campaigns.`,
      );
    const group = grouped.get(key) || [];
    group.push(row);
    grouped.set(key, group);
  }
  const groups = [...grouped.entries()].map(([externalId, group]) => {
    const mapping = source.mappings.find((m) => m.externalCampaignId === externalId)!;
    const campaign = store.campaign(source.dataset, mapping.campaignId);
    if (campaign.channel !== source.provider || campaign.attributionDays !== source.attributionDays)
      throw new AppError(
        `${campaign.name}: setup changed and no longer matches this source contract.`,
      );
    const common = {
      dataset: source.dataset,
      campaignId: campaign.id,
      attributionDays: source.attributionDays,
      timezone: source.timezone,
      currency: source.currency,
      exportedAt: input.exportedAt,
    };
    if (source.profile === 'orbit-targets')
      return {
        campaignId: campaign.id,
        rows: [],
        targets: parseTargetImport(
          { ...common, format: 'targets', csv: csvFor(targetHeaders, group) },
          campaign,
          now,
        ),
      };
    return {
      campaignId: campaign.id,
      targets: [],
      rows: parseImport(
        {
          ...common,
          format: source.profile === 'amazon-campaigns' ? 'amazon' : 'canonical',
          csv: csvFor(source.profile === 'amazon-campaigns' ? required : canonical, group),
        },
        source.profile === 'amazon-campaigns' ? { ...campaign, name: externalId } : campaign,
        now,
      ),
    };
  });
  return { groups };
}

function checkPreview(
  store: Store,
  source: ReportSource,
  payload: Payload,
  exportedAt: string,
): { preview: ReportPreview; revisions: ReportRevision[]; effective: Payload } {
  const effective = structuredClone(payload);
  const errors: string[] = [],
    warnings: string[] = [];
  const counts = counters();
  const revisions: ReportRevision[] = [];
  const currentState: unknown[] = [];
  const dates: string[] = [];
  const campaigns: ReportPreview['campaigns'] = [];
  let totalSpend = 0,
    deltaSpend = 0,
    targetCount = 0;
  const now = new Date();
  if (now.getTime() - Date.parse(exportedAt) > 48 * 3600000)
    warnings.push(
      'This export is over 48 hours old. Imported history remains usable, but current evidence checks may require a fresh report.',
    );
  if (source.profile === 'amazon-campaigns')
    warnings.push(
      'Amazon console totals omit publisher net-receipt refunds. Existing refund corrections are carried forward; reconcile new returns separately.',
    );
  for (const group of effective.groups) {
    const c = store.campaign(source.dataset, group.campaignId);
    const beforeParent = store.observations(c.id);
    if (source.profile === 'amazon-campaigns') {
      const refunds = new Map(beforeParent.map((r) => [r.date, r.refundsCents]));
      group.rows = group.rows.map((r) => ({ ...r, refundsCents: refunds.get(r.date) || 0 }));
    }
    const beforeTargets = store
      .targets(c.id)
      .map((t) => ({ target: t, rows: store.targetRows(t.id) }));
    currentState.push({ campaign: c, parent: beforeParent, targets: beforeTargets });
    if (
      c.channel !== source.provider ||
      c.attributionDays !== source.attributionDays ||
      c.currency !== source.currency
    )
      errors.push(`${c.name}: campaign setup no longer matches the frozen source contract.`);
    const seenTargets = new Set([
      ...beforeTargets.map((t) => t.target.id),
      ...group.targets.map((t) => t.target.id),
    ]);
    if (seenTargets.size > 500)
      errors.push(`${c.name}: this import would exceed 500 target definitions.`);
    const local = counters();
    let missingDays = 0,
      spend = 0,
      rowCount = 0;
    function compare(afterRows: Observation[], oldRows: Observation[], target: Target | null) {
      const map = new Map(oldRows.map((r) => [r.date, r]));
      const sorted = afterRows.map((r) => r.date).sort();
      missingDays +=
        (Date.parse(sorted.at(-1)!) - Date.parse(sorted[0])) / 86400000 + 1 - sorted.length;
      for (const after of afterRows) {
        const before = map.get(after.date) || null;
        const sameExportTime =
          before && Date.parse(before.observedAt) === Date.parse(after.observedAt);
        const category: keyof ReportChangeCounts = !before
          ? 'inserted'
          : changed(before, after)
            ? 'corrected'
            : sameExportTime
              ? 'unchanged'
              : 'refreshed';
        if (before && Date.parse(before.observedAt) > Date.parse(after.observedAt))
          errors.push(
            `${c.name} · ${target?.label || 'campaign'} · ${after.date}: a newer export is already stored.`,
          );
        if (before && sameExportTime && changed(before, after))
          errors.push(
            `${c.name} · ${target?.label || 'campaign'} · ${after.date}: conflicting numbers share the same export timestamp. Use the actual revised export time.`,
          );
        counts[category]++;
        local[category]++;
        rowCount++;
        spend += after.spendCents;
        dates.push(after.date);
        if (!target) deltaSpend += after.spendCents - (before?.spendCents || 0);
        if (category !== 'unchanged')
          revisions.push({
            campaignId: c.id,
            targetId: target?.id || null,
            label: target?.label || c.name,
            date: after.date,
            before,
            after,
          });
      }
    }
    if (group.rows.length) compare(group.rows, beforeParent, null);
    for (const entry of group.targets) {
      const old = beforeTargets.find((t) => t.target.id === entry.target.id);
      if (old && hash(old.target) !== hash(entry.target))
        errors.push(
          `${c.name}: ${entry.target.sourceId} has a different saved definition. Use a versioned reporting ID.`,
        );
      compare(entry.rows, old?.rows || [], entry.target);
    }
    const merge = (prior: Observation[], next: Observation[]) =>
      [...new Map([...prior, ...next].map((r) => [r.date, r])).values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      );
    const mergedTargets = new Map(beforeTargets.map((t) => [t.target.id, t]));
    for (const entry of group.targets)
      mergedTargets.set(entry.target.id, {
        target: entry.target,
        rows: merge(mergedTargets.get(entry.target.id)?.rows || [], entry.rows),
      });
    if (targetsExceedCampaign([...mergedTargets.values()], merge(beforeParent, group.rows)))
      warnings.push(
        `${c.name}: campaign and target totals need reconciliation after this report. Target signals and test conclusions remain gated until compatible reports arrive.`,
      );
    if (missingDays > 0)
      warnings.push(
        `${c.name}: ${missingDays} internal daily gaps across the supplied reporting cells. No zero rows will be invented.`,
      );
    targetCount += group.targets.length;
    totalSpend += spend;
    campaigns.push({
      campaignId: c.id,
      name: c.name,
      rowCount,
      targetCount: group.targets.length,
      counts: local,
      missingDays,
      spendCents: spend,
    });
  }
  const omitted = source.mappings.length - payload.groups.length;
  if (omitted)
    warnings.push(
      `${omitted} mapped campaigns are absent. Their stored observations will be retained; this is not a complete account snapshot.`,
    );
  const waves = store.records<TestWave>(source.dataset, 'wave', 200);
  const affectedLearningIds = store
    .records<Learning>(source.dataset, 'learning', 4000)
    .filter((l) => {
      const wave = waves.find((w) => w.id === l.waveId);
      return (
        wave &&
        revisions.some(
          (r) =>
            r.campaignId === wave.campaignId &&
            r.date >= wave.startDate &&
            r.date <= wave.endDate &&
            (r.targetId === null || wave.arms.some((a) => a.target.id === r.targetId)) &&
            changed(r.before, r.after),
        )
      );
    })
    .map((l) => l.id);
  const uniqueErrors = [...new Set(errors)];
  return {
    effective,
    preview: {
      fingerprint: hash({ source: source.contractId, payload, currentState }),
      counts,
      rows: campaigns.reduce((n, c) => n + c.rowCount, 0),
      campaignCount: campaigns.length,
      targetCount,
      spendCents: totalSpend,
      campaignSpendDeltaCents: source.profile === 'orbit-targets' ? null : deltaSpend,
      startDate: dates.sort()[0],
      endDate: dates.at(-1)!,
      errors: uniqueErrors.slice(0, 100),
      warnings: [...new Set(warnings)].slice(0, 100),
      affectedLearningIds,
      campaigns,
    },
    revisions,
  };
}

function receiptRow(
  store: Store,
  dataset: string,
  id: string,
): { receipt: ReportReceipt; payload: Payload } {
  const row = store.db
    .prepare('SELECT body,payload FROM report_batches WHERE dataset=? AND id=?')
    .get(dataset, id) as { body: string; payload: string } | undefined;
  if (!row) throw new AppError('Report batch not found in this workspace.', 404);
  return { receipt: JSON.parse(row.body), payload: JSON.parse(row.payload) };
}
export function reportReceipt(store: Store, dataset: string, id: string): ReportReceipt {
  return receiptRow(store, dataset, id).receipt;
}
export function reportReceipts(store: Store, dataset: string): ReportReceipt[] {
  return (
    store.db
      .prepare('SELECT body FROM report_batches WHERE dataset=? ORDER BY created_at DESC LIMIT 500')
      .all(dataset) as { body: string }[]
  ).map((r) => JSON.parse(r.body));
}
function saveReceipt(store: Store, receipt: ReportReceipt) {
  store.db
    .prepare('UPDATE report_batches SET body=? WHERE id=?')
    .run(JSON.stringify(receipt), receipt.id);
}

export function stageBatch(
  store: Store,
  input: z.infer<typeof batchInput>,
  now = new Date(),
): ReportReceipt {
  input = { ...input, exportedAt: new Date(input.exportedAt).toISOString() };
  const source = reportSource(store, input.dataset, input.sourceId);
  const contentHash = hash(input.csv.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n'));
  const dedupeKey = hash({
    contract: source.contractId,
    source: source.id,
    contentHash,
    exportedAt: input.exportedAt,
  });
  const old = store.db
    .prepare('SELECT body FROM report_batches WHERE dedupe_key=?')
    .get(dedupeKey) as { body: string } | undefined;
  if (old) return JSON.parse(old.body);
  if (reportReceipts(store, input.dataset).length >= 500)
    throw new AppError('This local workspace has reached 500 report batches.');
  const payload = normalizeBatch(store, source, input, now);
  const receipt: ReportReceipt = {
    id: randomUUID(),
    dataset: input.dataset,
    sourceId: source.id,
    sourceName: source.name,
    fileName: input.fileName,
    exportedAt: input.exportedAt,
    createdAt: now.toISOString(),
    contentHash,
    sourceContractId: source.contractId,
    status: 'staged',
    preview: checkPreview(store, source, payload, input.exportedAt).preview,
  };
  store.db
    .prepare(
      'INSERT INTO report_batches(id,dataset,source_id,dedupe_key,created_at,body,payload) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      receipt.id,
      receipt.dataset,
      source.id,
      dedupeKey,
      receipt.createdAt,
      JSON.stringify(receipt),
      JSON.stringify(payload),
    );
  store.activity(
    input.dataset,
    'import',
    'Report preview staged',
    `${input.fileName}: ${receipt.preview.rows} rows across ${receipt.preview.campaignCount} campaigns. Performance data has not changed.`,
  );
  return receipt;
}
export function refreshPreview(store: Store, dataset: string, id: string): ReportReceipt {
  const { receipt, payload } = receiptRow(store, dataset, id);
  if (receipt.status !== 'staged') return receipt;
  receipt.preview = checkPreview(
    store,
    reportSource(store, dataset, receipt.sourceId),
    payload,
    receipt.exportedAt,
  ).preview;
  saveReceipt(store, receipt);
  return receipt;
}
export function commitBatch(
  store: Store,
  dataset: string,
  id: string,
  fingerprint: string,
): ReportReceipt {
  // Caller holds BEGIN IMMEDIATE. Recompute against current data immediately before applying.
  const { receipt, payload } = receiptRow(store, dataset, id);
  if (receipt.status === 'committed') return receipt;
  if (receipt.status !== 'staged')
    throw new AppError('This batch was discarded. Stage a fresh export instead.');
  const source = reportSource(store, dataset, receipt.sourceId);
  const { preview, revisions, effective } = checkPreview(
    store,
    source,
    payload,
    receipt.exportedAt,
  );
  if (preview.fingerprint !== fingerprint || receipt.preview.fingerprint !== fingerprint)
    throw new AppError(
      'Stored evidence changed after this preview. Refresh the preview and review the current differences.',
      409,
    );
  if (preview.errors.length)
    throw new AppError('This batch has blocking conflicts. Resolve them before applying any rows.');
  for (const group of effective.groups) {
    if (group.rows.length) store.importRows(group.rows);
    if (group.targets.length) store.importTargets(group.targets);
    const c = store.campaign(dataset as 'workspace', group.campaignId);
    if (group.rows.length && c.status === 'draft')
      store.saveCampaign({ ...c, status: 'observing' });
  }
  const insert = store.db.prepare(
    'INSERT INTO report_revisions(batch_id,position,body) VALUES(?,?,?)',
  );
  revisions.forEach((revision, i) => insert.run(id, i, JSON.stringify(revision)));
  const applied: ReportReceipt = {
    ...receipt,
    preview,
    status: 'committed',
    committedAt: new Date().toISOString(),
  };
  saveReceipt(store, applied);
  store.activity(
    receipt.dataset,
    'import',
    'Report batch applied',
    `${source.name}: ${preview.counts.inserted} new, ${preview.counts.corrected} corrected, ${preview.counts.refreshed} refreshed, ${preview.counts.unchanged} unchanged rows across ${preview.campaignCount} campaigns. ${preview.affectedLearningIds.length} recorded findings may need review.`,
  );
  return applied;
}
export function discardBatch(store: Store, dataset: string, id: string): ReportReceipt {
  const receipt = reportReceipt(store, dataset, id);
  if (receipt.status === 'committed')
    throw new AppError(
      'Applied reports are immutable receipts. Stage a corrected export to revise the observations.',
    );
  if (receipt.status !== 'discarded') {
    receipt.status = 'discarded';
    saveReceipt(store, receipt);
    store.activity(
      receipt.dataset,
      'import',
      'Report preview discarded',
      `${receipt.fileName}. No observations were changed.`,
    );
  }
  return receipt;
}
export function batchRevisions(store: Store, dataset: string, id: string, offset: number) {
  const { receipt, payload } = receiptRow(store, dataset, id);
  if (receipt.status === 'staged') {
    const { preview, revisions } = checkPreview(
      store,
      reportSource(store, dataset, receipt.sourceId),
      payload,
      receipt.exportedAt,
    );
    if (preview.fingerprint !== receipt.preview.fingerprint)
      throw new AppError(
        'Stored evidence changed. Refresh the preview to inspect the current row differences.',
        409,
      );
    return { total: revisions.length, offset, revisions: revisions.slice(offset, offset + 25) };
  }
  const total = (
    store.db.prepare('SELECT COUNT(*) AS total FROM report_revisions WHERE batch_id=?').get(id) as {
      total: number;
    }
  ).total;
  const rows = store.db
    .prepare(
      'SELECT body FROM report_revisions WHERE batch_id=? ORDER BY position LIMIT 25 OFFSET ?',
    )
    .all(id, offset) as { body: string }[];
  return { total, offset, revisions: rows.map((r): ReportRevision => JSON.parse(r.body)) };
}
