import { createHash, randomUUID } from 'node:crypto';
import type {
  AccountLink,
  ActionClass,
  AdAccount,
  Campaign,
  Decision,
  Observation,
  PlatformSnapshot,
  Proposal,
  ProposalAction,
  ProposalEvidence,
  SearchTermView,
  TestWave,
} from '../../shared/types.js';
import { Store } from '../store.js';
import { dayAt, decide, metrics, unitContribution } from '../engine.js';
import { bookBlockers, bookCommitmentBlocker, bookViews, productRows } from '../books.js';
import { targetsExceedCampaign } from '../targets.js';
import type { BookView } from '../../shared/books.js';
import type { ReportRow } from '../connectors/connector.js';
import { targetKey } from '../targets.js';
import { holdForOpenWave } from '../waves.js';
import { normalizeTerm } from '../connectors/connector.js';
import { relevanceKey, type RelevanceReview } from '../ai/tasks.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const OPEN_STATUSES = [
  'proposed',
  'authorized',
  'reserved',
  'sending',
  'uncertain',
] as const;
export const isOpen = (status: Proposal['status']) =>
  (OPEN_STATUSES as readonly string[]).includes(status);

export interface CampaignAnalysis {
  campaign: Campaign;
  link: AccountLink;
  decision: Decision;
  terms: SearchTermView[];
  proposals: Proposal[];
  blockers: string[];
}

/** Cell-level economics using the same posterior screen as campaigns. */
function cell(campaign: Campaign, id: string, label: string, rows: Observation[], now: Date) {
  const decision = decide({ ...campaign, id, name: label }, rows, now);
  const mature = metrics(
    campaign,
    rows.filter(
      (r) =>
        r.date <= decision.matureThrough && r.date >= dayAt(now, -56, campaign.reportingTimezone),
    ),
  );
  return { decision, mature };
}

function evidence(
  label: string,
  d: Decision,
  mature: ReturnType<typeof metrics>,
  observedAt: string,
): ProposalEvidence {
  return {
    evidenceId: d.evidenceId,
    sourceLabel: label,
    matureThrough: d.matureThrough,
    matureClicks: d.matureClicks,
    matureOrders: d.matureOrders,
    spendCents: mature.spendCents,
    salesCents: mature.salesCents,
    cpcCents: mature.cpcCents === null ? null : Math.round(mature.cpcCents),
    probabilityProfitable: d.probabilityProfitable,
    affordableCpcCents: d.maxAffordableCpcCents,
    observedAt,
  };
}

const classPriority: Record<ActionClass, number> = {
  negative: 0,
  pause: 1,
  'bid-down': 2,
  'budget-down': 3,
  harvest: 4,
  'bid-up': 5,
  'budget-up': 6,
};

/**
 * Deterministic policy: turns mature keyword and search-term evidence into
 * exact, previewable platform changes with an expected prior state and a
 * maximum daily commitment. Nothing here talks to a platform or a model.
 */
export function analyzeCampaign(
  store: Store,
  account: AdAccount,
  link: AccountLink,
  now: Date,
  days = 28,
  bookContext?: { views: BookView[]; rows: ReportRow[] },
): CampaignAnalysis {
  const campaign = store.campaign(account.dataset, link.campaignId);
  const policy = account.policy;
  const rows = store.observations(campaign.id);
  const snapshot = store.snapshot(account.id);
  const observedAt = rows.length
    ? rows
        .map((r) => r.observedAt)
        .sort()
        .at(-1)!
    : now.toISOString();
  const waves = store.records<TestWave>(account.dataset, 'wave', 200);
  const decision = holdForOpenWave(decide(campaign, rows, now), waves, campaign.id);
  const blockers: string[] = [...decision.blockers];
  if (account.health.status !== 'ok')
    blockers.push('Wait for a complete, successful account synchronization.');
  if (
    account.connector === 'amazon-ads' &&
    (!account.verifiedAt || (campaign.reportingTimezone || 'UTC') !== account.timezone)
  )
    blockers.push('Verify the account identity and reporting timezone.');
  const targets = store.targets(campaign.id);
  const targetRowsById = store.targetRowsForCampaign(campaign.id);
  const termList = store.searchTerms(campaign.id);
  const termRowsById = store.searchTermRowsForCampaign(campaign.id);
  const termsByKeyword = new Map<string, { rows: Observation[] }[]>();
  for (const term of termList) {
    const list = termsByKeyword.get(term.keywordExternalId) || [];
    list.push({ rows: termRowsById.get(term.id) || [] });
    termsByKeyword.set(term.keywordExternalId, list);
  }
  for (const [keyword, terms] of termsByKeyword) {
    if (targetsExceedCampaign(terms, targetRowsById.get(targetKey(campaign.id, keyword)) || [])) {
      blockers.push('Reconcile search-term totals with their parent keyword report.');
      break;
    }
  }
  if (
    targetsExceedCampaign(
      [...targetRowsById.values()].map((rows) => ({ rows })),
      rows,
    )
  )
    blockers.push('Reconcile keyword totals with their campaign report.');
  blockers.push(
    ...bookBlockers(store, account, campaign, link.externalCampaignId, now, bookContext),
  );
  const platformCampaign = snapshot?.campaigns.find(
    (c) => c.externalId === link.externalCampaignId,
  );
  const keywords =
    snapshot?.keywords.filter((k) => k.campaignExternalId === link.externalCampaignId) || [];
  const negatives =
    snapshot?.negatives.filter((n) => n.campaignExternalId === link.externalCampaignId) || [];
  if (!snapshot || !platformCampaign)
    blockers.push('Synchronize the account to capture platform state.');
  const openWave = waves.some((w) => w.campaignId === campaign.id && w.status === 'measuring');
  if (openWave)
    blockers.push('A measurement wave is open; delivery is kept stable until it concludes.');
  const unit = unitContribution(campaign);
  const campaignMature = metrics(
    campaign,
    rows.filter((r) => r.date <= decision.matureThrough),
  );
  const refundPerOrder =
    campaignMature.orders > 0 ? campaignMature.refundsCents / campaignMature.orders : 0;
  const room = unit === null ? null : unit - campaign.targetProfitCents - refundPerOrder;
  const avgDaily = (cellRows: Observation[], pick: (r: Observation) => number) => {
    const recent = cellRows.filter(
      (r) =>
        r.date >= dayAt(now, -14, campaign.reportingTimezone) &&
        r.date < dayAt(now, 0, campaign.reportingTimezone),
    );
    return recent.length ? recent.reduce((s, r) => s + pick(r), 0) / recent.length : 0;
  };
  const proposals: Proposal[] = [];
  const brief = campaign.brief?.trim() || '';
  const exactTexts = new Set(
    keywords
      .filter((k) => k.matchType === 'exact' && k.state !== 'archived')
      .map((k) => normalizeTerm(k.text)),
  );
  const negativeTexts = new Set(
    negatives.filter((n) => n.state !== 'archived').map((n) => normalizeTerm(n.text)),
  );
  const make = (
    actionClass: ActionClass,
    action: ProposalAction,
    targetRef: string,
    title: string,
    reason: string,
    ev: ProposalEvidence,
    expectedPriorState: Proposal['expectedPriorState'],
    maxCommitmentCents: number,
    relevance: RelevanceReview | null,
    needsReview: boolean,
  ): Proposal => ({
    id: randomUUID(),
    dataset: account.dataset,
    accountId: account.id,
    campaignId: campaign.id,
    campaignName: campaign.name,
    actionClass,
    action,
    targetRef,
    title,
    reason,
    evidence: ev,
    expectedPriorState,
    maxCommitmentCents: Math.max(0, Math.round(maxCommitmentCents)),
    status: 'proposed',
    needsReview,
    relevance,
    policyVersion: policy.version,
    idempotencyKey: hash([
      account.id,
      policy.version,
      campaign.id,
      action.type,
      targetRef,
      expectedPriorState,
      ev.evidenceId,
    ]),
    authorization: null,
    readBack: null,
    history: [
      { at: now.toISOString(), status: 'proposed', note: 'Generated by the policy engine.' },
    ],
    expiresAt: new Date(now.getTime() + 72 * 3_600_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  const gated = blockers.length > 0 || decision.kind === 'repair' || room === null || room <= 0;

  // ---- Campaign budget ------------------------------------------------------
  if (!gated && platformCampaign && platformCampaign.state === 'enabled') {
    const from = platformCampaign.dailyBudgetCents;
    if (decision.kind === 'scale' && decision.suggestedDailyBudgetCents) {
      const to = Math.min(
        decision.suggestedDailyBudgetCents,
        policy.maxDailyBudgetCents,
        Math.floor(from * (1 + policy.maxBidStepPct / 100)),
        Math.floor(from * (1 + policy.maxBudgetStepPct / 100)),
      );
      if (to > from)
        proposals.push(
          make(
            'budget-up',
            {
              type: 'update-campaign-budget',
              externalCampaignId: link.externalCampaignId,
              fromCents: from,
              toCents: to,
            },
            `campaign:${link.externalCampaignId}`,
            `Raise the daily budget to ${(to / 100).toFixed(2)}`,
            `${decision.reason} The step is capped by the policy and the remaining learning allowance.`,
            evidence(campaign.name, decision, campaignMature, observedAt),
            { dailyBudgetCents: from, state: platformCampaign.state },
            to - from,
            null,
            false,
          ),
        );
    } else if (decision.kind === 'reduce' && decision.title === 'Reduce wasted spend') {
      const to = Math.max(100, Math.floor(from * (1 - policy.maxBudgetStepPct / 100)));
      if (to < from)
        proposals.push(
          make(
            'budget-down',
            {
              type: 'update-campaign-budget',
              externalCampaignId: link.externalCampaignId,
              fromCents: from,
              toCents: to,
            },
            `campaign:${link.externalCampaignId}`,
            `Lower the daily budget to ${(to / 100).toFixed(2)}`,
            decision.reason,
            evidence(campaign.name, decision, campaignMature, observedAt),
            { dailyBudgetCents: from, state: platformCampaign.state },
            0,
            null,
            false,
          ),
        );
    }
  }

  // ---- Keyword bids and pauses ---------------------------------------------
  for (const keyword of keywords) {
    if (keyword.state !== 'enabled') continue;
    const target = targets.find((t) => t.id === targetKey(campaign.id, keyword.externalId));
    if (!target) continue;
    const cellRows = targetRowsById.get(target.id) || [];
    const { decision: d, mature } = cell(campaign, target.id, keyword.text, cellRows, now);
    if (gated || d.kind === 'repair' || d.matureClicks < policy.bidMinClicks) continue;
    const ev = evidence(`${keyword.text} · ${keyword.matchType}`, d, mature, observedAt);
    const prior = { bidCents: keyword.bidCents, state: keyword.state };
    const ref = `keyword:${keyword.externalId}`;
    const affordable = d.maxAffordableCpcCents;
    const dailyClicks = avgDaily(cellRows, (r) => r.clicks);
    if (d.kind === 'scale' && affordable !== null && affordable > keyword.bidCents) {
      const to = clamp(
        Math.min(affordable, Math.floor(keyword.bidCents * (1 + policy.maxBidStepPct / 100))),
        2,
        policy.maxBidCents,
      );
      if (to > keyword.bidCents)
        proposals.push(
          make(
            'bid-up',
            {
              type: 'update-keyword-bid',
              keywordExternalId: keyword.externalId,
              fromCents: keyword.bidCents,
              toCents: to,
            },
            ref,
            `Raise the bid on “${keyword.text}” to ${(to / 100).toFixed(2)}`,
            'Mature clicks show a high modeled chance of profitable acquisition below the affordable CPC. The step is capped by the policy.',
            ev,
            prior,
            (to - keyword.bidCents) * dailyClicks,
            null,
            false,
          ),
        );
    } else if (
      d.kind === 'reduce' ||
      (d.probabilityProfitable !== null &&
        d.probabilityProfitable < 0.3 &&
        affordable !== null &&
        affordable < keyword.bidCents)
    ) {
      if (d.matureOrders === 0 && room !== null && mature.spendCents >= room * 3) {
        proposals.push(
          make(
            'pause',
            {
              type: 'update-keyword-state',
              keywordExternalId: keyword.externalId,
              from: keyword.state,
              to: 'paused',
            },
            ref,
            `Pause “${keyword.text}”`,
            'Mature clicks have produced no purchases and the spend already exceeds three acquisition allowances.',
            ev,
            prior,
            0,
            null,
            false,
          ),
        );
        continue;
      }
      const floor = Math.floor(keyword.bidCents * (1 - policy.maxBidStepPct / 100));
      const to = clamp(Math.max(floor, affordable ?? floor), 2, policy.maxBidCents);
      if (to < keyword.bidCents)
        proposals.push(
          make(
            'bid-down',
            {
              type: 'update-keyword-bid',
              keywordExternalId: keyword.externalId,
              fromCents: keyword.bidCents,
              toCents: to,
            },
            ref,
            `Lower the bid on “${keyword.text}” to ${(to / 100).toFixed(2)}`,
            'The observed CPC exceeds the affordable CPC for this keyword’s conversion rate. Moving toward the affordable level preserves the learning allowance.',
            ev,
            prior,
            0,
            null,
            false,
          ),
        );
    }
  }

  // ---- Search terms ---------------------------------------------------------
  const terms: SearchTermView[] = [];
  for (const term of termList) {
    const termRows = termRowsById.get(term.id) || [];
    if (!termRows.length) continue;
    const { decision: d, mature } = cell(campaign, term.id, term.term, termRows, now);
    const cached = store.aiReview<RelevanceReview>(relevanceKey(campaign.id, term.term, brief));
    const keyword = keywords.find((k) => k.externalId === term.keywordExternalId);
    const view: SearchTermView = {
      ...term,
      campaignName: campaign.name,
      metrics: metrics(
        campaign,
        termRows.filter(
          (r) =>
            r.date >= dayAt(now, -days, campaign.reportingTimezone) &&
            r.date < dayAt(now, 0, campaign.reportingTimezone),
        ),
      ),
      mature: {
        clicks: mature.clicks,
        orders: mature.orders,
        spendCents: mature.spendCents,
        salesCents: mature.salesCents,
      },
      probabilityProfitable: d.probabilityProfitable,
      affordableCpcCents: d.maxAffordableCpcCents,
      signal: 'hold',
      reason: 'Keep collecting evidence.',
      relevance: cached,
    };
    const text = normalizeTerm(term.term);
    if (text === '*') {
      view.signal = 'blocked';
      view.reason = 'Amazon used a placeholder because no customer search term was available.';
    } else if (negativeTexts.has(text)) {
      view.signal = 'blocked';
      view.reason = 'Already excluded by a negative keyword.';
    } else if (exactTexts.has(text)) {
      view.signal = 'already-exact';
      view.reason = 'An exact keyword already targets this term.';
    } else if (gated || d.kind === 'repair') {
      view.signal = 'blocked';
      view.reason = blockers[0] || d.reason;
    } else if (
      d.matureClicks >= policy.harvestMinClicks &&
      d.matureOrders >= policy.harvestMinOrders &&
      (d.probabilityProfitable ?? 0) >= 0.6 &&
      term.matchType !== 'exact'
    ) {
      view.signal = 'harvest';
      view.reason =
        'Mature purchases support an exact-match keyword so bids and search share can be controlled directly.';
      const cpc = mature.cpcCents ?? 0;
      const bid = clamp(
        Math.floor(
          Math.min(d.maxAffordableCpcCents ?? cpc, cpc * 1.1 || (keyword?.bidCents ?? 40)),
        ),
        2,
        policy.maxBidCents,
      );
      const needsReview = !cached || cached.level === 'low' || cached.level === 'irrelevant';
      proposals.push(
        make(
          'harvest',
          {
            type: 'create-keyword',
            adGroupExternalId: term.adGroupExternalId,
            keywordText: term.term,
            matchType: 'exact',
            bidCents: bid,
          },
          `term:${text}`,
          `Harvest “${term.term}” as an exact keyword`,
          `${view.reason} Source: ${term.keywordText} (${term.matchType}).`,
          evidence(`${term.term} · search term`, d, mature, observedAt),
          { exists: 0 },
          avgDaily(termRows, (r) => r.spendCents),
          cached,
          needsReview,
        ),
      );
    } else if (
      d.matureClicks >= policy.negativeMinClicks &&
      d.matureOrders === 0 &&
      (d.probabilityProfitable ?? 1) <= policy.negativeMaxProbability &&
      room !== null &&
      mature.spendCents >= room
    ) {
      view.signal = 'negative';
      view.reason =
        'Mature clicks with no purchases and spend beyond one acquisition allowance. Exclude the term unless it is clearly relevant.';
      proposals.push(
        make(
          'negative',
          {
            type: 'create-negative-keyword',
            adGroupExternalId: term.adGroupExternalId,
            keywordText: term.term,
            matchType: 'negative-exact',
          },
          `term:${text}`,
          `Exclude “${term.term}”`,
          `${view.reason} Source: ${term.keywordText} (${term.matchType}).`,
          evidence(`${term.term} · search term`, d, mature, observedAt),
          { exists: 0 },
          0,
          cached,
          cached?.level === 'high',
        ),
      );
    } else view.reason = d.reason;
    terms.push(view);
  }
  terms.sort((a, b) => b.metrics.spendCents - a.metrics.spendCents);
  proposals.sort(
    (a, b) =>
      classPriority[a.actionClass] - classPriority[b.actionClass] ||
      b.evidence.spendCents - a.evidence.spendCents,
  );
  return {
    campaign,
    link,
    decision,
    terms,
    proposals: proposals.filter(
      (p) => !bookCommitmentBlocker(store, account, p, now, bookContext?.views, false),
    ),
    blockers: [...new Set(blockers)],
  };
}

/** Removes proposals that duplicate open work or fall inside a cooldown, and applies the per-run cap. */
export function dedupeProposals(
  store: Store,
  account: AdAccount,
  fresh: Proposal[],
  now: Date,
): Proposal[] {
  const open = store.accountProposals(account.id, OPEN_STATUSES);
  const applied = store.accountProposals(account.id, ['applied']);
  const cooldownMs = account.policy.cooldownHours * 3_600_000;
  const kept: Proposal[] = [];
  for (const p of fresh) {
    if (store.proposalByKey(p.idempotencyKey)) continue;
    const alreadyOpen = open.some(
      (e) => e.campaignId === p.campaignId && e.targetRef === p.targetRef && isOpen(e.status),
    );
    if (alreadyOpen) continue;
    const recent = applied.some(
      (e) =>
        e.campaignId === p.campaignId &&
        e.targetRef === p.targetRef &&
        e.status === 'applied' &&
        now.getTime() - Date.parse(e.updatedAt) < cooldownMs,
    );
    if (recent) continue;
    kept.push(p);
    if (kept.length >= account.policy.maxActionsPerRun) break;
  }
  return kept;
}

export function analyzeAccount(
  store: Store,
  account: AdAccount,
  now: Date,
  days = 28,
): CampaignAnalysis[] {
  const bookContext =
    account.connector === 'amazon-ads'
      ? { views: bookViews(store, account.dataset, 56, now), rows: productRows(store, account.id) }
      : undefined;
  return store
    .links(account.id)
    .filter((l) => {
      try {
        return store.campaign(account.dataset, l.campaignId).dataset === account.dataset;
      } catch {
        return false;
      }
    })
    .map((link) => analyzeCampaign(store, account, link, now, days, bookContext));
}

export const snapshotFor = (store: Store, account: AdAccount): PlatformSnapshot | null =>
  store.snapshot(account.id);
