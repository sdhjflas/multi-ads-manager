import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { z } from 'zod';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { dayAt } from '../server/engine.js';
import { commitBatch, sourceInput } from '../server/reports.js';
import { targetKey } from '../server/targets.js';
import {
  evaluateWave,
  getLearningViews,
  recordLearning,
  registerWave,
  waveInput,
} from '../server/waves.js';
import type {
  Campaign,
  Experiment,
  Observation,
  ReportReceipt,
  ReportSource,
} from '../shared/types.js';

let store: Store;
let app: ReturnType<typeof createApp>;
const now = new Date();
const exportedAt = now.toISOString();
const earlier = new Date(now.getTime() - 3600000).toISOString();
const later = new Date(now.getTime() + 1000).toISOString();
const day = dayAt(now, -3);
const base: Campaign = {
  id: 'book-a',
  dataset: 'workspace',
  name: 'Local book A',
  entityName: 'Synthetic paperback',
  accountName: 'Fixture publisher',
  vertical: 'books',
  channel: 'amazon',
  status: 'draft',
  currency: 'USD',
  retailPriceCents: 2000,
  netReceiptCents: 1000,
  variableCostCents: 400,
  targetProfitCents: 100,
  dailyBudgetCents: 10000,
  totalLearningBudgetCents: 5000000,
  attributionDays: 14,
  economicsVerified: true,
  trackingVerified: true,
  supplyReady: true,
  createdAt: exportedAt,
};
const scope = { dataset: 'workspace' };
const header =
  'account_id,campaign_id,date,impressions,clicks,orders,spend_cents,sales_cents,refunds_cents';
const targetHeader =
  'account_id,campaign_id,date,target_id,target,kind,match_type,impressions,clicks,orders,spend_cents,sales_cents,refunds_cents';
const csv = (spend = 200) =>
  `${header}\nbooks,ext-a,${day},1000,100,5,${spend},10000,0\nbooks,ext-b,${day},2000,200,10,400,20000,0`;
const targetCsv = (label = 'Reader intent') =>
  `${targetHeader}\nbooks,ext-a,${day},kw-a,${label},keyword,exact,100,10,1,100,2000,0`;
function observation(campaignId = base.id, values: Partial<Observation> = {}): Observation {
  return {
    campaignId,
    date: day,
    impressions: 1000,
    clicks: 100,
    orders: 5,
    spendCents: 200,
    salesCents: 10000,
    refundsCents: 0,
    observedAt: earlier,
    ...values,
  };
}
function sourceBody(
  overrides: Partial<z.infer<typeof sourceInput>> = {},
): z.infer<typeof sourceInput> {
  return {
    dataset: 'workspace',
    name: 'Publisher reports',
    provider: 'amazon',
    accountRef: 'books',
    profile: 'orbit-campaigns',
    currency: 'USD',
    timezone: 'UTC',
    attributionDays: 14,
    contractVerified: true,
    mappings: [
      { externalCampaignId: 'ext-a', campaignId: 'book-a' },
      { externalCampaignId: 'ext-b', campaignId: 'book-b' },
    ],
    ...overrides,
  };
}
const post = (url: string, body: unknown) =>
  request(app).post(url).set('X-Orbit-Request', '1').send(body);
async function source(overrides: Partial<z.infer<typeof sourceInput>> = {}): Promise<ReportSource> {
  return (await post('/api/reporting/sources', sourceBody(overrides)).expect(201)).body;
}
function batchBody(s: ReportSource, report = csv(), time = exportedAt) {
  return {
    ...scope,
    sourceId: s.id,
    fileName: 'portfolio.csv',
    exportedAt: time,
    csv: report,
    exportVerified: true,
  };
}
async function stage(s: ReportSource, report = csv(), time = exportedAt): Promise<ReportReceipt> {
  return (await post('/api/reporting/batches', batchBody(s, report, time)).expect(201)).body;
}
async function apply(b: ReportReceipt): Promise<ReportReceipt> {
  return (
    await post(`/api/reporting/batches/${b.id}/commit`, {
      ...scope,
      fingerprint: b.preview.fingerprint,
    }).expect(200)
  ).body;
}
beforeEach(() => {
  store = new Store(':memory:');
  app = createApp(store);
  store.saveCampaign(base);
  store.saveCampaign({ ...base, id: 'book-b', name: 'Local book B' });
  for (const id of ['product-a', 'product-b'])
    store.saveCampaign({
      ...base,
      id,
      name: id,
      vertical: 'commerce',
      channel: 'meta',
      attributionDays: 7,
    });
});
afterEach(() => store.close());

describe('saved reporting contracts', () => {
  it('freezes campaign identity once a source is mapped, even before its first import', async () => {
    await source();
    const { id: _id, status: _status, createdAt: _created, currency: _currency, ...setup } = base;
    await request(app)
      .patch(`/api/campaigns/${base.id}/setup`)
      .set('X-Orbit-Request', '1')
      .send({ ...setup, attributionDays: 7 })
      .expect(400);
    await request(app)
      .patch(`/api/campaigns/${base.id}/setup`)
      .set('X-Orbit-Request', '1')
      .send({ ...setup, netReceiptCents: 1100 })
      .expect(200);
  });
  it('requires explicit definitions and rejects mixed platform, window, account, and workspace scopes', async () => {
    for (const overrides of [
      { provider: 'meta' },
      { attributionDays: 7 },
      { currency: 'EUR' },
      { timezone: 'America/New_York' },
      { contractVerified: false },
      { dataset: 'demo' },
    ])
      await post('/api/reporting/sources', { ...sourceBody(), ...overrides }).expect(400);
    const s = await source();
    await post(
      '/api/reporting/sources',
      sourceBody({ profile: 'orbit-targets', accountRef: 'another-account' }),
    ).expect(400);
    await request(app).get(`/api/reporting/sources/${s.id}/template?dataset=demo`).expect(404);
    expect((await request(app).get('/api/reporting?dataset=demo')).body).toEqual({
      sources: [],
      batches: [],
    });
    const template = await request(app)
      .get(`/api/reporting/sources/${s.id}/template?dataset=workspace`)
      .expect(200);
    expect(template.text.trim()).toBe(header);
  });
  it('prevents two local campaigns representing the same external campaign and keeps both grains aligned', async () => {
    await source({ mappings: [{ campaignId: 'book-a', externalCampaignId: 'ext-a' }] });
    await post(
      '/api/reporting/sources',
      sourceBody({ mappings: [{ campaignId: 'book-b', externalCampaignId: 'ext-a' }] }),
    ).expect(400);
    await post(
      '/api/reporting/sources',
      sourceBody({
        profile: 'orbit-targets',
        mappings: [{ campaignId: 'book-a', externalCampaignId: 'wrong-id' }],
      }),
    ).expect(400);
    await source({
      profile: 'orbit-targets',
      mappings: [{ campaignId: 'book-a', externalCampaignId: 'ext-a' }],
    });
    await post('/api/reporting/sources', sourceBody()).expect(400);
    await post(
      '/api/reporting/sources',
      sourceBody({
        mappings: [
          { campaignId: 'book-b', externalCampaignId: 'x' },
          { campaignId: 'book-b', externalCampaignId: 'y' },
        ],
      }),
    ).expect(400);
  });
  it('removes only unused sources and retains discarded batch history', async () => {
    const unused = await source();
    await request(app)
      .delete(`/api/reporting/sources/${unused.id}`)
      .set('X-Orbit-Request', '1')
      .send(scope)
      .expect(200);
    const s = await source();
    const b = await stage(s);
    await post(`/api/reporting/batches/${b.id}/discard`, scope).expect(200);
    await request(app)
      .delete(`/api/reporting/sources/${s.id}`)
      .set('X-Orbit-Request', '1')
      .send(scope)
      .expect(400);
    expect((await stage(s)).status).toBe('discarded');
    await post(`/api/reporting/batches/${b.id}/commit`, {
      ...scope,
      fingerprint: b.preview.fingerprint,
    }).expect(400);
    expect(store.observations(base.id)).toEqual([]);
  });
});

describe('reviewed atomic batch ingestion', () => {
  it('treats equivalent timestamp spellings as one export instant', async () => {
    const s = await source();
    const seconds = exportedAt.replace(/\.\d{3}Z$/, 'Z');
    store.importRows([observation(base.id, { observedAt: seconds, spendCents: 999 })]);
    const b = await stage(s, csv(), new Date(seconds).toISOString());
    expect(b.preview.errors.join(' ')).toMatch(/same export timestamp/);
    expect((await stage(s, csv(), seconds)).id).toBe(b.id);
  });
  it('previews multiple campaigns without changing observations and applies them exactly once', async () => {
    const s = await source(),
      b = await stage(s);
    expect(b.preview).toMatchObject({
      rows: 2,
      campaignCount: 2,
      campaignSpendDeltaCents: 600,
      counts: { inserted: 2, corrected: 0, refreshed: 0, unchanged: 0 },
    });
    expect(store.observations(base.id)).toEqual([]);
    const proposed = (
      await request(app)
        .get(`/api/reporting/batches/${b.id}/revisions?dataset=workspace`)
        .expect(200)
    ).body;
    expect(proposed.revisions[0]).toMatchObject({ before: null, after: { spendCents: 200 } });
    const committed = await apply(b);
    expect(committed.status).toBe('committed');
    expect(store.campaign('workspace', base.id).status).toBe('observing');
    const activity = store.records('workspace', 'activity').length;
    expect((await apply(b)).id).toBe(committed.id);
    expect((await stage(s, '\uFEFF' + csv().replaceAll('\n', '\r\n'))).id).toBe(b.id);
    expect(store.records('workspace', 'activity')).toHaveLength(activity);
    expect(
      (await request(app).get('/api/dashboard?dataset=workspace')).body.summary.spendCents,
    ).toBe(600);
    expect(
      (await request(app).get(`/api/reporting/batches/${b.id}/revisions?dataset=workspace`)).body
        .total,
    ).toBe(2);
  });
  it('retains before/after corrections, records freshness updates, and does not duplicate unchanged revisions', async () => {
    const s = await source();
    await apply(await stage(s, csv(), earlier));
    const b = await stage(s, csv(250));
    expect(b.preview.counts).toEqual({ inserted: 0, corrected: 1, refreshed: 1, unchanged: 0 });
    expect(b.preview.campaignSpendDeltaCents).toBe(50);
    await apply(b);
    const history = (
      await request(app).get(`/api/reporting/batches/${b.id}/revisions?dataset=workspace`)
    ).body;
    expect(history.revisions[0]).toMatchObject({
      before: { spendCents: 200, observedAt: earlier },
      after: { spendCents: 250, observedAt: exportedAt },
    });
    const unchanged = await stage(s, csv(250) + '\n');
    expect(unchanged.preview.counts.unchanged).toBe(2);
    await apply(unchanged);
    expect(
      (await request(app).get(`/api/reporting/batches/${unchanged.id}/revisions?dataset=workspace`))
        .body.total,
    ).toBe(0);
    await post(`/api/reporting/batches/${b.id}/discard`, scope).expect(400);
    await request(app).get(`/api/reporting/batches/${b.id}?dataset=demo`).expect(404);
    await request(app).get(`/api/reporting/batches/${b.id}/revisions?dataset=demo`).expect(404);
    await post(`/api/reporting/batches/${b.id}/commit`, {
      dataset: 'demo',
      fingerprint: b.preview.fingerprint,
    }).expect(404);
  });
  it('requires a refreshed preview after another import changes the underlying data', async () => {
    const s = await source();
    const b = await stage(s);
    store.importRows([observation(base.id, { spendCents: 100 })]);
    await post(`/api/reporting/batches/${b.id}/commit`, {
      ...scope,
      fingerprint: b.preview.fingerprint,
    }).expect(409);
    await request(app)
      .get(`/api/reporting/batches/${b.id}/revisions?dataset=workspace`)
      .expect(409);
    expect(store.observations('book-b')).toEqual([]);
    const refreshed = (await post(`/api/reporting/batches/${b.id}/refresh`, scope).expect(200))
      .body as ReportReceipt;
    expect(refreshed.preview.fingerprint).not.toBe(b.preview.fingerprint);
    expect(refreshed.preview.campaignSpendDeltaCents).toBe(500);
    await apply(refreshed);
    expect(store.observations(base.id)[0].spendCents).toBe(200);
  });
  it('blocks an entire batch when any row is older or conflicts at the same export timestamp', async () => {
    const s = await source();
    store.importRows([observation('book-b', { observedAt: exportedAt, spendCents: 999 })]);
    for (const time of [earlier, exportedAt]) {
      const b = await stage(s, csv(), time);
      expect(b.preview.errors.join(' ')).toMatch(/newer export|same export timestamp/);
      await post(`/api/reporting/batches/${b.id}/commit`, {
        ...scope,
        fingerprint: b.preview.fingerprint,
      }).expect(400);
    }
    expect(store.observations(base.id)).toEqual([]);
    expect(store.observations('book-b')[0].spendCents).toBe(999);
  });
  it('rolls back earlier rows and audit writes when a later write fails inside the transaction', async () => {
    const b = await stage(await source());
    store.db.exec(
      "CREATE TRIGGER simulated_failure BEFORE INSERT ON observations WHEN NEW.campaign_id='book-b' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;",
    );
    expect(() =>
      store.transaction(() => commitBatch(store, 'workspace', b.id, b.preview.fingerprint)),
    ).toThrow(/simulated storage failure/);
    expect(store.observations(base.id)).toEqual([]);
    expect(store.campaign('workspace', base.id).status).toBe('draft');
    expect(
      (await request(app).get(`/api/reporting/batches/${b.id}?dataset=workspace`)).body.status,
    ).toBe('staged');
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM report_revisions WHERE batch_id=?').get(b.id),
    ).toMatchObject({ count: 0 });
  });
  it('preserves absent campaigns and date gaps without fabricating zero delivery', async () => {
    const s = await source();
    store.importRows([observation('book-b', { spendCents: 700 })]);
    const report = `${header}\nbooks,ext-a,${dayAt(now, -5)},100,10,1,100,2000,0\nbooks,ext-a,${day},100,10,1,100,2000,0`;
    const b = await stage(s, report);
    expect(b.preview.campaigns[0].missingDays).toBe(1);
    expect(b.preview.warnings.join(' ')).toMatch(/1 mapped campaigns are absent/);
    await apply(b);
    expect(store.observations(base.id).map((r) => r.date)).toEqual([dayAt(now, -5), day]);
    expect(store.observations('book-b')[0].spendCents).toBe(700);
  });
  it('paginates persistent revision history without crossing batch boundaries', async () => {
    const report = [
      header,
      ...Array.from(
        { length: 30 },
        (_, i) => `books,ext-a,${dayAt(now, -3 - i)},100,10,1,100,2000,0`,
      ),
    ].join('\n');
    const b = await stage(await source(), report);
    await apply(b);
    const first = (
      await request(app).get(`/api/reporting/batches/${b.id}/revisions?dataset=workspace`)
    ).body;
    const last = (
      await request(app).get(`/api/reporting/batches/${b.id}/revisions?dataset=workspace&offset=25`)
    ).body;
    expect(first.total).toBe(30);
    expect(first.revisions).toHaveLength(25);
    expect(last.revisions).toHaveLength(5);
    expect(
      new Set([...first.revisions, ...last.revisions].map((r: { date: string }) => r.date)).size,
    ).toBe(30);
    await request(app)
      .get(`/api/reporting/batches/${b.id}/revisions?dataset=workspace&offset=-1`)
      .expect(400);
  });
});

describe('provider profiles and reporting grain', () => {
  it('also preserves publisher refunds through the single-campaign console importer', async () => {
    store.importRows([observation(base.id, { refundsCents: 450 })]);
    await post('/api/imports', {
      ...scope,
      campaignId: base.id,
      format: 'amazon',
      attributionDays: 14,
      currency: 'USD',
      timezone: 'UTC',
      exportedAt,
      csv: `Date,Campaign Name,Impressions,Clicks,Spend,14 Day Total Orders (#),14 Day Total Sales\n${day},${base.name},1000,100,3.00,5,100.00`,
    }).expect(201);
    expect(store.observations(base.id)[0]).toMatchObject({ refundsCents: 450, spendCents: 300 });
  });
  it('imports multiple Amazon console names explicitly and carries forward publisher refund corrections', async () => {
    const s = await source({
      profile: 'amazon-campaigns',
      mappings: [
        { campaignId: 'book-a', externalCampaignId: 'Console title A' },
        { campaignId: 'book-b', externalCampaignId: 'Console title B' },
      ],
    });
    const native = `Date,Campaign Name,Impressions,Clicks,Spend,14 Day Total Orders (#),14 Day Total Sales\n${day},Console title A,1000,100,2.00,5,100.00\n${day},Console title B,2000,200,4.00,10,200.00`;
    store.importRows([observation(base.id, { refundsCents: 150 })]);
    const b = await stage(s, native);
    expect(b.preview.warnings.join(' ')).toMatch(/refund corrections are carried forward/);
    store.importRows([observation(base.id, { refundsCents: 250 })]);
    await post(`/api/reporting/batches/${b.id}/commit`, {
      ...scope,
      fingerprint: b.preview.fingerprint,
    }).expect(409);
    const refreshed = (await post(`/api/reporting/batches/${b.id}/refresh`, scope)).body;
    await apply(refreshed);
    expect(store.observations(base.id)[0]).toMatchObject({ spendCents: 200, refundsCents: 250 });
    const revisions = (
      await request(app).get(`/api/reporting/batches/${b.id}/revisions?dataset=workspace`)
    ).body.revisions;
    expect(revisions[0].after.refundsCents).toBe(250);
    expect(store.observations('book-b')).toHaveLength(1);
  });
  it('retains cost on zero-click product days in contribution calculations', async () => {
    const s = await source({
      provider: 'meta',
      accountRef: 'products',
      attributionDays: 7,
      mappings: [{ campaignId: 'product-a', externalCampaignId: 'ad-campaign-a' }],
    });
    const report = `${header}\nproducts,ad-campaign-a,${day},1000,0,0,750,0,0`;
    await apply(await stage(s, report));
    const dashboard = (await request(app).get('/api/dashboard?dataset=workspace')).body;
    expect(dashboard.summary).toMatchObject({ spendCents: 750, contributionCents: -750 });
    await post(
      '/api/reporting/batches',
      batchBody(s, report.replace(',0,0,750', ',0,1,750'), later),
    ).expect(400);
  });
  it('imports product creative cells without adding their spend to portfolio totals', async () => {
    const options = {
      provider: 'meta' as const,
      accountRef: 'products',
      attributionDays: 7,
      mappings: [{ campaignId: 'product-a', externalCampaignId: 'ad-campaign-a' }],
    };
    await apply(
      await stage(
        await source(options),
        `${header}\nproducts,ad-campaign-a,${day},1000,100,5,500,10000,0`,
      ),
    );
    const targets = await source({ ...options, profile: 'orbit-targets' });
    const report = `${targetHeader}\nproducts,ad-campaign-a,${day},creative-v1,First hook,creative,creative,500,50,3,300,6000,0`;
    const b = await stage(targets, report);
    expect(b.preview.campaignSpendDeltaCents).toBeNull();
    expect(b.preview.targetCount).toBe(1);
    await apply(b);
    const dashboard = (await request(app).get('/api/dashboard?dataset=workspace')).body;
    expect(dashboard.summary.spendCents).toBe(500);
    expect(dashboard.targets[0].metrics.spendCents).toBe(300);
    expect(dashboard.targets[0].id).toBe(targetKey('product-a', 'creative-v1'));
  });
  it('blocks target identity reuse across a portfolio batch, and gates unreconciled targets', async () => {
    const s = await source({ profile: 'orbit-targets' });
    const first = await stage(s, targetCsv(), earlier);
    await apply(first);
    expect(first.preview.warnings.join(' ')).toMatch(/need reconciliation/);
    const conflict = await stage(
      s,
      targetCsv('Changed definition') +
        `\nbooks,ext-b,${day},kw-new,New topic,keyword,exact,100,10,1,100,2000,0`,
    );
    expect(conflict.preview.errors.join(' ')).toMatch(/different saved definition/);
    await post(`/api/reporting/batches/${conflict.id}/commit`, {
      ...scope,
      fingerprint: conflict.preview.fingerprint,
    }).expect(400);
    expect(store.targets('book-b')).toEqual([]);
    const dashboard = (await request(app).get('/api/dashboard?dataset=workspace')).body;
    expect(dashboard.targets[0].signal.kind).toBe('repair');
    expect(dashboard.summary.spendCents).toBe(0);
  });
  it('rejects unknown accounts, unmapped campaigns, personal columns, repeated cells, and unverified exports before staging', async () => {
    const s = await source();
    for (const invalid of [
      csv().replace('books,ext-a', 'wrong,ext-a'),
      csv().replace('ext-a', 'unknown'),
      csv().replace('account_id,', 'email,'),
      csv() + `\nbooks,ext-a,${day},100,10,1,100,2000,0`,
      csv().replace('refunds_cents', 'extra_column'),
    ])
      await post('/api/reporting/batches', batchBody(s, invalid)).expect(400);
    await post('/api/reporting/batches', { ...batchBody(s), exportVerified: false }).expect(400);
    expect((await request(app).get('/api/reporting?dataset=workspace')).body.batches).toEqual([]);
    expect(store.observations(base.id)).toEqual([]);
  });
});

describe('report corrections and the learning loop', () => {
  it('flags affected findings, preserves the frozen result, and ignores freshness-only updates', async () => {
    const s = await source({
      profile: 'orbit-targets',
      mappings: [{ campaignId: base.id, externalCampaignId: 'ext-a' }],
    });
    const report = [targetHeader];
    for (let i = 0; i < 7; i++) {
      const date = dayAt(now, -30 + i);
      store.importRows([
        observation(base.id, {
          date,
          impressions: 20000,
          clicks: 2000,
          orders: 200,
          spendCents: 20000,
          salesCents: 400000,
        }),
      ]);
      report.push(
        `books,ext-a,${date},kw-baseline,Baseline,keyword,broad,10000,1000,50,10000,100000,0`,
      );
      report.push(
        `books,ext-a,${date},kw-challenger,Challenger,keyword,exact,10000,1000,150,10000,300000,0`,
      );
    }
    await apply(await stage(s, report.join('\n'), earlier));
    const experiment: Experiment = {
      id: 'experiment',
      dataset: 'workspace',
      campaignId: base.id,
      name: 'Reader comparison',
      hypothesis: 'Intent improves contribution.',
      variable: 'keyword',
      budgetCents: 1000000,
      maxConcurrent: 2,
      status: 'draft',
      provider: 'structured-planner',
      createdAt: earlier,
      variants: [
        {
          id: 'variant',
          label: 'Challenger',
          value: 'Challenger',
          variable: 'keyword',
          hypothesis: 'Focused reader intent.',
          state: 'shortlisted',
        },
      ],
    };
    store.putRecord('experiment', experiment);
    const wave = store.transaction(() =>
      registerWave(
        store,
        waveInput.parse({
          dataset: 'workspace',
          experimentId: experiment.id,
          name: 'Fixed test',
          registration: 'retrospective',
          mappingVerified: true,
          startDate: dayAt(now, -30),
          endDate: dayAt(now, -24),
          budgetCents: 500000,
          lossLimitCents: 200000,
          minClicksPerArm: 100,
          minLiftCentsPer100Clicks: 500,
          arms: [
            {
              role: 'baseline',
              variantId: null,
              sourceId: 'kw-baseline',
              label: 'Baseline',
              kind: 'keyword',
              matchType: 'broad',
            },
            {
              role: 'challenger',
              variantId: 'variant',
              sourceId: 'kw-challenger',
              label: 'Challenger',
              kind: 'keyword',
              matchType: 'exact',
            },
          ],
        }),
        now,
      ),
    );
    const finding = store.transaction(() =>
      recordLearning(
        store,
        wave,
        evaluateWave(store, wave).evidenceId,
        'Confirm this promising candidate with independent controlled delivery.',
      ),
    );
    const refreshed = await stage(s, report.join('\n'));
    expect(refreshed.preview.affectedLearningIds).toEqual([]);
    await apply(refreshed);
    expect(getLearningViews(store, 'workspace')[0].evidenceChanged).toBe(false);
    const corrected = await stage(
      s,
      report.join('\n').replace('1000,150,10000,300000', '1000,20,10000,40000'),
      later,
    );
    expect(corrected.preview.affectedLearningIds).toContain(finding.id);
    await apply(corrected);
    expect(getLearningViews(store, 'workspace')[0].evidenceChanged).toBe(true);
    expect(store.record('workspace', 'learning', finding.id)).toEqual(finding);
  });
});
