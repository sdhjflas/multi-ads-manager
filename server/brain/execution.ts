import { randomUUID } from 'node:crypto';
import type {
  AdAccount,
  ExecutionAttempt,
  PlatformSnapshot,
  Proposal,
  ProposalStatus,
} from '../../shared/types.js';
import { Store } from '../store.js';
import { AppError } from '../validation.js';
import { ConnectorError, type Connector, type MutationResult } from '../connectors/connector.js';
import {
  activeCampaignDailyBudgetCents,
  activePortfolioDailyBudgetCents,
  analyzeAccount,
  dedupeProposals,
  isOpen,
  OPEN_STATUSES,
  portfolioDailyBudgetLimit,
  rankProposals,
} from './policy.js';
import { bookCommitmentBlocker } from '../books.js';
import { syncAccount } from './sync.js';
import { accountNow } from './accounts.js';
import { aiProvider } from '../ai/provider.js';
import { reviewSearchTerms } from '../ai/tasks.js';

/**
 * Proposal state machine and execution outbox.
 *
 *   proposed → authorized → reserved → sending → applied
 *                                    ↘ uncertain → (reconcile) applied | failed
 *   proposed | authorized → rejected | cancelled | expired
 *
 * Every transition is recorded on the proposal. An execution attempt row is
 * written before the platform request so a crash between the two cannot hide
 * that a write may have happened.
 */
export function transition(p: Proposal, status: ProposalStatus, note: string, now: Date): Proposal {
  return {
    ...p,
    status,
    updatedAt: now.toISOString(),
    history: [...p.history, { at: now.toISOString(), status, note }],
  };
}

export function authorizeProposal(
  store: Store,
  account: AdAccount,
  id: string,
  by: 'operator' | 'policy',
  now = new Date(),
): Proposal {
  return store.transaction(() => {
    const p = store.proposal(account.dataset, id);
    if (p.accountId !== account.id) throw new AppError('Proposal belongs to another account.');
    if (p.status !== 'proposed')
      throw new AppError(`A ${p.status} proposal cannot be authorized.`, 409);
    if (account.policy.mode === 'observe')
      throw new AppError(
        'This account is in observe mode. Switch to recommend, supervised, or bounded to authorize changes.',
      );
    if (p.policyVersion !== account.policy.version)
      throw new AppError(
        'The policy changed. Generate and review a new proposal before authorizing it.',
      );
    if (Date.parse(p.expiresAt) < now.getTime()) {
      store.saveProposal(transition(p, 'expired', 'Evidence expired before authorization.', now));
      throw new AppError('This proposal expired. Run the brain again for fresh evidence.', 409);
    }
    if (by === 'policy' && p.needsReview)
      throw new AppError('This proposal requires operator review.');
    const next = transition(
      { ...p, authorization: { by, at: now.toISOString(), policyVersion: account.policy.version } },
      'authorized',
      by === 'operator'
        ? 'Authorized by the operator.'
        : `Authorized by bounded policy ${account.policy.version}.`,
      now,
    );
    store.saveProposal(next);
    store.activity(
      account.dataset,
      'decision',
      'Change authorized',
      `${p.campaignName}: ${p.title} (${by}). Not sent yet.`,
    );
    return next;
  });
}

export function rejectProposal(
  store: Store,
  account: AdAccount,
  id: string,
  reason: string,
  now = new Date(),
): Proposal {
  return store.transaction(() => {
    const p = store.proposal(account.dataset, id);
    if (p.accountId !== account.id) throw new AppError('Proposal belongs to another account.');
    if (!['proposed', 'authorized'].includes(p.status))
      throw new AppError(`A ${p.status} proposal cannot be rejected.`, 409);
    const next = transition(p, p.status === 'proposed' ? 'rejected' : 'cancelled', reason, now);
    store.saveProposal(next);
    store.activity(
      account.dataset,
      'decision',
      'Change rejected',
      `${p.campaignName}: ${p.title}. ${reason}`,
    );
    return next;
  });
}

export function setKillSwitch(
  store: Store,
  account: AdAccount,
  on: boolean,
  now = new Date(),
): AdAccount {
  return store.transaction(() => {
    const current = store.account(account.dataset, account.id);
    const next = { ...current, policy: { ...current.policy, killSwitch: on } };
    store.saveAccount(next);
    if (on)
      for (const p of store.accountProposals(account.id, ['authorized', 'reserved']))
        store.saveProposal(transition(p, 'cancelled', 'Kill switch engaged.', now));
    store.activity(
      account.dataset,
      'system',
      on ? 'Kill switch engaged' : 'Kill switch released',
      on
        ? `${account.name}: authorized changes cancelled and execution blocked. In-flight platform requests cannot be recalled.`
        : `${account.name}: execution may resume under the current policy.`,
    );
    return next;
  });
}

/** Reserved and applied commitment for the account on the given UTC day. */
export function committedToday(store: Store, account: AdAccount, day: string): number {
  return (
    store.db
      .prepare(
        "SELECT COALESCE(SUM(json_extract(body,'$.maxCommitmentCents')),0) AS total FROM proposals WHERE account_id=? AND dataset=? AND status IN ('reserved','sending','uncertain','applied') AND substr(json_extract(body,'$.updatedAt'),1,10)=?",
      )
      .get(account.id, account.dataset, day) as { total: number }
  ).total;
}

const budgetIncrease = (proposal: Proposal) =>
  proposal.action.type === 'update-campaign-budget'
    ? Math.max(0, proposal.action.toCents - proposal.action.fromCents)
    : 0;

/** Prevents concurrent budget proposals from exceeding the account's active-budget ceiling. */
export function portfolioBudgetBlocker(
  store: Store,
  account: AdAccount,
  proposal: Proposal,
): string | null {
  const increase = budgetIncrease(proposal);
  if (!increase) return null;
  const snapshot = store.snapshot(account.id);
  if (!snapshot) return 'Synchronize platform budgets before increasing a campaign budget.';
  const inFlight = store
    .accountProposals(account.id, ['reserved', 'sending', 'uncertain'])
    .filter((candidate) => candidate.id !== proposal.id)
    .reduce((sum, candidate) => sum + budgetIncrease(candidate), 0);
  if (
    activePortfolioDailyBudgetCents(snapshot) + inFlight + increase >
    portfolioDailyBudgetLimit(account.policy)
  )
    return 'This increase would exceed the account portfolio daily budget ceiling.';
  return null;
}

type PriorState = Record<string, string | number | null>;
async function currentState(
  connector: Connector,
  p: Proposal,
  campaignId: string,
): Promise<PriorState | null> {
  switch (p.action.type) {
    case 'create-keyword': {
      const keywords = await connector.listKeywords([campaignId]);
      const text = p.action.keywordText.trim().toLowerCase();
      const adGroup = p.action.adGroupExternalId;
      const found = keywords.find(
        (k) =>
          k.adGroupExternalId === adGroup &&
          k.text.trim().toLowerCase() === text &&
          k.matchType === 'exact' &&
          k.state !== 'archived',
      );
      return { exists: found ? 1 : 0, ...(found ? { externalId: found.externalId } : {}) };
    }
    case 'create-negative-keyword': {
      const negatives = await connector.listNegativeKeywords([campaignId]);
      const text = p.action.keywordText.trim().toLowerCase();
      const adGroup = p.action.adGroupExternalId;
      const found = negatives.find(
        (n) =>
          n.adGroupExternalId === adGroup &&
          n.matchType === 'negative-exact' &&
          n.text.trim().toLowerCase() === text &&
          n.state !== 'archived',
      );
      return { exists: found ? 1 : 0, ...(found ? { externalId: found.externalId } : {}) };
    }
    case 'create-product-target': {
      const targets = await connector.listProductTargets([campaignId]);
      const action = p.action;
      const found = targets.find(
        (target) =>
          target.adGroupExternalId === action.adGroupExternalId &&
          target.asin === action.asin &&
          target.state !== 'archived',
      );
      return { exists: found ? 1 : 0, ...(found ? { externalId: found.externalId } : {}) };
    }
    case 'create-negative-product-target': {
      const targets = await connector.listNegativeProductTargets([campaignId]);
      const action = p.action;
      const found = targets.find(
        (target) =>
          target.adGroupExternalId === action.adGroupExternalId &&
          target.asin === action.asin &&
          target.state !== 'archived',
      );
      return { exists: found ? 1 : 0, ...(found ? { externalId: found.externalId } : {}) };
    }
    case 'update-keyword-bid':
    case 'update-keyword-state': {
      const keywords = await connector.listKeywords([campaignId]);
      const id = p.action.keywordExternalId;
      const found = keywords.find((k) => k.externalId === id);
      return found ? { bidCents: found.bidCents, state: found.state } : null;
    }
    case 'update-product-target-bid':
    case 'update-product-target-state': {
      const targets = await connector.listProductTargets([campaignId]);
      const id = p.action.targetExternalId;
      const found = targets.find((target) => target.externalId === id);
      return found?.asin
        ? { bidCents: found.bidCents, state: found.state, asin: found.asin }
        : null;
    }
    case 'update-campaign-budget': {
      const campaigns = await connector.listCampaigns();
      const found = campaigns.find((c) => c.externalId === campaignId);
      return found
        ? {
            dailyBudgetCents: found.dailyBudgetCents,
            state: found.state,
            portfolioDailyBudgetCents: activeCampaignDailyBudgetCents(campaigns),
          }
        : null;
    }
  }
}
function matches(expected: PriorState, actual: PriorState | null): boolean {
  if (!actual) return false;
  return Object.entries(expected).every(([k, v]) => actual[k] === v);
}
function intended(p: Proposal): PriorState {
  switch (p.action.type) {
    case 'create-keyword':
    case 'create-negative-keyword':
    case 'create-product-target':
    case 'create-negative-product-target':
      return { exists: 1 };
    case 'update-keyword-bid':
      return { bidCents: p.action.toCents };
    case 'update-keyword-state':
      return { state: p.action.to };
    case 'update-product-target-bid':
      return { bidCents: p.action.toCents };
    case 'update-product-target-state':
      return { state: p.action.to };
    case 'update-campaign-budget':
      return { dailyBudgetCents: p.action.toCents };
  }
}
async function send(
  connector: Connector,
  p: Proposal,
  link: { externalCampaignId: string },
): Promise<MutationResult> {
  let results: MutationResult[];
  switch (p.action.type) {
    case 'create-keyword':
      results = await connector.createKeywords([
        {
          campaignExternalId: link.externalCampaignId,
          adGroupExternalId: p.action.adGroupExternalId,
          text: p.action.keywordText,
          matchType: 'exact',
          bidCents: p.action.bidCents,
        },
      ]);
      break;
    case 'create-negative-keyword':
      results = await connector.createNegativeKeywords([
        {
          campaignExternalId: link.externalCampaignId,
          adGroupExternalId: p.action.adGroupExternalId,
          text: p.action.keywordText,
          matchType: 'negative-exact',
        },
      ]);
      break;
    case 'create-product-target':
      results = await connector.createProductTargets([
        {
          campaignExternalId: link.externalCampaignId,
          adGroupExternalId: p.action.adGroupExternalId,
          asin: p.action.asin,
          bidCents: p.action.bidCents,
        },
      ]);
      break;
    case 'create-negative-product-target':
      results = await connector.createNegativeProductTargets([
        {
          campaignExternalId: link.externalCampaignId,
          adGroupExternalId: p.action.adGroupExternalId,
          asin: p.action.asin,
        },
      ]);
      break;
    case 'update-keyword-bid':
      results = await connector.updateKeywords([
        {
          externalId: p.action.keywordExternalId,
          campaignExternalId: link.externalCampaignId,
          bidCents: p.action.toCents,
        },
      ]);
      break;
    case 'update-keyword-state':
      results = await connector.updateKeywords([
        {
          externalId: p.action.keywordExternalId,
          campaignExternalId: link.externalCampaignId,
          state: p.action.to,
        },
      ]);
      break;
    case 'update-product-target-bid':
      results = await connector.updateProductTargets([
        {
          externalId: p.action.targetExternalId,
          campaignExternalId: link.externalCampaignId,
          bidCents: p.action.toCents,
        },
      ]);
      break;
    case 'update-product-target-state':
      results = await connector.updateProductTargets([
        {
          externalId: p.action.targetExternalId,
          campaignExternalId: link.externalCampaignId,
          state: p.action.to,
        },
      ]);
      break;
    case 'update-campaign-budget':
      results = await connector.updateCampaigns([
        { externalId: p.action.externalCampaignId, dailyBudgetCents: p.action.toCents },
      ]);
      break;
  }
  return (
    results[0] ?? {
      index: 0,
      ok: false,
      code: 'EMPTY',
      message: 'The platform returned no result.',
    }
  );
}

/** Keeps the stored platform snapshot consistent with a confirmed change until the next sync. */
function applyToSnapshot(
  store: Store,
  account: AdAccount,
  p: Proposal,
  campaignExternalId: string,
) {
  const snapshot = store.snapshot(account.id);
  if (!snapshot) return;
  const next: PlatformSnapshot = structuredClone(snapshot);
  next.productTargets ||= [];
  next.negativeProductTargets ||= [];
  const readBackId =
    typeof p.readBack?.externalId === 'string'
      ? p.readBack.externalId
      : `pending-${p.id.slice(0, 8)}`;
  switch (p.action.type) {
    case 'create-keyword':
      if (!next.keywords.some((k) => k.externalId === readBackId))
        next.keywords.push({
          externalId: readBackId,
          campaignExternalId,
          adGroupExternalId: p.action.adGroupExternalId,
          text: p.action.keywordText,
          matchType: 'exact',
          state: 'enabled',
          bidCents: p.action.bidCents,
        });
      break;
    case 'create-negative-keyword':
      if (!next.negatives.some((n) => n.externalId === readBackId))
        next.negatives.push({
          externalId: readBackId,
          campaignExternalId,
          adGroupExternalId: p.action.adGroupExternalId,
          text: p.action.keywordText,
          matchType: 'negative-exact',
          state: 'enabled',
        });
      break;
    case 'create-product-target':
      if (!next.productTargets.some((target) => target.externalId === readBackId))
        next.productTargets.push({
          externalId: readBackId,
          campaignExternalId,
          adGroupExternalId: p.action.adGroupExternalId,
          expressionType: 'manual',
          expression: [{ type: 'ASIN_SAME_AS', value: p.action.asin }],
          label: `ASIN_SAME_AS=${p.action.asin}`,
          asin: p.action.asin,
          state: 'enabled',
          bidCents: p.action.bidCents,
        });
      break;
    case 'create-negative-product-target':
      if (!next.negativeProductTargets.some((target) => target.externalId === readBackId))
        next.negativeProductTargets.push({
          externalId: readBackId,
          campaignExternalId,
          adGroupExternalId: p.action.adGroupExternalId,
          expression: [{ type: 'ASIN_SAME_AS', value: p.action.asin }],
          label: `ASIN_SAME_AS=${p.action.asin}`,
          asin: p.action.asin,
          state: 'enabled',
        });
      break;
    case 'update-keyword-bid': {
      const id = p.action.keywordExternalId;
      const k = next.keywords.find(
        (x) => x.externalId === id && x.campaignExternalId === campaignExternalId,
      );
      if (k) k.bidCents = p.action.toCents;
      break;
    }
    case 'update-keyword-state': {
      const id = p.action.keywordExternalId;
      const k = next.keywords.find(
        (x) => x.externalId === id && x.campaignExternalId === campaignExternalId,
      );
      if (k) k.state = p.action.to;
      break;
    }
    case 'update-product-target-bid': {
      const id = p.action.targetExternalId;
      const target = next.productTargets.find(
        (candidate) =>
          candidate.externalId === id && candidate.campaignExternalId === campaignExternalId,
      );
      if (target) target.bidCents = p.action.toCents;
      break;
    }
    case 'update-product-target-state': {
      const id = p.action.targetExternalId;
      const target = next.productTargets.find(
        (candidate) =>
          candidate.externalId === id && candidate.campaignExternalId === campaignExternalId,
      );
      if (target) target.state = p.action.to;
      break;
    }
    case 'update-campaign-budget': {
      const c = next.campaigns.find((x) => x.externalId === campaignExternalId);
      if (c) c.dailyBudgetCents = p.action.toCents;
      break;
    }
  }
  store.saveSnapshot(account.id, next);
}

export interface ExecutionOutcome {
  proposal: Proposal;
  attempt: ExecutionAttempt | null;
}

/**
 * Executes one authorized proposal: reserve → revalidate → send → read back.
 * Any check that fails leaves a recorded reason instead of a silent skip.
 */
export async function executeProposal(
  store: Store,
  account: AdAccount,
  connector: Connector,
  id: string,
  now = new Date(),
): Promise<ExecutionOutcome> {
  const fail = (p: Proposal, status: ProposalStatus, note: string) => {
    const next = transition(p, status, note, now);
    store.transaction(() => store.saveProposal(next));
    return { proposal: next, attempt: null };
  };
  let p = store.proposal(account.dataset, id);
  if (p.accountId !== account.id) throw new AppError('Proposal belongs to another account.');
  if (p.status === 'uncertain') return reconcileProposal(store, account, connector, id, now);
  if (p.status !== 'authorized')
    throw new AppError(`A ${p.status} proposal cannot be executed.`, 409);
  const policy = store.account(account.dataset, account.id).policy;
  if (policy.killSwitch) return fail(p, 'cancelled', 'Kill switch is engaged.');
  if (
    !p.authorization ||
    p.authorization.policyVersion !== policy.version ||
    p.policyVersion !== policy.version
  )
    return fail(p, 'cancelled', 'The policy changed after review. Generate a new proposal.');
  if (p.authorization.by === 'policy' && !policy.allowedClasses.includes(p.actionClass))
    return fail(p, 'cancelled', 'This action class is no longer allowed by policy.');
  if (policy.mode !== 'supervised' && policy.mode !== 'bounded')
    throw new AppError('Execution requires supervised or bounded mode.');
  if (!connector.writesEnabled)
    throw new AppError('Platform writes are disabled for this connector.', 503);
  if (Date.parse(p.expiresAt) < now.getTime())
    return fail(p, 'expired', 'Evidence expired before execution.');
  if (now.getTime() - Date.parse(p.evidence.observedAt) > policy.maxEvidenceAgeHours * 3_600_000)
    return fail(
      p,
      'cancelled',
      `Evidence is older than ${policy.maxEvidenceAgeHours} hours. Synchronize and re-evaluate.`,
    );
  const link = store.links(account.id).find((l) => l.campaignId === p.campaignId);
  if (!link) return fail(p, 'cancelled', 'The campaign is no longer linked to this account.');

  // Reserve: atomic commitment check inside the write transaction.
  const reserved = store.transaction(() => {
    const fresh = store.proposal(account.dataset, id);
    if (fresh.status !== 'authorized') throw new AppError('Proposal changed while reserving.', 409);
    const today = now.toISOString().slice(0, 10);
    const bookLimit = bookCommitmentBlocker(
      store,
      account,
      fresh,
      accountNow(store, account.dataset, now),
    );
    if (bookLimit) {
      const next = transition(fresh, 'cancelled', bookLimit, now);
      store.saveProposal(next);
      return { ok: false as const, proposal: next };
    }
    const portfolioLimit = portfolioBudgetBlocker(store, { ...account, policy }, fresh);
    if (portfolioLimit) {
      const next = transition(fresh, 'cancelled', portfolioLimit, now);
      store.saveProposal(next);
      return { ok: false as const, proposal: next };
    }
    if (
      committedToday(store, account, today) + fresh.maxCommitmentCents >
      policy.maxDailyCommitmentCents
    ) {
      const next = transition(
        fresh,
        'cancelled',
        'Daily commitment envelope would be exceeded.',
        now,
      );
      store.saveProposal(next);
      return { ok: false as const, proposal: next };
    }
    const next = transition(fresh, 'reserved', 'Commitment reserved.', now);
    store.saveProposal(next);
    return { ok: true as const, proposal: next };
  });
  if (!reserved.ok) return { proposal: reserved.proposal, attempt: null };
  p = reserved.proposal;

  // Revalidate: fresh platform state and fresh evidence direction.
  let actual: PriorState | null;
  try {
    actual = await currentState(connector, p, link.externalCampaignId);
  } catch (error) {
    const note =
      error instanceof ConnectorError ? `${error.kind}: ${error.message}` : 'Platform read failed.';
    return fail(p, 'authorized', `Reservation released; ${note}`);
  }
  if (!matches(p.expectedPriorState, actual))
    return fail(
      p,
      'cancelled',
      `Platform state drifted from the reviewed state (${JSON.stringify(actual)}).`,
    );
  if (
    p.action.type === 'update-campaign-budget' &&
    p.action.toCents > p.action.fromCents &&
    typeof actual?.portfolioDailyBudgetCents === 'number' &&
    actual.portfolioDailyBudgetCents + (p.action.toCents - p.action.fromCents) >
      portfolioDailyBudgetLimit(policy)
  )
    return fail(
      p,
      'cancelled',
      'Live platform budgets now exceed the room under the portfolio daily budget ceiling.',
    );
  const currentAccount = store.account(account.dataset, account.id);
  if (currentAccount.policy.killSwitch || currentAccount.policy.version !== policy.version)
    return fail(p, 'cancelled', 'The account policy changed while checking the platform.');
  const currentProposal = store.proposal(account.dataset, id);
  if (currentProposal.status !== 'reserved') return { proposal: currentProposal, attempt: null };
  const stillProposed = analyzeAccount(
    store,
    { ...store.account(account.dataset, account.id), policy },
    accountNow(store, account.dataset, now),
  )
    .flatMap((a) => a.proposals)
    .some(
      (q) =>
        q.campaignId === p.campaignId &&
        q.targetRef === p.targetRef &&
        q.actionClass === p.actionClass &&
        JSON.stringify(q.action) === JSON.stringify(p.action),
    );
  if (!stillProposed)
    return fail(p, 'cancelled', 'Current evidence no longer supports this change.');

  // Send: outbox row first, then the platform request.
  const attempt: ExecutionAttempt = {
    id: randomUUID(),
    proposalId: p.id,
    accountId: account.id,
    dataset: account.dataset,
    idempotencyKey: p.idempotencyKey,
    startedAt: now.toISOString(),
    finishedAt: null,
    outcome: null,
    note: 'Sending.',
  };
  p = transition(p, 'sending', 'Request sent to the platform.', now);
  store.transaction(() => {
    store.saveExecution(attempt);
    store.saveProposal(p);
  });
  let result: MutationResult;
  try {
    result = await send(connector, p, link);
  } catch (error) {
    const kind = error instanceof ConnectorError ? error.kind : 'unavailable';
    const message = error instanceof ConnectorError ? error.message : 'Platform request failed.';
    if (kind === 'ambiguous' || kind === 'timeout') {
      p = transition(p, 'uncertain', `${kind}: ${message} Read back before retrying.`, now);
      attempt.outcome = 'uncertain';
    } else {
      p = transition(p, 'failed', `${kind}: ${message}`, now);
      attempt.outcome = 'failed';
    }
    attempt.finishedAt = new Date().toISOString();
    attempt.note = p.history.at(-1)!.note;
    store.transaction(() => {
      store.saveExecution(attempt);
      store.saveProposal(p);
      store.activity(
        account.dataset,
        'system',
        'Platform change unresolved',
        `${p.campaignName}: ${p.title}. ${attempt.note}`,
      );
    });
    return { proposal: p, attempt };
  }
  if (!result.ok) {
    p = transition(p, 'failed', `${result.code}: ${result.message}`, now);
    attempt.outcome = 'failed';
  } else {
    // Read back and compare with the intended state.
    let readBack: PriorState | null = null;
    try {
      readBack = await currentState(connector, p, link.externalCampaignId);
    } catch {
      readBack = null;
    }
    if (matches(intended(p), readBack)) {
      p = transition({ ...p, readBack }, 'applied', 'Platform read-back confirms the change.', now);
      attempt.outcome = 'applied';
    } else {
      p = transition(
        { ...p, readBack },
        'uncertain',
        'The platform accepted the request but read-back did not confirm it yet.',
        now,
      );
      attempt.outcome = 'uncertain';
    }
  }
  attempt.finishedAt = new Date().toISOString();
  attempt.note = p.history.at(-1)!.note;
  store.transaction(() => {
    store.saveExecution(attempt);
    store.saveProposal(p);
    if (p.status === 'applied') applyToSnapshot(store, account, p, link.externalCampaignId);
    store.activity(
      account.dataset,
      'decision',
      p.status === 'applied' ? 'Platform change applied' : 'Platform change not confirmed',
      `${p.campaignName}: ${p.title}. ${attempt.note}`,
    );
  });
  return { proposal: p, attempt };
}

export async function reconcileProposal(
  store: Store,
  account: AdAccount,
  connector: Connector,
  id: string,
  now = new Date(),
): Promise<ExecutionOutcome> {
  let p = store.proposal(account.dataset, id);
  if (p.status !== 'uncertain') throw new AppError('Only uncertain proposals are reconciled.', 409);
  const link = store.links(account.id).find((l) => l.campaignId === p.campaignId);
  if (!link) throw new AppError('The campaign is no longer linked to this account.', 409);
  let actual: PriorState | null;
  try {
    actual = await currentState(connector, p, link.externalCampaignId);
  } catch (error) {
    const note = error instanceof ConnectorError ? error.message : 'Platform read failed.';
    throw new AppError(`Reconciliation read failed: ${note}`, 502);
  }
  const attempt: ExecutionAttempt = {
    id: randomUUID(),
    proposalId: p.id,
    accountId: account.id,
    dataset: account.dataset,
    idempotencyKey: p.idempotencyKey,
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    outcome: 'reconciled',
    note: '',
  };
  if (matches(intended(p), actual))
    p = transition(
      { ...p, readBack: actual },
      'applied',
      'Reconciled: the platform shows the intended state.',
      now,
    );
  else if (matches(p.expectedPriorState, actual))
    p = transition(
      { ...p, readBack: actual },
      'failed',
      'Reconciled: the platform still shows the prior state. Re-run the brain to propose again.',
      now,
    );
  else
    p = transition(
      { ...p, readBack: actual },
      'failed',
      `Reconciled: unexpected platform state ${JSON.stringify(actual)}. Review manually.`,
      now,
    );
  attempt.note = p.history.at(-1)!.note;
  store.transaction(() => {
    store.saveExecution(attempt);
    store.saveProposal(p);
    if (p.status === 'applied') applyToSnapshot(store, account, p, link.externalCampaignId);
    store.activity(
      account.dataset,
      'system',
      'Uncertain change reconciled',
      `${p.campaignName}: ${p.title}. ${attempt.note}`,
    );
  });
  return { proposal: p, attempt };
}

export function expireProposals(store: Store, account: AdAccount, now: Date) {
  store.transaction(() => {
    for (const p of store.accountProposals(account.id, ['proposed', 'authorized']))
      if (Date.parse(p.expiresAt) < now.getTime())
        store.saveProposal(transition(p, 'expired', 'Evidence expired.', now));
  });
}

export interface BrainRunSummary {
  sync: { status: string; message: string } | null;
  proposed: number;
  authorized: number;
  executed: { applied: number; uncertain: number; failed: number; cancelled: number };
  reviewedTerms: number;
  notes: string[];
}

/**
 * One full cycle: synchronize, evaluate, review relevance with AI when
 * configured, save new proposals, and in bounded mode authorize and execute
 * the allowed classes within the policy envelope.
 */
const brainRuns = new WeakMap<Store, Map<string, Promise<BrainRunSummary>>>();
export function runBrain(
  store: Store,
  account: AdAccount,
  connector: Connector,
  now = new Date(),
  options: { sync?: boolean; fetcher?: typeof fetch } = {},
): Promise<BrainRunSummary> {
  const active = brainRuns.get(store) || new Map<string, Promise<BrainRunSummary>>();
  brainRuns.set(store, active);
  const existing = active.get(account.id);
  if (existing) return existing;
  const task = cycleBrain(store, account, connector, now, options).finally(() =>
    active.delete(account.id),
  );
  active.set(account.id, task);
  return task;
}

async function cycleBrain(
  store: Store,
  account: AdAccount,
  connector: Connector,
  now = new Date(),
  options: { sync?: boolean; fetcher?: typeof fetch } = {},
): Promise<BrainRunSummary> {
  const summary: BrainRunSummary = {
    sync: null,
    proposed: 0,
    authorized: 0,
    executed: { applied: 0, uncertain: 0, failed: 0, cancelled: 0 },
    reviewedTerms: 0,
    notes: [],
  };
  if (options.sync !== false) {
    const run = await syncAccount(store, account, connector, now);
    summary.sync = { status: run.status, message: run.message };
    if (run.status !== 'ok') {
      summary.notes.push('Evaluation waits for a complete, successful synchronization.');
      return summary;
    }
  }
  account = store.account(account.dataset, account.id);
  const clock = accountNow(store, account.dataset, now);
  expireProposals(store, account, now);
  if (account.policy.mode === 'observe') {
    summary.notes.push('Observe mode synchronized evidence without saving change proposals.');
    return summary;
  }
  let analyses = analyzeAccount(store, account, clock);
  // Optional AI relevance review for terms the policy wants to act on.
  const provider = account.policy.aiReview ? aiProvider(options.fetcher) : null;
  if (provider) {
    for (const analysis of analyses) {
      const candidates = analysis.proposals
        .filter(
          (p) =>
            (p.action.type === 'create-keyword' || p.action.type === 'create-negative-keyword') &&
            !p.relevance,
        )
        .map((p) => p.targetRef.slice(5));
      if (!candidates.length) continue;
      try {
        store.reserveAi(Number(process.env.AI_DAILY_REQUEST_LIMIT || '5') || 5);
        const reviews = await reviewSearchTerms(provider, store, analysis.campaign, candidates);
        summary.reviewedTerms += reviews.size;
      } catch (error) {
        summary.notes.push(
          `AI review skipped for ${analysis.campaign.name}: ${(error as Error).message}`,
        );
      }
    }
    if (summary.reviewedTerms) analyses = analyzeAccount(store, account, clock);
  }
  const fresh = dedupeProposals(
    store,
    account,
    analyses.flatMap((a) => a.proposals),
    now,
  );
  store.transaction(() => {
    for (const p of fresh) store.saveProposal(p);
    if (fresh.length)
      store.activity(
        account.dataset,
        'system',
        'Brain evaluation completed',
        `${account.name}: ${fresh.length} new proposals across ${analyses.length} linked campaigns. Mode: ${account.policy.mode}.`,
      );
  });
  summary.proposed = fresh.length;
  if (account.policy.mode !== 'bounded' || account.policy.killSwitch) return summary;
  const eligible = rankProposals(store.accountProposals(account.id, ['proposed']))
    .filter((p) => !p.needsReview && account.policy.allowedClasses.includes(p.actionClass))
    .slice(0, account.policy.maxActionsPerRun);
  for (const p of eligible) {
    try {
      authorizeProposal(store, account, p.id, 'policy', now);
      summary.authorized += 1;
    } catch (error) {
      summary.notes.push(`${p.title}: ${(error as Error).message}`);
    }
  }
  const authorized = rankProposals(store.accountProposals(account.id, ['authorized']))
    .filter((p) => p.authorization?.by === 'policy')
    .slice(0, account.policy.maxActionsPerRun);
  for (const p of authorized) {
    try {
      const outcome = await executeProposal(store, account, connector, p.id, now);
      const key =
        outcome.proposal.status === 'applied'
          ? 'applied'
          : outcome.proposal.status === 'uncertain'
            ? 'uncertain'
            : outcome.proposal.status === 'failed'
              ? 'failed'
              : 'cancelled';
      summary.executed[key] += 1;
    } catch (error) {
      summary.notes.push(`${p.title}: ${(error as Error).message}`);
    }
  }
  return summary;
}

export const openProposalCount = (
  store: Store,
  dataset: AdAccount['dataset'],
  campaignId: string,
) => store.proposalCount(dataset, campaignId, OPEN_STATUSES);
