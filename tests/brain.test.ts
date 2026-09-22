import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { seedDemo } from '../server/seed.js';
import { seedWaves } from '../server/seed-waves.js';
import { seedBrain } from '../server/brain/seed.js';
import {
  connectorFor,
  createAccount,
  defaultPolicy,
  versionPolicy,
} from '../server/brain/accounts.js';
import {
  analyzeAccount,
  dedupeProposals,
  proposalSlate,
  rankProposals,
} from '../server/brain/policy.js';
import {
  authorizeProposal,
  committedToday,
  executeProposal,
  portfolioBudgetBlocker,
  reconcileProposal,
  runBrain,
  setKillSwitch,
} from '../server/brain/execution.js';
import { searchTermKey, syncAccount } from '../server/brain/sync.js';
import type { SandboxConnector, SandboxState } from '../server/connectors/sandbox.js';
import type { Proposal } from '../shared/types.js';
import { targetKey } from '../server/targets.js';

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
    expect(harvests.some((p) => p.action.type === 'create-keyword')).toBe(true);
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
      const duplicate = {
        ...fresh[0],
        id: randomUUID(),
        idempotencyKey: `duplicate-fresh-${randomUUID()}`,
      };
      expect(
        dedupeProposals(
          empty,
          { ...account(), policy: { ...account().policy, maxActionsPerRun: 10 } },
          [fresh[0], duplicate],
          now,
        ),
      ).toHaveLength(1);
    } finally {
      empty.close();
    }
  });
  it('builds a balanced review slate while ranking defensive work first', () => {
    const fresh = analyzeAccount(store, account(), store.reportingTime('demo')).flatMap(
      (analysis) => analysis.proposals,
    );
    const negative = fresh.find((proposal) => proposal.actionClass === 'negative')!;
    const harvest = fresh.find((proposal) => proposal.actionClass === 'harvest')!;
    expect(rankProposals([harvest, negative]).map((proposal) => proposal.actionClass)).toEqual([
      'negative',
      'harvest',
    ]);
    const slate = proposalSlate(fresh, 7);
    expect(slate).toHaveLength(7);
    expect(slate.some((proposal) => proposal.actionClass === 'negative')).toBe(true);
    expect(slate.some((proposal) => proposal.actionClass === 'harvest')).toBe(true);
    expect(new Set(slate.map((proposal) => proposal.actionClass)).size).toBeGreaterThan(1);
    expect(fresh.some((proposal) => proposal.actionClass === 'budget-up')).toBe(true);
    const snapshot = store.snapshot('demo-sandbox')!;
    const activeBudget = snapshot.campaigns
      .filter((campaign) => campaign.state === 'enabled')
      .reduce((sum, campaign) => sum + campaign.dailyBudgetCents, 0);
    const capped = {
      ...account(),
      policy: { ...account().policy, maxPortfolioDailyBudgetCents: activeBudget },
    };
    const cappedFresh = analyzeAccount(store, capped, store.reportingTime('demo')).flatMap(
      (analysis) => analysis.proposals,
    );
    expect(cappedFresh.some((proposal) => proposal.actionClass === 'budget-up')).toBe(false);
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
  it('changes direct-ASIN targets and keeps complex product expressions observe-only', () => {
    const campaignId = 'demo-home';
    const link = store
      .links('demo-sandbox')
      .find((candidate) => candidate.campaignId === campaignId)!;
    const snapshot = store.snapshot('demo-sandbox')!;
    const replaced = snapshot.keywords.filter(
      (keyword) => keyword.campaignExternalId === link.externalCampaignId,
    );
    snapshot.keywords = snapshot.keywords.filter(
      (keyword) => keyword.campaignExternalId !== link.externalCampaignId,
    );
    snapshot.productTargets = replaced.map((keyword, index) => ({
      externalId: keyword.externalId,
      campaignExternalId: keyword.campaignExternalId,
      adGroupExternalId: keyword.adGroupExternalId,
      expressionType: 'manual' as const,
      expression: [{ type: 'ASIN_SAME_AS', value: `B${String(index).padStart(9, '0')}` }],
      label: `ASIN_SAME_AS=B${String(index).padStart(9, '0')}`,
      asin: `B${String(index).padStart(9, '0')}`,
      state: keyword.state,
      bidCents: keyword.bidCents,
    }));
    store.saveSnapshot('demo-sandbox', snapshot);
    const direct = analyzeAccount(store, account(), store.reportingTime('demo')).find(
      (candidate) => candidate.campaign.id === campaignId,
    )!;
    expect(replaced.length).toBeGreaterThan(0);
    const directChanges = direct.proposals.filter(
      (proposal) =>
        proposal.action.type === 'update-product-target-bid' ||
        proposal.action.type === 'update-product-target-state',
    );
    expect(directChanges.length).toBeGreaterThan(0);
    expect(
      directChanges.every((proposal) => typeof proposal.expectedPriorState.asin === 'string'),
    ).toBe(true);
    snapshot.productTargets = snapshot.productTargets.map((target, index) => ({
      ...target,
      expressionType: index === 0 ? ('auto' as const) : ('manual' as const),
      expression: [
        {
          type: index === 0 ? 'QUERY_HIGH_REL_MATCHES' : 'ASIN_CATEGORY_SAME_AS',
          value: index === 0 ? null : `category-${index}`,
        },
      ],
      label: index === 0 ? 'QUERY_HIGH_REL_MATCHES' : `ASIN_CATEGORY_SAME_AS=category-${index}`,
      asin: null,
    }));
    store.saveSnapshot('demo-sandbox', snapshot);
    const complex = analyzeAccount(store, account(), store.reportingTime('demo')).find(
      (candidate) => candidate.campaign.id === campaignId,
    )!;
    expect(
      complex.proposals.some(
        (proposal) =>
          proposal.action.type === 'update-product-target-bid' ||
          proposal.action.type === 'update-product-target-state',
      ),
    ).toBe(false);
  });
});

describe('execution outbox', () => {
  it('turns a wasteful matched ASIN into a reviewed negative product target with read-back', async () => {
    const campaignId = 'demo-home';
    const source = store
      .searchTerms(campaignId)
      .find((term) => term.term === 'free nature wallpapers')!;
    const wasteRows = store.searchTermRows(source.id);
    expect(wasteRows.length).toBeGreaterThan(20);
    store.transaction(() => {
      store.db
        .prepare(
          "DELETE FROM search_term_observations WHERE term_id IN (SELECT id FROM search_terms WHERE campaign_id=? AND json_extract(body,'$.keywordExternalId')=?)",
        )
        .run(campaignId, 'sample-cell-1');
      store.db
        .prepare(
          "DELETE FROM search_terms WHERE campaign_id=? AND json_extract(body,'$.keywordExternalId')=?",
        )
        .run(campaignId, 'sample-cell-1');
      store.db
        .prepare('DELETE FROM target_observations WHERE target_id=?')
        .run(targetKey(campaignId, 'sample-cell-1'));
      store.db
        .prepare('DELETE FROM targets WHERE id=?')
        .run(targetKey(campaignId, 'sample-cell-1'));
      store.importTargets([
        {
          target: {
            id: targetKey(campaignId, 'pt-1'),
            campaignId,
            sourceId: 'pt-1',
            label: 'ASIN_SAME_AS=B012345678',
            kind: 'product-target',
            matchType: 'product',
          },
          rows: wasteRows,
        },
      ]);
      store.importSearchTerms([
        {
          term: {
            id: searchTermKey(campaignId, 'pt-1', 'B087654321'),
            campaignId,
            term: 'b087654321',
            keywordExternalId: 'pt-1',
            keywordText: 'ASIN_SAME_AS=B012345678',
            matchType: 'auto',
            adGroupExternalId: store.links('demo-sandbox').find((l) => l.campaignId === campaignId)!
              .adGroupExternalId,
            sourceKind: 'product-target',
          },
          rows: wasteRows,
        },
      ]);
      const snapshot = store.snapshot('demo-sandbox')!;
      snapshot.keywords = snapshot.keywords.filter(
        (keyword) => keyword.externalId !== 'sample-cell-1',
      );
      snapshot.productTargets = [
        {
          externalId: 'pt-1',
          campaignExternalId: store.links('demo-sandbox').find((l) => l.campaignId === campaignId)!
            .externalCampaignId,
          adGroupExternalId: store.links('demo-sandbox').find((l) => l.campaignId === campaignId)!
            .adGroupExternalId,
          expressionType: 'manual',
          expression: [{ type: 'ASIN_SAME_AS', value: 'B012345678' }],
          label: 'ASIN_SAME_AS=B012345678',
          asin: 'B012345678',
          state: 'enabled',
          bidCents: 50,
        },
      ];
      snapshot.negativeProductTargets = [];
      store.saveSnapshot('demo-sandbox', snapshot);
      const state = store.sandboxState<SandboxState>('demo-sandbox')!;
      const remote = state.campaigns.find(
        (campaign) =>
          campaign.externalId ===
          store.links('demo-sandbox').find((l) => l.campaignId === campaignId)!.externalCampaignId,
      )!;
      remote.productTargets = [
        { externalId: 'pt-1', asin: 'B012345678', state: 'enabled', bidCents: 50 },
      ];
      remote.negativeProductTargets = [];
      store.saveSandboxState('demo-sandbox', state);
    });
    const proposal = analyzeAccount(store, account(), store.reportingTime('demo'))
      .flatMap((analysis) => analysis.proposals)
      .find(
        (candidate) =>
          candidate.action.type === 'create-negative-product-target' &&
          candidate.action.asin === 'B087654321',
      );
    expect(proposal).toMatchObject({ actionClass: 'negative', needsReview: true });
    store.saveProposal(proposal!);
    authorizeProposal(store, account(), proposal!.id, 'operator', now);
    const result = await executeProposal(store, account(), sandbox(), proposal!.id, now);
    expect(result.proposal.status).toBe('applied');
    expect(
      (
        await sandbox().listNegativeProductTargets([
          store.links('demo-sandbox').find((l) => l.campaignId === campaignId)!.externalCampaignId,
        ])
      ).some((target) => target.asin === 'B087654321'),
    ).toBe(true);
  });
  it('cancels a reviewed change after the operating policy changes', async () => {
    const p = byClass('bid-up')[0];
    authorizeProposal(store, account(), p.id, 'operator', now);
    const { version: _, ...input } = account().policy;
    store.saveAccount({ ...account(), policy: versionPolicy({ ...input, maxBidStepPct: 5 }) });
    const outcome = await executeProposal(store, account(), sandbox(), p.id, now);
    expect(outcome.proposal.status).toBe('cancelled');
    expect(outcome.proposal.history.at(-1)?.note).toMatch(/policy changed/);
    expect(store.executions('demo')).toHaveLength(0);
  });
  it('cancels a budget increase when live profile budgets consume the portfolio ceiling', async () => {
    const template = byClass('bid-up')[0];
    const link = store
      .links('demo-sandbox')
      .find((candidate) => candidate.campaignId === template.campaignId)!;
    const snapshot = store.snapshot('demo-sandbox')!;
    const platformCampaign = snapshot.campaigns.find(
      (campaign) => campaign.externalId === link.externalCampaignId,
    )!;
    const activeBudget = snapshot.campaigns
      .filter((campaign) => campaign.state === 'enabled')
      .reduce((sum, campaign) => sum + campaign.dailyBudgetCents, 0);
    const delta = 100;
    const { version: _, ...policyInput } = account().policy;
    const governed = {
      ...account(),
      policy: versionPolicy({
        ...policyInput,
        maxPortfolioDailyBudgetCents: activeBudget + delta,
      }),
    };
    store.saveAccount(governed);
    const proposal: Proposal = {
      ...template,
      id: randomUUID(),
      actionClass: 'budget-up',
      action: {
        type: 'update-campaign-budget',
        externalCampaignId: link.externalCampaignId,
        fromCents: platformCampaign.dailyBudgetCents,
        toCents: platformCampaign.dailyBudgetCents + delta,
      },
      targetRef: `campaign:${link.externalCampaignId}`,
      title: 'Raise budget inside the portfolio ceiling',
      expectedPriorState: {
        dailyBudgetCents: platformCampaign.dailyBudgetCents,
        state: platformCampaign.state,
      },
      maxCommitmentCents: delta,
      status: 'proposed',
      authorization: null,
      policyVersion: governed.policy.version,
      idempotencyKey: `portfolio-ceiling-${randomUUID()}`,
      history: [{ at: now.toISOString(), status: 'proposed', note: 'Test proposal.' }],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    store.saveProposal(proposal);
    authorizeProposal(store, governed, proposal.id, 'operator', now);
    const competing: Proposal = {
      ...proposal,
      id: randomUUID(),
      action: {
        type: 'update-campaign-budget',
        externalCampaignId: link.externalCampaignId,
        fromCents: platformCampaign.dailyBudgetCents,
        toCents: platformCampaign.dailyBudgetCents + 1,
      },
      maxCommitmentCents: 1,
      status: 'reserved',
      idempotencyKey: `portfolio-reservation-${randomUUID()}`,
    };
    store.saveProposal(competing);
    expect(portfolioBudgetBlocker(store, governed, proposal)).toMatch(/portfolio daily budget/);
    store.saveProposal({ ...competing, status: 'cancelled' });
    const state = store.sandboxState<SandboxState>('demo-sandbox')!;
    const other = state.campaigns.find(
      (campaign) => campaign.externalId !== link.externalCampaignId && campaign.state === 'enabled',
    )!;
    other.dailyBudgetCents += 1;
    store.saveSandboxState('demo-sandbox', state);
    const outcome = await executeProposal(store, governed, sandbox(), proposal.id, now);
    expect(outcome.proposal.status).toBe('cancelled');
    expect(outcome.proposal.history.at(-1)?.note).toMatch(/portfolio daily budget ceiling/);
    expect(store.executions('demo')).toHaveLength(0);
  });
  it('keeps commitment, deduplication, and kill-switch safety beyond 2,000 proposals', () => {
    const template = byClass('bid-up')[0];
    const sentinel: Proposal = {
      ...template,
      id: randomUUID(),
      idempotencyKey: 'old-authorized-sentinel',
      targetRef: 'keyword:old-authorized-sentinel',
      status: 'authorized',
      createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2000-01-01T00:00:00.000Z',
    };
    store.transaction(() => {
      store.saveProposal(sentinel);
      for (let i = 0; i < 2100; i++)
        store.saveProposal({
          ...template,
          id: randomUUID(),
          idempotencyKey: `commitment-${i}`,
          status: 'applied',
          maxCommitmentCents: 1,
          createdAt: new Date(now.getTime() + i + 1).toISOString(),
          updatedAt: now.toISOString(),
        });
    });
    expect(committedToday(store, account(), now.toISOString().slice(0, 10))).toBe(2100);
    expect(
      dedupeProposals(
        store,
        account(),
        [
          {
            ...sentinel,
            id: randomUUID(),
            idempotencyKey: 'new-candidate-for-old-target',
            status: 'proposed',
          },
        ],
        now,
      ),
    ).toHaveLength(0);
    setKillSwitch(store, account(), true, now);
    expect(store.proposal('demo', sentinel.id).status).toBe('cancelled');
  });
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
  it('keeps observe mode read-only and does not persist recommendations', async () => {
    store.db.exec('DELETE FROM proposals');
    const observing = {
      ...account(),
      policy: { ...account().policy, mode: 'observe' as const, aiReview: true },
    };
    store.saveAccount(observing);
    const summary = await runBrain(store, observing, sandbox(), now, { sync: false });
    expect(summary.proposed).toBe(0);
    expect(summary.notes).toContain(
      'Observe mode synchronized evidence without saving change proposals.',
    );
    expect(store.accountProposals(observing.id, ['proposed'])).toHaveLength(0);
  });
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
    expect(home.productTargets).toBe(0);
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
  it('starts a verified live profile in observe mode with AI review off', () => {
    vi.stubEnv('AMAZON_ADS_CLIENT_ID', 'test-client');
    vi.stubEnv('AMAZON_ADS_CLIENT_SECRET', 'test-secret');
    vi.stubEnv('AMAZON_ADS_REFRESH_TOKEN', 'test-refresh');
    try {
      const live = createAccount(
        store,
        {
          dataset: 'workspace',
          name: 'Live publisher',
          connector: 'amazon-ads',
          profileId: '123',
          marketplace: 'US',
          attributionDays: 14,
        },
        now,
        {
          profileId: '123',
          countryCode: 'US',
          currencyCode: 'USD',
          timezone: 'America/Los_Angeles',
          accountInfo: { id: 'advertiser', name: 'Live publisher', type: 'seller' },
        },
      );
      expect(live.policy).toMatchObject({ mode: 'observe', aiReview: false });
    } finally {
      vi.unstubAllEnvs();
    }
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
