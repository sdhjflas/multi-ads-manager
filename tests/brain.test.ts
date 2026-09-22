import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { seedDemo } from '../server/seed.js';
import { seedWaves } from '../server/seed-waves.js';
import { seedBrain } from '../server/brain/seed.js';
import { connectorFor, createAccount, defaultPolicy } from '../server/brain/accounts.js';
import { analyzeAccount, dedupeProposals } from '../server/brain/policy.js';
import {
  authorizeProposal,
  committedToday,
  executeProposal,
  reconcileProposal,
  runBrain,
  setKillSwitch,
} from '../server/brain/execution.js';
import { syncAccount } from '../server/brain/sync.js';
import type { SandboxConnector, SandboxState } from '../server/connectors/sandbox.js';
import type { Proposal } from '../shared/types.js';

let store: Store;
const now = new Date();
async function demoStore() {
  const s = new Store(':memory:');
  seedDemo(s, now);
  seedWaves(s);
  await seedBrain(s);
  return s;
}
const account = () => store.account('demo', 'demo-sandbox');
const sandbox = () => connectorFor(store, account(), now) as SandboxConnector;
const proposals = () => store.proposals('demo', 2000);
const byClass = (cls: Proposal['actionClass']) =>
  proposals().filter((p) => p.actionClass === cls && p.status === 'proposed');

beforeEach(async () => {
  store = await demoStore();
});
afterEach(() => store.close());

describe('synchronization', () => {
  it('captures platform structure and performance without disturbing seeded target cells', async () => {
    const a = account();
    expect(a.health.status).toBe('ok');
    expect(a.health.coverage.campaigns).toBe(3);
    expect(a.health.coverage.keywords).toBe(9);
    expect(a.health.watermarkDate).not.toBeNull();
    const snapshot = store.snapshot(a.id)!;
    expect(snapshot.keywords.map((k) => k.matchType).sort()).toEqual([
      'broad',
      'broad',
      'broad',
      'exact',
      'exact',
      'exact',
      'phrase',
      'phrase',
      'phrase',
    ]);
    // Synced keyword cells reuse the seeded sample-cell identities and numbers.
    const targets = store.targets('demo-home');
    expect(targets.map((t) => t.sourceId).sort()).toEqual([
      'sample-cell-1',
      'sample-cell-2',
      'sample-cell-3',
    ]);
    const parent = store.observations('demo-home');
    const cells = targets.map((t) => store.targetRows(t.id));
    for (const day of parent) {
      const sum = cells.reduce(
        (s, rows) => s + (rows.find((r) => r.date === day.date)?.clicks ?? 0),
        0,
      );
      expect(sum).toBe(day.clicks);
    }
    const terms = store.searchTerms('demo-home');
    expect(terms.length).toBeGreaterThanOrEqual(8);
    expect(terms.some((t) => t.term === 'free nature wallpapers')).toBe(true);
    // Term cells never exceed their keyword cell.
    const broad = targets.find((t) => t.sourceId === 'sample-cell-1')!;
    const broadRows = store.targetRows(broad.id);
    const termRows = terms
      .filter((t) => t.keywordExternalId === 'sample-cell-1')
      .map((t) => store.searchTermRows(t.id));
    for (const day of broadRows) {
      const sum = termRows.reduce(
        (s, rows) => s + (rows.find((r) => r.date === day.date)?.clicks ?? 0),
        0,
      );
      expect(sum).toBeLessThanOrEqual(day.clicks);
    }
  });
  it('re-pulls only the trailing attribution window after the first sync and records health on failure', async () => {
    const run = await syncAccount(store, account(), sandbox(), now);
    expect(run.status).toBe('ok');
    const days = (Date.parse(run.endDate) - Date.parse(run.startDate)) / 86_400_000;
    expect(days).toBe(account().attributionDays + 2);
    const state = store.sandboxState<SandboxState>('demo-sandbox')!;
    state.fault = { kind: 'throttled', remaining: 1 };
    store.saveSandboxState('demo-sandbox', state);
    const failed = await syncAccount(store, account(), sandbox(), now);
    expect(failed.status).toBe('throttled');
    expect(account().health.status).toBe('throttled');
    expect(account().health.lastSuccessAt).not.toBeNull();
  });
});

describe('policy engine', () => {
  it('proposes negatives, harvests, bid moves, and a capped budget step from mature evidence', () => {
    const open = proposals().filter((p) => p.status === 'proposed');
    expect(open.length).toBeGreaterThan(0);
    const negatives = byClass('negative');
    expect(
      negatives.some(
        (p) =>
          p.action.type === 'create-negative-keyword' &&
          p.action.keywordText === 'free nature wallpapers',
      ),
    ).toBe(true);
    for (const n of negatives) expect(n.evidence.matureOrders).toBe(0);
    const harvests = byClass('harvest');
    expect(
      harvests.some(
        (p) => p.action.type === 'create-keyword' && p.action.keywordText === 'nature essays',
      ),
    ).toBe(true);
    for (const h of harvests) {
      expect(h.needsReview).toBe(true); // no AI relevance yet
      expect(h.evidence.matureOrders).toBeGreaterThanOrEqual(2);
      if (h.action.type === 'create-keyword')
        expect(h.action.bidCents).toBeLessThanOrEqual(account().policy.maxBidCents);
    }
    const bidUps = byClass('bid-up');
    expect(bidUps.length).toBeGreaterThan(0);
    for (const b of bidUps)
      if (b.action.type === 'update-keyword-bid')
        expect(b.action.toCents).toBeLessThanOrEqual(Math.floor(b.action.fromCents * 1.2));
    const budgets = byClass('budget-up');
    for (const b of budgets)
      if (b.action.type === 'update-campaign-budget')
        expect(b.action.toCents).toBeLessThanOrEqual(Math.floor(b.action.fromCents * 1.2));
    // Never a proposal for the campaign with an open measurement wave.
    expect(open.some((p) => p.campaignId === 'demo-atlas')).toBe(false);
    for (const p of open) expect(p.maxCommitmentCents).toBeGreaterThanOrEqual(0);
  });
  it('does not duplicate open work and never exceeds the per-run cap', () => {
    const before = proposals().length;
    const fresh = analyzeAccount(store, account(), store.reportingTime('demo')).flatMap(
      (a) => a.proposals,
    );
    expect(fresh.length).toBeGreaterThan(0);
    const open = proposals().filter((p) => p.status === 'proposed');
    const next = dedupeProposals(store, account(), fresh, now);
    // The first run was capped; the remainder may follow, but nothing open repeats.
    expect(next.length).toBeLessThanOrEqual(account().policy.maxActionsPerRun);
    expect(
      next.some((n) =>
        open.some((o) => o.campaignId === n.campaignId && o.targetRef === n.targetRef),
      ),
    ).toBe(false);
    expect(proposals().length).toBe(before);
    const capped = { ...account(), policy: { ...account().policy, maxActionsPerRun: 2 } };
    const empty = new Store(':memory:');
    try {
      expect(dedupeProposals(empty, capped, fresh, now).length).toBeLessThanOrEqual(2);
    } finally {
      empty.close();
    }
  });
  it('blocks every proposal when economics are unverified', async () => {
    const c = store.campaign('demo', 'demo-home');
    store.saveCampaign({ ...c, economicsVerified: false });
    const analysis = analyzeAccount(store, account(), store.reportingTime('demo')).find(
      (a) => a.campaign.id === 'demo-home',
    )!;
    expect(analysis.proposals).toHaveLength(0);
    expect(
      analysis.terms.every((t) => t.signal === 'blocked' || t.signal === 'already-exact'),
    ).toBe(true);
  });
});

describe('execution outbox', () => {
  it('applies an authorized negative keyword with read-back and refuses to repeat it', async () => {
    const p = byClass('negative')[0];
    authorizeProposal(store, account(), p.id, 'operator', now);
    const outcome = await executeProposal(store, account(), sandbox(), p.id, now);
    expect(outcome.proposal.status).toBe('applied');
    expect(outcome.proposal.readBack).toEqual(expect.objectContaining({ exists: 1 }));
    expect(outcome.attempt?.outcome).toBe('applied');
    const negatives = await sandbox().listNegativeKeywords(
      [store.links('demo-sandbox').map((l) => l.externalCampaignId)].flat(),
    );
    expect(
      negatives.some(
        (n) => p.action.type === 'create-negative-keyword' && n.text === p.action.keywordText,
      ),
    ).toBe(true);
    await expect(executeProposal(store, account(), sandbox(), p.id, now)).rejects.toThrow(
      /cannot be executed/,
    );
    expect(store.executions('demo')).toHaveLength(1);
    // Re-evaluation does not propose the same exclusion again (cooldown + platform state).
    const fresh = analyzeAccount(store, account(), store.reportingTime('demo')).flatMap(
      (a) => a.proposals,
    );
    expect(fresh.some((q) => q.targetRef === p.targetRef && q.campaignId === p.campaignId)).toBe(
      false,
    );
  });
  it('cancels when the platform state drifted from the reviewed prior state', async () => {
    const p = byClass('bid-up')[0];
    expect(p.action.type).toBe('update-keyword-bid');
    authorizeProposal(store, account(), p.id, 'operator', now);
    const link = store.links('demo-sandbox').find((l) => l.campaignId === p.campaignId)!;
    if (p.action.type === 'update-keyword-bid')
      await sandbox().updateKeywords([
        {
          externalId: p.action.keywordExternalId,
          campaignExternalId: link.externalCampaignId,
          bidCents: p.action.fromCents + 1,
        },
      ]);
    const outcome = await executeProposal(store, account(), sandbox(), p.id, now);
    expect(outcome.proposal.status).toBe('cancelled');
    expect(outcome.proposal.history.at(-1)?.note).toMatch(/drifted/);
    expect(store.executions('demo')).toHaveLength(0);
  });
  it('refuses execution outside the commitment envelope, in observe mode, and under the kill switch', async () => {
    const p = byClass('bid-up')[0];
    const tight = { ...account(), policy: { ...account().policy, maxDailyCommitmentCents: 0 } };
    store.saveAccount(tight);
    authorizeProposal(store, tight, p.id, 'operator', now);
    const outcome = await executeProposal(store, tight, sandbox(), p.id, now);
    expect(outcome.proposal.status).toBe('cancelled');
    expect(outcome.proposal.history.at(-1)?.note).toMatch(/envelope/);
    expect(committedToday(store, tight, now.toISOString().slice(0, 10))).toBe(0);

    const q = byClass('negative')[0];
    const observing = { ...account(), policy: { ...account().policy, mode: 'observe' as const } };
    store.saveAccount(observing);
    expect(() => authorizeProposal(store, observing, q.id, 'operator', now)).toThrow(
      /observe mode/,
    );

    store.saveAccount({ ...account(), policy: { ...account().policy, mode: 'supervised' } });
    authorizeProposal(store, account(), q.id, 'operator', now);
    setKillSwitch(store, account(), true, now);
    expect(store.proposal('demo', q.id).status).toBe('cancelled');
    const r = byClass('negative')[0];
    expect(() => authorizeProposal(store, account(), r.id, 'policy', now)).not.toThrow();
    const blocked = await executeProposal(store, account(), sandbox(), r.id, now);
    expect(blocked.proposal.status).toBe('cancelled');
    expect(blocked.proposal.history.at(-1)?.note).toMatch(/Kill switch/);
  });
  it('marks a lost response uncertain, then reconciles it from platform state', async () => {
    const p = byClass('negative')[0];
    authorizeProposal(store, account(), p.id, 'operator', now);
    const state = store.sandboxState<SandboxState>('demo-sandbox')!;
    state.fault = { kind: 'ambiguous', remaining: 1 };
    store.saveSandboxState('demo-sandbox', state);
    const outcome = await executeProposal(store, account(), sandbox(), p.id, now);
    expect(outcome.proposal.status).toBe('uncertain');
    expect(outcome.attempt?.outcome).toBe('uncertain');
    const reconciled = await reconcileProposal(store, account(), sandbox(), p.id, now);
    expect(reconciled.proposal.status).toBe('applied');
    expect(reconciled.attempt?.outcome).toBe('reconciled');
    expect(store.executions('demo')).toHaveLength(2);
  });
  it('releases the reservation when the platform cannot be read before sending', async () => {
    const p = byClass('negative')[0];
    authorizeProposal(store, account(), p.id, 'operator', now);
    const state = store.sandboxState<SandboxState>('demo-sandbox')!;
    state.fault = { kind: 'unavailable', remaining: 1 };
    store.saveSandboxState('demo-sandbox', state);
    const outcome = await executeProposal(store, account(), sandbox(), p.id, now);
    expect(outcome.proposal.status).toBe('authorized');
    expect(outcome.proposal.history.at(-1)?.note).toMatch(/Reservation released/);
    expect(store.executions('demo')).toHaveLength(0);
    const retry = await executeProposal(store, account(), sandbox(), p.id, now);
    expect(retry.proposal.status).toBe('applied');
  });
});

describe('bounded automation', () => {
  it('authorizes and executes only the allowed classes and leaves review items alone', async () => {
    const bounded = {
      ...account(),
      policy: {
        ...account().policy,
        mode: 'bounded' as const,
        allowedClasses: ['negative' as const],
        aiReview: false,
      },
    };
    store.saveAccount(bounded);
    const summary = await runBrain(store, bounded, sandbox(), now, { sync: false });
    expect(summary.authorized).toBeGreaterThan(0);
    expect(summary.executed.applied).toBe(summary.authorized);
    const all = proposals();
    expect(all.filter((p) => p.actionClass === 'negative' && p.status === 'applied').length).toBe(
      summary.authorized,
    );
    expect(
      all.filter((p) => p.actionClass === 'harvest').every((p) => p.status === 'proposed'),
    ).toBe(true);
    expect(
      all.filter((p) => p.actionClass === 'bid-up').every((p) => p.status === 'proposed'),
    ).toBe(true);
    for (const p of all.filter((p) => p.status === 'applied'))
      expect(p.authorization?.by).toBe('policy');
  });
});

describe('workspace accounts and API', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(store);
  });
  const post = (path: string, body: unknown) =>
    request(app).post(path).set('X-Orbit-Request', '1').send(body);
  it('serves the brain view with scorecards, terms, and proposals', async () => {
    const res = await request(app).get('/api/brain?dataset=demo').expect(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.scorecards).toHaveLength(6);
    const home = res.body.scorecards.find(
      (s: { campaignId: string }) => s.campaignId === 'demo-home',
    );
    expect(home.linked).toBe(true);
    expect(home.keywords).toBe(3);
    expect(home.metrics.roas).toBeGreaterThan(0);
    const atlas = res.body.scorecards.find(
      (s: { campaignId: string }) => s.campaignId === 'demo-atlas',
    );
    expect(atlas.ledgerContributionCents).not.toBeNull();
    expect(res.body.searchTerms.length).toBeGreaterThan(0);
    expect(res.body.proposals.length).toBeGreaterThan(0);
    expect(res.body.integrations.amazonAds.configured).toBe(false);
  });
  it('walks a proposal through authorize and execute over HTTP', async () => {
    const p = byClass('negative')[0];
    await post(`/api/brain/proposals/${p.id}/execute`, { dataset: 'demo' }).expect(409);
    const authorized = await post(`/api/brain/proposals/${p.id}/authorize`, {
      dataset: 'demo',
    }).expect(200);
    expect(authorized.body.status).toBe('authorized');
    const executed = await post(`/api/brain/proposals/${p.id}/execute`, { dataset: 'demo' }).expect(
      200,
    );
    expect(executed.body.proposal.status).toBe('applied');
    await post(`/api/brain/proposals/${p.id}/reject`, {
      dataset: 'demo',
      reason: 'Too late.',
    }).expect(409);
    await post(`/api/brain/proposals/${byClass('harvest')[0].id}/reject`, {
      dataset: 'demo',
      reason: 'Not relevant.',
    }).expect(200);
  });
  it('connects a workspace sandbox account, links a campaign, syncs, and evaluates', async () => {
    const setup = {
      dataset: 'workspace',
      name: 'Workflow book',
      vertical: 'books',
      channel: 'amazon',
      entityName: 'Workflow title',
      accountName: 'Synthetic client',
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
      brief: 'A synthetic paperback about walking.',
    };
    const campaign = (await post('/api/campaigns', setup).expect(201)).body;
    const created = (
      await post('/api/brain/accounts', {
        dataset: 'workspace',
        name: 'Sandbox',
        connector: 'sandbox',
        profileId: 'sandbox',
        marketplace: 'US',
        attributionDays: 14,
      }).expect(201)
    ).body;
    expect(created.policy.mode).toBe('supervised');
    await post('/api/brain/accounts', {
      dataset: 'workspace',
      name: 'Live',
      connector: 'amazon-ads',
      profileId: '123',
      marketplace: 'US',
      attributionDays: 14,
    }).expect(503);
    const first = (
      await post(`/api/brain/accounts/${created.id}/sync`, { dataset: 'workspace' }).expect(200)
    ).body;
    expect(first.status).toBe('partial');
    const view = (await request(app).get('/api/brain?dataset=workspace').expect(200)).body;
    const platformCampaign = view.platform[created.id].campaigns[0];
    const adGroup = view.platform[created.id].adGroups.find(
      (g: { campaignExternalId: string }) => g.campaignExternalId === platformCampaign.externalId,
    );
    await post(`/api/brain/accounts/${created.id}/links`, {
      dataset: 'workspace',
      campaignId: campaign.id,
      externalCampaignId: platformCampaign.externalId,
      adGroupExternalId: 'wrong',
    }).expect(400);
    await post(`/api/brain/accounts/${created.id}/links`, {
      dataset: 'workspace',
      campaignId: campaign.id,
      externalCampaignId: platformCampaign.externalId,
      adGroupExternalId: adGroup.externalId,
    }).expect(201);
    const summary = (
      await post(`/api/brain/accounts/${created.id}/run`, {
        dataset: 'workspace',
        sync: true,
      }).expect(200)
    ).body;
    expect(summary.sync.status).toBe('ok');
    expect(store.observations(campaign.id).length).toBe(56);
    expect(store.searchTerms(campaign.id).length).toBeGreaterThan(0);
    const after = (await request(app).get('/api/brain?dataset=workspace&days=28').expect(200)).body;
    expect(after.scorecards[0].linked).toBe(true);
    expect(after.scorecards[0].searchTerms).toBeGreaterThan(0);
  });
  it('validates the operating policy and the ledger import', async () => {
    const a = account();
    const policy = { ...defaultPolicy(), mode: 'bounded', allowedClasses: ['negative'] };
    delete (policy as { version?: string }).version;
    const res = await request(app)
      .patch(`/api/brain/accounts/${a.id}/policy`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'demo', policy })
      .expect(200);
    expect(res.body.policy.mode).toBe('bounded');
    expect(res.body.policy.version).not.toBe(a.policy.version);
    await request(app)
      .patch(`/api/brain/accounts/${a.id}/policy`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'demo', policy: { ...policy, maxBidStepPct: 500 } })
      .expect(400);
    await post('/api/brain/ledger', {
      dataset: 'workspace',
      campaignId: 'demo-home',
      csv: 'date,units,net_receipts_cents,refunds_cents\n2026-01-01,1,1000,0',
      reconciled: true,
    }).expect(404);
    await post('/api/brain/ledger', {
      dataset: 'demo',
      campaignId: 'demo-home',
      csv: 'x',
      reconciled: true,
    }).expect(400);
  });
});
