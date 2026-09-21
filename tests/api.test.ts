import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { dayAt } from '../server/engine.js';
import { seedDemo } from '../server/seed.js';
import { parseImport } from '../server/importer.js';
import { planVariants } from '../server/planner.js';
import type { Campaign } from '../shared/types.js';
import type { z } from 'zod';
import { importInput } from '../server/validation.js';

let store: Store;
let app: ReturnType<typeof createApp>;
const now = new Date();
const setup = {
  dataset: 'workspace',
  name: 'Test book',
  vertical: 'books',
  channel: 'amazon',
  entityName: 'Fictional title',
  accountName: 'Sample client',
  retailPriceCents: 2000,
  netReceiptCents: 1000,
  variableCostCents: 400,
  targetProfitCents: 100,
  dailyBudgetCents: 2000,
  totalLearningBudgetCents: 100000,
  attributionDays: 14,
  economicsVerified: true,
  trackingVerified: true,
  supplyReady: true,
};
const campaign: Campaign = {
  ...setup,
  dataset: 'workspace',
  vertical: 'books',
  channel: 'amazon',
  id: 'test-book',
  status: 'draft',
  currency: 'USD',
  createdAt: now.toISOString(),
};
const header = 'date,impressions,clicks,orders,spend_cents,sales_cents,refunds_cents';
function bundle(
  csv = `${header}\n${dayAt(now, -1)},100,10,1,100,2000,0`,
): z.infer<typeof importInput> {
  return {
    dataset: 'workspace',
    campaignId: 'test-book',
    format: 'canonical',
    attributionDays: 14,
    timezone: 'UTC',
    currency: 'USD',
    exportedAt: now.toISOString(),
    csv,
  };
}
beforeEach(() => {
  store = new Store(':memory:');
  app = createApp(store);
  store.saveCampaign(campaign);
});
afterEach(() => store.close());

describe('report ingestion', () => {
  it('upserts refreshed days without double counting', async () => {
    for (let i = 0; i < 2; i++)
      await request(app)
        .post('/api/imports')
        .set('X-Orbit-Request', '1')
        .send(bundle())
        .expect(201);
    expect(store.observations(campaign.id)).toHaveLength(1);
    const dashboard = await request(app).get('/api/dashboard?dataset=workspace').expect(200);
    expect(dashboard.body.summary.spendCents).toBe(100);
    expect(dashboard.body.comparisonComplete).toBe(false);
    expect(dashboard.body.campaigns[0].status).toBe('observing');
  });
  it('rolls the entire import back when one row would overwrite a newer export', async () => {
    await request(app).post('/api/imports').set('X-Orbit-Request', '1').send(bundle()).expect(201);
    const csv = `${header}\n${dayAt(now, -3)},100,10,1,100,2000,0\n${dayAt(now, -1)},100,10,1,500,2000,0`;
    // An export three hours older can still contain yesterday's complete cohort.
    const older = {
      ...bundle(csv),
      exportedAt: new Date(now.getTime() - 3 * 3600000).toISOString(),
    };
    await request(app).post('/api/imports').set('X-Orbit-Request', '1').send(older).expect(400);
    expect(store.observations(campaign.id)).toHaveLength(1);
    expect(store.observations(campaign.id)[0].spendCents).toBe(100);
  });
  it('rejects duplicate dates, broken dates, negative money, unknown columns, and personal fields', () => {
    const bad = [
      `${header}\n${dayAt(now, -1)},100,10,1,100,2000,0\n${dayAt(now, -1)},100,10,1,100,2000,0`,
      `${header}\n2026-02-30,100,10,1,100,2000,0`,
      `${header}\n${dayAt(now, -1)},100,10,1,-1,2000,0`,
      `${header},unknown\n${dayAt(now, -1)},100,10,1,100,2000,0,x`,
      `${header},customer_email\n${dayAt(now, -1)},100,10,1,100,2000,0,x`,
    ];
    for (const csv of bad) expect(() => parseImport(bundle(csv), campaign, now)).toThrow();
  });
  it('rejects inconsistent click models and changed attribution', () => {
    expect(() =>
      parseImport(bundle(`${header}\n${dayAt(now, -1)},100,1,5,100,2000,0`), campaign, now),
    ).toThrow(/funnel/);
    expect(() => parseImport({ ...bundle(), attributionDays: 7 }, campaign, now)).toThrow(
      /Attribution/,
    );
  });
  it('maps an English Amazon export with exact decimal cents', () => {
    const csv = `Date,Campaign Name,Impressions,Clicks,Spend,14 Day Total Orders (#),14 Day Total Sales\n${dayAt(now, -1)},Test book,1000,30,10.29,2,40.00`;
    const row = parseImport({ ...bundle(csv), format: 'amazon' }, campaign, now)[0];
    expect(row.spendCents).toBe(1029);
    expect(row.salesCents).toBe(4000);
    expect(() =>
      parseImport(
        { ...bundle(csv.replace('Test book', 'Another book')), format: 'amazon' },
        campaign,
        now,
      ),
    ).toThrow(/campaign name/);
  });
});

describe('workspace and action boundaries', () => {
  it('keeps an older demo snapshot usable without weakening real report freshness', async () => {
    const snapshot = new Date(now.getTime() - 30 * 86_400_000);
    seedDemo(store, snapshot);
    store.importRows([
      {
        ...store.observations('demo-atlas').at(-1)!,
        campaignId: campaign.id,
      },
    ]);
    const demo = await request(app).get('/api/dashboard?dataset=demo').expect(200);
    const real = await request(app).get('/api/dashboard?dataset=workspace').expect(200);
    expect(demo.body.reportingAt).toBe(snapshot.toISOString());
    expect(demo.body.comparisonComplete).toBe(true);
    expect(
      demo.body.campaigns.some((c: { decision: { kind: string } }) => c.decision.kind === 'scale'),
    ).toBe(true);
    expect(real.body.reportingAt.slice(0, 10)).toBe(dayAt(now));
    expect(real.body.campaigns[0].decision.blockers.join(' ')).toMatch(/48 hours/);
    const analysis = await request(app)
      .post('/api/analysis')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'demo' })
      .expect(200);
    const first = demo.body.campaigns[0];
    expect(analysis.body.decisions[0].evidenceId).toBe(first.decision.evidenceId);
    await request(app)
      .post('/api/reviews')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'demo',
        campaignId: first.id,
        evidenceId: first.decision.evidenceId,
        action: 'accepted',
      })
      .expect(200);
    const exported = await request(app).get('/api/export?dataset=demo').expect(200);
    expect(exported.text).toContain(String(first.metrics.spendCents));
  });
  it('isolates demo and workspace and refuses importing business data into demo', async () => {
    seedDemo(store);
    const demo = await request(app).get('/api/dashboard?dataset=demo').expect(200);
    const real = await request(app).get('/api/dashboard?dataset=workspace').expect(200);
    expect(demo.body.campaigns).toHaveLength(6);
    expect(real.body.campaigns).toHaveLength(1);
    await request(app)
      .post('/api/imports')
      .set('X-Orbit-Request', '1')
      .send({ ...bundle(), dataset: 'demo', campaignId: 'demo-atlas' })
      .expect(400);
    await request(app)
      .patch('/api/campaigns/demo-atlas/status')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', status: 'paused' })
      .expect(404);
  });
  it('rejects unauthenticated cross-origin local mutations and rebinding hosts', async () => {
    await request(app).post('/api/campaigns').send(setup).expect(403);
    await request(app)
      .post('/api/campaigns')
      .set('X-Orbit-Request', '1')
      .set('Origin', 'https://example.com')
      .send(setup)
      .expect(403);
    await request(app).get('/api/dashboard').set('Host', 'attacker.example').expect(403);
    const health = await request(app).get('/api/health').expect(200);
    expect(health.body.platformWritesEnabled).toBe(false);
  });
  it('persists draft generation and enforces the wave cap on the server', async () => {
    const input = {
      dataset: 'workspace',
      campaignId: campaign.id,
      name: 'Reader intent',
      hypothesis: 'Relevant topics will improve contribution per click.',
      variable: 'keyword',
      seedTerms: ['nature writing', 'slow living'],
      count: 60,
      maxConcurrent: 2,
      budgetCents: 10000,
      provider: 'structured-planner',
    };
    const result = await request(app)
      .post('/api/experiments')
      .set('X-Orbit-Request', '1')
      .send(input)
      .expect(201);
    expect(result.body.variants).toHaveLength(60);
    expect(new Set(result.body.variants.map((v: { value: string }) => v.value)).size).toBe(60);
    for (let i = 0; i < 2; i++)
      await request(app)
        .patch(`/api/experiments/${result.body.id}/variants/${result.body.variants[i].id}`)
        .set('X-Orbit-Request', '1')
        .send({ dataset: 'workspace', state: 'shortlisted' })
        .expect(200);
    await request(app)
      .patch(`/api/experiments/${result.body.id}/variants/${result.body.variants[2].id}`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', state: 'shortlisted' })
      .expect(400);
    const listed = await request(app).get('/api/dashboard?dataset=workspace').expect(200);
    expect(
      listed.body.experiments[0].variants.filter(
        (v: { state: string }) => v.state === 'shortlisted',
      ),
    ).toHaveLength(2);
  });
  it('never fabricates extra variants when the seed combinations are exhausted', () => {
    const variants = planVariants({
      variable: 'hook',
      count: 300,
      seedTerms: ['details', 'DETAILS'],
      hypothesis: 'One topic only.',
    });
    expect(variants).toHaveLength(12);
  });
  it('rejects stale proposal evidence and records a current review without changing a budget', async () => {
    seedDemo(store);
    const d = await request(app).get('/api/dashboard').expect(200);
    const c = d.body.campaigns[0];
    await request(app)
      .post('/api/reviews')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'demo', campaignId: c.id, evidenceId: '0'.repeat(64), action: 'accepted' })
      .expect(409);
    const accepted = await request(app)
      .post('/api/reviews')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'demo',
        campaignId: c.id,
        evidenceId: c.decision.evidenceId,
        action: 'accepted',
      })
      .expect(200);
    expect(accepted.body.platformMutation).toBe(false);
    expect(store.campaign('demo', c.id).dailyBudgetCents).toBe(c.dailyBudgetCents);
  });
  it('rejects a changed reporting contract after observations exist', async () => {
    await request(app).post('/api/imports').set('X-Orbit-Request', '1').send(bundle()).expect(201);
    await request(app)
      .patch(`/api/campaigns/${campaign.id}/setup`)
      .set('X-Orbit-Request', '1')
      .send({ ...setup, attributionDays: 7 })
      .expect(400);
  });
  it('reserves AI requests transactionally and does not exceed the allowance', () => {
    store.reserveAi(2);
    store.reserveAi(2);
    expect(() => store.reserveAi(2)).toThrow(/allowance/);
    expect(store.aiRequests()).toBe(2);
  });
});
