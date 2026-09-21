import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { seedDemo } from '../server/seed.js';
import { dayAt } from '../server/engine.js';
import { parseTargetImport, targetHeaders, targetsExceedCampaign } from '../server/targets.js';
import type { Campaign } from '../shared/types.js';

let store: Store;
let app: ReturnType<typeof createApp>;
const now = new Date();
const c: Campaign = {
  id: 'target-book',
  dataset: 'workspace',
  name: 'Target book',
  entityName: 'Synthetic title',
  accountName: 'Synthetic client',
  vertical: 'books',
  channel: 'amazon',
  status: 'observing',
  currency: 'USD',
  retailPriceCents: 2000,
  netReceiptCents: 1000,
  variableCostCents: 400,
  targetProfitCents: 100,
  dailyBudgetCents: 3000,
  totalLearningBudgetCents: 500000,
  attributionDays: 14,
  economicsVerified: true,
  trackingVerified: true,
  supplyReady: true,
  createdAt: now.toISOString(),
};
const csv = `${targetHeaders.join(',')}\n${dayAt(now, -1)},kw-1,nature writing,keyword,broad,1000,100,10,2000,20000,0`;
function input(report = csv) {
  return {
    dataset: 'workspace' as const,
    campaignId: c.id,
    format: 'targets' as const,
    attributionDays: 14,
    timezone: 'UTC' as const,
    currency: 'USD' as const,
    exportedAt: now.toISOString(),
    csv: report,
  };
}
beforeEach(() => {
  store = new Store(':memory:');
  app = createApp(store);
  store.saveCampaign(c);
});
afterEach(() => store.close());

describe('target measurement boundaries', () => {
  it('stores target reports without double counting them as campaign activity', async () => {
    for (let i = 0; i < 2; i++)
      await request(app)
        .post('/api/target-imports')
        .set('X-Orbit-Request', '1')
        .send(input())
        .expect(201);
    const d = await request(app).get('/api/dashboard?dataset=workspace').expect(200);
    expect(d.body.targets).toHaveLength(1);
    expect(d.body.targets[0].metrics.spendCents).toBe(2000);
    expect(d.body.summary.spendCents).toBe(0);
    expect(d.body.targets[0].signal.kind).toBe('repair');
    expect(store.targetRows(store.targets(c.id)[0].id)).toHaveLength(1);
  });
  it('rejects redefining an existing target and preserves its old observations', async () => {
    await request(app)
      .post('/api/target-imports')
      .set('X-Orbit-Request', '1')
      .send(input())
      .expect(201);
    await request(app)
      .post('/api/target-imports')
      .set('X-Orbit-Request', '1')
      .send(input(csv.replace('nature writing', 'unrelated words')))
      .expect(400);
    expect(store.targets(c.id)[0].label).toBe('nature writing');
  });
  it('rejects mismatched kind/match type and duplicate target/date observations', () => {
    expect(() =>
      parseTargetImport(input(csv.replace('keyword,broad', 'creative,creative')), c, now),
    ).toThrow();
    expect(() =>
      parseTargetImport(input(csv.replace('keyword,broad', 'keyword,product')), c, now),
    ).toThrow();
    expect(() => parseTargetImport(input(`${csv}\n${csv.split('\n')[1]}`), c, now)).toThrow(
      /duplicate/,
    );
  });
  it('detects overcounting or missing parent rows without erasing source reports', () => {
    const entries = parseTargetImport(input(), c, now);
    const parent = { ...entries[0].rows[0], spendCents: 5000 };
    expect(targetsExceedCampaign(entries, [parent])).toBe(false);
    expect(targetsExceedCampaign([...entries, ...entries], [parent])).toBe(true);
    expect(targetsExceedCampaign(entries, [])).toBe(true);
  });
  it('seeds a distinct measured library and retains source provenance in a new test', async () => {
    seedDemo(store);
    const d = await request(app).get('/api/dashboard').expect(200);
    expect(d.body.targets).toHaveLength(18);
    const target = d.body.targets.find((t: { kind: string }) => t.kind === 'keyword');
    const proposal = {
      dataset: 'demo',
      campaignId: target.campaignId,
      sourceTargetId: target.id,
      name: 'Confirm observed keyword',
      hypothesis: 'This keyword may support positive contribution in a controlled exact test.',
      variable: 'keyword',
      seedTerms: [target.label],
      count: 12,
      maxConcurrent: 2,
      budgetCents: 5000,
      provider: 'structured-planner',
    };
    const result = await request(app)
      .post('/api/experiments')
      .set('X-Orbit-Request', '1')
      .send(proposal)
      .expect(201);
    expect(result.body.sourceTargetId).toBe(target.id);
    await request(app)
      .post('/api/experiments')
      .set('X-Orbit-Request', '1')
      .send({ ...proposal, sourceTargetId: '0'.repeat(64) })
      .expect(400);
  });
});
