import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { dayAt, probabilityAbove } from '../server/engine.js';
import {
  betaQuantile,
  evaluateWave,
  getLearningViews,
  recordLearning,
  registerWave,
  waveInput,
} from '../server/waves.js';
import type { WaveInput } from '../server/waves.js';
import { targetKey } from '../server/targets.js';
import type { Campaign, Experiment, Observation, TestWave, Target } from '../shared/types.js';

let store: Store;
let app: ReturnType<typeof createApp>;
const now = new Date();
const c: Campaign = {
  id: 'wave-book',
  dataset: 'workspace',
  name: 'Measured book',
  entityName: 'Synthetic book',
  accountName: 'Fixture publisher',
  vertical: 'books',
  channel: 'amazon',
  status: 'observing',
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
  createdAt: now.toISOString(),
};
const exp: Experiment = {
  id: 'wave-experiment',
  dataset: 'workspace',
  campaignId: c.id,
  name: 'Reader intent',
  hypothesis: 'Focused reader intent may improve contribution per click.',
  variable: 'keyword',
  budgetCents: 2000000,
  maxConcurrent: 2,
  status: 'draft',
  provider: 'structured-planner',
  createdAt: now.toISOString(),
  variants: [1, 2].map((i) => ({
    id: `v-${i}`,
    label: `Focused topic ${i}`,
    value: `focused topic ${i} · exact`,
    variable: 'keyword',
    hypothesis: 'A more relevant topic may acquire readers efficiently.',
    state: 'shortlisted',
  })),
};
function input(): WaveInput {
  return {
    dataset: 'workspace',
    experimentId: exp.id,
    name: 'Reader test',
    registration: 'retrospective',
    mappingVerified: true,
    startDate: dayAt(now, -42),
    endDate: dayAt(now, -15),
    budgetCents: 1000000,
    lossLimitCents: 600000,
    minClicksPerArm: 100,
    minLiftCentsPer100Clicks: 500,
    arms: [
      {
        role: 'baseline',
        variantId: null,
        sourceId: 'kw-baseline',
        label: 'Broad context',
        kind: 'keyword',
        matchType: 'broad',
      },
      {
        role: 'challenger',
        variantId: 'v-1',
        sourceId: 'kw-challenger',
        label: 'Focused topic 1',
        kind: 'keyword',
        matchType: 'exact',
      },
    ],
  };
}
function setupReports(orders = [50, 150], days = 28) {
  const entries = input().arms.map((a, index) => {
    const target: Target = {
      id: targetKey(c.id, a.sourceId),
      campaignId: c.id,
      sourceId: a.sourceId,
      label: a.label,
      kind: a.kind,
      matchType: a.matchType,
    };
    const rows: Observation[] = Array.from({ length: days }, (_, i) => ({
      campaignId: c.id,
      date: dayAt(now, -42 + i),
      impressions: 10000,
      clicks: 1000,
      orders: orders[index],
      spendCents: 10000,
      salesCents: orders[index] * 2000,
      refundsCents: 0,
      observedAt: now.toISOString(),
    }));
    return { target, rows };
  });
  store.importTargets(entries);
  store.importRows(
    entries[0].rows.map((r, i) => ({
      ...r,
      impressions: r.impressions + entries[1].rows[i].impressions,
      clicks: r.clicks + entries[1].rows[i].clicks,
      orders: r.orders + entries[1].rows[i].orders,
      spendCents: r.spendCents + entries[1].rows[i].spendCents,
      salesCents: r.salesCents + entries[1].rows[i].salesCents,
    })),
  );
  return entries;
}
const register = (value = input()) =>
  store.transaction(() => registerWave(store, waveInput.parse(value), now));
beforeEach(() => {
  store = new Store(':memory:');
  app = createApp(store);
  store.saveCampaign(c);
  store.putRecord('experiment', exp);
});
afterEach(() => store.close());

describe('frozen test plans and reservations', () => {
  it('keeps planned reporting IDs out of the measured library until observations arrive', async () => {
    register();
    const planned = await request(app).get('/api/dashboard?dataset=workspace').expect(200);
    expect(planned.body.waves).toHaveLength(1);
    expect(planned.body.targets).toHaveLength(0);
    setupReports();
    const measured = await request(app).get('/api/dashboard?dataset=workspace').expect(200);
    expect(measured.body.targets).toHaveLength(2);
    expect(measured.body.waves[0].evaluation.outcome).toBe('promising');
  });
  it('supports both portfolios and snapshots candidate content independently of later edits', () => {
    const wave = register();
    const edited = store.record<Experiment>('workspace', 'experiment', exp.id);
    edited.variants[0].value = 'A different candidate';
    store.putRecord('experiment', edited);
    expect(wave.arms[1].candidate?.value).toBe('focused topic 1 · exact');
    expect(evaluateWave(store, wave, now).outcome).toBe('repair');
    const product = {
      ...c,
      id: 'product',
      vertical: 'commerce' as const,
      channel: 'meta' as const,
    };
    store.saveCampaign(product);
    store.putRecord('experiment', {
      ...exp,
      id: 'product-exp',
      campaignId: product.id,
      variable: 'hook',
    });
    const productInput = {
      ...input(),
      experimentId: 'product-exp',
      arms: input().arms.map((a) => ({
        ...a,
        kind: 'creative' as const,
        matchType: 'creative' as const,
      })),
    };
    expect(register(productInput).campaignSnapshot.vertical).toBe('commerce');
  });
  it('requires registration before the first prospective day and labels historical reviews explicitly', () => {
    expect(() => register({ ...input(), registration: 'prospective' })).toThrow(/before/);
    expect(() =>
      register({ ...input(), startDate: dayAt(now, 1), endDate: dayAt(now, 10) }),
    ).toThrow(/Historical/);
    const wave = register({
      ...input(),
      registration: 'prospective',
      startDate: dayAt(now, 1),
      endDate: dayAt(now, 10),
    });
    expect(evaluateWave(store, wave, now).outcome).toBe('scheduled');
  });
  it('rejects duplicate mappings, missing baselines, non-shortlisted candidates, and incorrect target types', () => {
    const base = input();
    expect(() =>
      register({
        ...base,
        arms: [base.arms[0], { ...base.arms[1], sourceId: base.arms[0].sourceId }],
      }),
    ).toThrow(/distinct/);
    expect(() =>
      register({ ...base, arms: base.arms.map((a) => ({ ...a, role: 'challenger' })) }),
    ).toThrow(/baseline/);
    expect(() =>
      register({
        ...base,
        arms: [base.arms[0], { ...base.arms[1], variantId: 'not-shortlisted' }],
      }),
    ).toThrow(/shortlisted/);
    expect(() =>
      register({
        ...base,
        arms: [base.arms[0], { ...base.arms[1], kind: 'creative', matchType: 'creative' }],
      }),
    ).toThrow(/kind/);
    expect(store.records('workspace', 'wave')).toHaveLength(0);
  });
  it('prevents overlapping use of the same reporting cell across waves', () => {
    register();
    expect(() => register({ ...input(), name: 'Overlapping wave' })).toThrow(/already belongs/);
    expect(store.records('workspace', 'wave')).toHaveLength(1);
  });
  it('reserves outstanding allowance atomically and cancellation releases only unused planning capacity', async () => {
    store.saveCampaign({ ...c, totalLearningBudgetCents: 1500000 });
    const first = register();
    const next = {
      ...input(),
      arms: input().arms.map((a) => ({ ...a, sourceId: `${a.sourceId}-2` })),
    };
    expect(() => register(next)).toThrow(/learning allowance/);
    await request(app)
      .post(`/api/waves/${first.id}/cancel`)
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        reason: 'Replace this unlaunched test with a different question.',
      })
      .expect(200);
    expect(register(next).status).toBe('measuring');
    expect(store.campaign('workspace', c.id).dailyBudgetCents).toBe(c.dailyBudgetCents);
  });
  it('includes recorded spend in campaign and experiment commitments without charging it twice', () => {
    setupReports();
    store.saveCampaign({ ...c, totalLearningBudgetCents: 1000000 });
    const wave = register();
    expect(evaluateWave(store, wave, now).remainingPlanCents).toBe(440000);
    const next = {
      ...input(),
      arms: input().arms.map((a) => ({ ...a, sourceId: `${a.sourceId}-new` })),
      budgetCents: 50000,
      lossLimitCents: 10000,
    };
    expect(() => register(next)).toThrow(/learning allowance/);
  });
  it('requires reconciliation before allocating against underreported campaign spend', () => {
    setupReports();
    const row = store.observations(c.id)[0];
    store.importRows([{ ...row, spendCents: 1 }]);
    expect(() => register()).toThrow(/Reconcile/);
  });
  it('rolls back target registration and reservations when a reporting ID is redefined', () => {
    setupReports();
    const value = input();
    value.arms[1].label = 'A different definition';
    expect(() => register(value)).toThrow(/reused/);
    expect(store.records('workspace', 'wave')).toHaveLength(0);
    expect(store.targets(c.id)).toHaveLength(2);
  });
});

describe('maturity, uncertainty, and economic outcomes', () => {
  it('inverts beta tails and widens intervals when more candidates are considered', () => {
    const median = betaQuantile(0.5, 50, 82);
    expect(median).toBeCloseTo(0.5, 8);
    const q = betaQuantile(0.0125, 40, 500);
    expect(1 - probabilityAbove(q, 40, 500)).toBeCloseTo(0.0125, 8);
    expect(betaQuantile(0.0025, 40, 500)).toBeLessThan(q);
  });
  it('identifies a promising challenger only after the whole registered window matures', () => {
    setupReports();
    const wave = register();
    const result = evaluateWave(store, wave, now);
    expect(result.outcome).toBe('promising');
    expect(result.promisingTargetId).toBe(wave.arms[1].target.id);
    expect(result.canRecord).toBe(true);
    const immature = { ...wave, endDate: dayAt(now, -14) };
    // Add complete reports for the final, still-immature cohort.
    for (const arm of immature.arms) {
      const rows = store.targetRows(arm.target.id);
      store.importTargets([{ target: arm.target, rows: [{ ...rows[0], date: immature.endDate }] }]);
    }
    store.importRows([{ ...store.observations(c.id)[0], date: immature.endDate }]);
    expect(evaluateWave(store, immature, now).outcome).toBe('collecting');
    expect(evaluateWave(store, immature, now).canRecord).toBe(false);
  });
  it('retains an inconclusive result for tied or underpowered arms', () => {
    setupReports([50, 50]);
    const wave = register();
    expect(evaluateWave(store, wave, now).outcome).toBe('inconclusive');
    expect(evaluateWave(store, { ...wave, minClicksPerArm: 100000 }, now).title).toMatch(
      /limited evidence/,
    );
  });
  it('recognizes a stronger baseline and candidates below the profit reserve hurdle', () => {
    setupReports([150, 50]);
    const wave = register();
    expect(evaluateWave(store, wave, now).outcome).toBe('baseline-leading');
    setupReports([0, 0]);
    expect(evaluateWave(store, wave, now).outcome).toBe('unprofitable');
  });
  it('prioritizes a spent budget and mature loss boundaries without inferring an ad pause', () => {
    setupReports([0, 0]);
    const wave = register();
    expect(evaluateWave(store, { ...wave, budgetCents: 560000 }, now).outcome).toBe(
      'limit-reached',
    );
    expect(evaluateWave(store, { ...wave, lossLimitCents: 1000 }, now).outcome).toBe(
      'limit-reached',
    );
    expect(store.campaign('workspace', c.id).status).toBe('observing');
  });
  it('blocks conclusions for missing days, stale exports, changed economics, and parent overcounting', () => {
    setupReports();
    const wave = register();
    store.saveCampaign({ ...c, netReceiptCents: 900 });
    expect(evaluateWave(store, wave, now).blockers.join(' ')).toMatch(/economics/);
    store.saveCampaign(c);
    store.db
      .prepare('DELETE FROM target_observations WHERE target_id=? AND date=?')
      .run(wave.arms[0].target.id, dayAt(now, -42));
    expect(evaluateWave(store, wave, now).canRecord).toBe(false);
    setupReports();
    expect(
      evaluateWave(store, wave, new Date(now.getTime() + 3 * 86400000)).blockers.join(' '),
    ).toMatch(/48 hours/);
    store.importRows([{ ...store.observations(c.id)[0], orders: 1 }]);
    expect(evaluateWave(store, wave, now).blockers.join(' ')).toMatch(/totals exceed/);
  });
});

describe('immutable conclusions and scoped follow-ups', () => {
  it('withholds campaign increases while a wave is open and invalidates earlier scale proposals', async () => {
    setupReports();
    // Include zero delivery after the test window so campaign coverage is complete through yesterday.
    store.importRows(
      Array.from({ length: 14 }, (_, i) => ({
        campaignId: c.id,
        date: dayAt(now, -14 + i),
        impressions: 0,
        clicks: 0,
        orders: 0,
        spendCents: 0,
        salesCents: 0,
        refundsCents: 0,
        observedAt: now.toISOString(),
      })),
    );
    const before = await request(app).get('/api/dashboard?dataset=workspace').expect(200);
    const proposal = before.body.campaigns[0].decision;
    expect(proposal.kind).toBe('scale');
    register();
    const after = await request(app).get('/api/dashboard?dataset=workspace').expect(200);
    expect(after.body.campaigns[0].decision.kind).toBe('hold');
    expect(after.body.campaigns[0].decision.title).toMatch(/test wave/);
    const exported = await request(app).get('/api/export?dataset=workspace').expect(200);
    expect(exported.text).toContain('"hold"');
    expect(exported.text).not.toContain('"scale"');
    const analysis = await request(app)
      .post('/api/analysis')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace' })
      .expect(200);
    expect(analysis.body.decisions[0].evidenceId).toBe(after.body.campaigns[0].decision.evidenceId);
    await request(app)
      .post('/api/reviews')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        campaignId: c.id,
        evidenceId: proposal.evidenceId,
        action: 'accepted',
      })
      .expect(409);
  });
  it('rejects stale decisions, preserves old conclusions after corrections, and permits a new revision', async () => {
    setupReports();
    const wave = register();
    const result = evaluateWave(store, wave, now);
    const url = `/api/waves/${wave.id}/conclusion`;
    const body = {
      dataset: 'workspace',
      evidenceId: result.evidenceId,
      notes: 'Confirm the focused keyword with a stable audience and delivery.',
    };
    await request(app)
      .post(url)
      .set('X-Orbit-Request', '1')
      .send({ ...body, evidenceId: '0'.repeat(64) })
      .expect(409);
    const first = await request(app).post(url).set('X-Orbit-Request', '1').send(body).expect(200);
    await request(app).post(url).set('X-Orbit-Request', '1').send(body).expect(200);
    expect(store.records('workspace', 'learning')).toHaveLength(1);
    setupReports([50, 50]);
    expect(getLearningViews(store, 'workspace')[0].evidenceChanged).toBe(true);
    expect(getLearningViews(store, 'workspace')[0].result.outcome).toBe('promising');
    await request(app).post(url).set('X-Orbit-Request', '1').send(body).expect(409);
    const current = store.record<TestWave>('workspace', 'wave', wave.id);
    const revision = await request(app)
      .post(url)
      .set('X-Orbit-Request', '1')
      .send({ ...body, evidenceId: evaluateWave(store, current).evidenceId })
      .expect(200);
    expect(revision.body.learning.result.outcome).toBe('inconclusive');
    expect(revision.body.learning.supersedesId).toBe(first.body.learning.id);
    expect(getLearningViews(store, 'workspace').filter((l) => !l.superseded)).toHaveLength(1);
  });
  it('does not invalidate a finding when the same facts are simply re-exported', () => {
    const entries = setupReports();
    const wave = register();
    const learning = store.transaction(() =>
      recordLearning(
        store,
        wave,
        evaluateWave(store, wave).evidenceId,
        'Record a useful candidate for the next controlled test.',
      ),
    );
    store.importTargets(
      entries.map((entry) => ({
        ...entry,
        rows: entry.rows.map((r) => ({
          ...r,
          observedAt: new Date(now.getTime() + 1000).toISOString(),
        })),
      })),
    );
    expect(
      getLearningViews(store, 'workspace').find((l) => l.id === learning.id)?.evidenceChanged,
    ).toBe(false);
  });
  it('scopes setup exports and conclusions to their workspace', async () => {
    setupReports();
    const wave = register();
    await request(app).get(`/api/waves/${wave.id}/setup-sheet?dataset=demo`).expect(404);
    const sheet = await request(app)
      .get(`/api/waves/${wave.id}/setup-sheet?dataset=workspace`)
      .expect(200);
    expect(sheet.text).toContain('kw-challenger');
    expect(sheet.text).toContain(wave.planId);
    await request(app)
      .post(`/api/waves/${wave.id}/conclusion`)
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'demo',
        evidenceId: evaluateWave(store, wave).evidenceId,
        notes: 'Wrong dataset cannot read or modify this learning.',
      })
      .expect(404);
  });
  it('retains valid learning provenance and rejects reuse of corrected evidence', async () => {
    setupReports();
    const wave = register();
    const learning = store.transaction(() =>
      recordLearning(
        store,
        wave,
        evaluateWave(store, wave).evidenceId,
        'Follow up with an independently controlled comparison.',
      ),
    );
    const body = {
      dataset: 'workspace',
      campaignId: c.id,
      name: 'Follow-up',
      hypothesis: 'Confirm reader-intent contribution with controlled delivery.',
      variable: 'keyword',
      seedTerms: ['nature writing'],
      count: 12,
      maxConcurrent: 2,
      budgetCents: 10000,
      provider: 'structured-planner',
      sourceLearningId: learning.id,
    };
    const draft = await request(app)
      .post('/api/experiments')
      .set('X-Orbit-Request', '1')
      .send(body)
      .expect(201);
    expect(draft.body.sourceLearningId).toBe(learning.id);
    setupReports([50, 50]);
    await request(app).post('/api/experiments').set('X-Orbit-Request', '1').send(body).expect(400);
  });
});
