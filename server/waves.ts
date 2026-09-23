import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Campaign,
  Dataset,
  Decision,
  Experiment,
  Learning,
  LearningView,
  Observation,
  Target,
  TestWave,
  WaveEvaluation,
  WaveView,
} from '../shared/types.js';
import type { CommerceProductView } from '../shared/commerce.js';
import { dayAt, metrics, probabilityAbove } from './engine.js';
import { Store } from './store.js';
import { targetKey, targetsExceedCampaign } from './targets.js';
import { AppError, datasetSchema, dateOnly } from './validation.js';
import { commerceCampaignBlockers, commerceCampaignViews } from './commerce.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const date = z.string().refine(dateOnly, 'Use a real date in YYYY-MM-DD format.');
const amount = z.number().int().min(1).max(100_000_000);
export const waveInput = z
  .object({
    dataset: datasetSchema,
    experimentId: z.string().min(1).max(160),
    name: z.string().trim().min(3).max(160),
    registration: z.enum(['prospective', 'retrospective']),
    mappingVerified: z.literal(true),
    startDate: date,
    endDate: date,
    budgetCents: amount,
    lossLimitCents: amount,
    minClicksPerArm: z.number().int().min(100).max(1_000_000),
    minLiftCentsPer100Clicks: z.number().int().min(0).max(1_000_000),
    arms: z
      .array(
        z
          .object({
            role: z.enum(['baseline', 'challenger']),
            variantId: z.string().max(160).nullable(),
            sourceId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/),
            label: z.string().trim().min(1).max(200),
            kind: z.enum(['keyword', 'product-target', 'creative']),
            matchType: z.enum(['exact', 'phrase', 'broad', 'auto', 'product', 'creative']),
          })
          .strict(),
      )
      .min(2)
      .max(11),
  })
  .strict();
export type WaveInput = z.infer<typeof waveInput>;

const economics = (c: Campaign) => ({
  retail: c.retailPriceCents,
  receipt: c.netReceiptCents,
  cost: c.variableCostCents,
  reserve: c.targetProfitCents,
  verified: c.economicsVerified,
  window: c.attributionDays,
  currency: c.currency,
  timezone: c.reportingTimezone || 'UTC',
  entity: c.entityName,
  channel: c.channel,
});
const inWindow = (wave: Pick<TestWave, 'startDate' | 'endDate'>, rows: Observation[]) =>
  rows.filter((r) => r.date >= wave.startDate && r.date <= wave.endDate);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
export function holdForOpenWave(
  decision: Decision,
  waves: TestWave[],
  campaignId: string,
): Decision {
  const active = waves.filter((w) => w.campaignId === campaignId && w.status === 'measuring');
  if (decision.kind !== 'scale' || !active.length) return decision;
  return {
    ...decision,
    kind: 'hold',
    title: 'Finish the registered test wave',
    reason:
      'Keep delivery stable while a measurement wave is open. Record its outcome or cancel the local plan before reviewing a broader budget increase.',
    suggestedDailyBudgetCents: null,
    evidenceId: hash({ decision: decision.evidenceId, plans: active.map((w) => w.planId).sort() }),
  };
}
export const waveSpend = (store: Store, wave: TestWave) =>
  sum(
    wave.arms.map((a) =>
      sum(inWindow(wave, store.targetRows(a.target.id)).map((r) => r.spendCents)),
    ),
  );

export function registerWave(
  store: Store,
  input: WaveInput,
  now = store.reportingTime(input.dataset),
): TestWave {
  // Call inside BEGIN IMMEDIATE so concurrent plans cannot reserve the same allowance.
  const experiment = store.record<Experiment>(input.dataset, 'experiment', input.experimentId);
  const campaign = store.campaign(input.dataset, experiment.campaignId);
  const today = dayAt(now, 0, campaign.reportingTimezone);
  const duration = (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000 + 1;
  if (duration < 7 || duration > 56) throw new AppError('A wave must cover 7–56 reporting days.');
  if (
    input.startDate < dayAt(now, -730, campaign.reportingTimezone) ||
    input.endDate > dayAt(now, 90, campaign.reportingTimezone)
  )
    throw new AppError('Use a window within the last two years and the next 90 days.');
  if (input.registration === 'prospective' && input.startDate <= today)
    throw new AppError(
      'Register a prospective wave before its first reporting day. Use historical review for an existing test.',
    );
  if (input.registration === 'retrospective' && input.startDate >= today)
    throw new AppError('Historical reviews must begin before today.');
  if (
    !campaign.economicsVerified ||
    !campaign.trackingVerified ||
    !campaign.supplyReady ||
    campaign.status === 'paused'
  )
    throw new AppError(
      'Verify campaign economics, tracking, and availability, and resume local monitoring first.',
    );
  const productBlockers = commerceCampaignBlockers(store, campaign, now);
  if (productBlockers.length) throw new AppError(productBlockers[0]);
  if (input.lossLimitCents > input.budgetCents)
    throw new AppError('The loss boundary cannot exceed the wave budget.');
  if (input.arms.filter((a) => a.role === 'baseline').length !== 1)
    throw new AppError('Choose exactly one baseline and at least one challenger.');
  if (input.arms.length - 1 > experiment.maxConcurrent)
    throw new AppError('This wave exceeds the experiment’s shortlisted challenger limit.');
  if (new Set(input.arms.map((a) => a.sourceId)).size !== input.arms.length)
    throw new AppError('Each arm needs a distinct reporting target ID.');
  const challengerIds = input.arms.filter((a) => a.role === 'challenger').map((a) => a.variantId);
  if (new Set(challengerIds).size !== challengerIds.length)
    throw new AppError('A candidate can appear only once in a wave.');
  const arms = input.arms.map((a) => {
    const candidate = a.variantId ? experiment.variants.find((v) => v.id === a.variantId) : null;
    if (
      (a.role === 'baseline' && a.variantId !== null) ||
      (a.role === 'challenger' && (!candidate || candidate.state !== 'shortlisted'))
    )
      throw new AppError(
        'Map the baseline separately and use shortlisted candidates for challengers.',
      );
    if (
      (campaign.vertical === 'commerce') !== (a.kind === 'creative') ||
      (a.role === 'challenger' && campaign.vertical === 'books' && a.kind !== 'keyword') ||
      (a.kind === 'creative' && a.matchType !== 'creative') ||
      (a.kind === 'product-target' && a.matchType !== 'product') ||
      (a.kind === 'keyword' && !['exact', 'phrase', 'broad', 'auto'].includes(a.matchType))
    )
      throw new AppError(
        'Target kind and match type must match the campaign and report definition.',
      );
    const target: Target = {
      id: targetKey(campaign.id, a.sourceId),
      campaignId: campaign.id,
      sourceId: a.sourceId,
      label: a.label,
      kind: a.kind,
      matchType: a.matchType,
    };
    return { role: a.role, candidate: candidate ? structuredClone(candidate) : null, target };
  });
  const waves = store.records<TestWave>(input.dataset, 'wave', 201);
  if (
    new Set([...store.targets(campaign.id).map((t) => t.id), ...arms.map((a) => a.target.id)])
      .size > 500
  )
    throw new AppError('This campaign has reached the local limit of 500 reporting targets.');
  if (waves.length >= 200)
    throw new AppError('This local release supports 200 test waves per workspace.');
  if (
    waves.some(
      (w) =>
        w.campaignId === campaign.id &&
        w.startDate <= input.endDate &&
        w.endDate >= input.startDate &&
        w.arms.some((a) => arms.some((b) => a.target.id === b.target.id)),
    )
  )
    throw new AppError(
      'A reporting target already belongs to a wave in this date window. Use distinct cells or a later window.',
    );
  const wave: TestWave = {
    id: randomUUID(),
    dataset: input.dataset,
    campaignId: campaign.id,
    experimentId: experiment.id,
    name: input.name,
    hypothesis: experiment.hypothesis,
    registration: input.registration,
    mappingVerified: true,
    startDate: input.startDate,
    endDate: input.endDate,
    budgetCents: input.budgetCents,
    lossLimitCents: input.lossLimitCents,
    minClicksPerArm: input.minClicksPerArm,
    minLiftCentsPer100Clicks: input.minLiftCentsPer100Clicks,
    arms,
    campaignSnapshot: structuredClone(campaign),
    planId: '',
    status: 'measuring',
    createdAt: now.toISOString(),
  };
  wave.planId = hash({ ...wave, planId: undefined, status: undefined });
  const spend = waveSpend(store, wave);
  const outstanding = Math.max(0, wave.budgetCents - spend);
  const campaignRows = store.observations(campaign.id);
  if (
    targetsExceedCampaign(
      store.targets(campaign.id).map((t) => ({ rows: store.targetRows(t.id) })),
      campaignRows,
    )
  )
    throw new AppError(
      'Reconcile target reports against parent campaign totals before reserving a test budget.',
    );
  const campaignSpent = sum(campaignRows.map((r) => r.spendCents));
  const remainingReservations = sum(
    waves
      .filter((w) => w.campaignId === campaign.id && w.status === 'measuring')
      .map((w) => Math.max(0, w.budgetCents - waveSpend(store, w))),
  );
  if (campaignSpent + remainingReservations + outstanding > campaign.totalLearningBudgetCents)
    throw new AppError(
      'The campaign learning allowance cannot cover recorded spend and open wave reservations.',
    );
  const experimentCommitment = sum(
    waves
      .filter((w) => w.experimentId === experiment.id)
      .map((w) => {
        const used = waveSpend(store, w);
        return w.status === 'measuring' ? Math.max(used, w.budgetCents) : used;
      }),
  );
  if (experimentCommitment + Math.max(spend, wave.budgetCents) > experiment.budgetCents)
    throw new AppError(
      'This experiment’s budget is already committed to other waves or measured spend.',
    );
  store.importTargets(arms.map((a) => ({ target: a.target, rows: [] })));
  store.putRecord('wave', wave);
  store.putRecord('experiment', { ...experiment, status: 'review' });
  store.activity(
    input.dataset,
    'experiment',
    'Measurement wave registered',
    `${wave.name}: ${arms.length} arms, ${input.registration}. Local planning reservation only; launch and manage delivery in the advertising console.`,
  );
  return wave;
}

export function betaQuantile(probability: number, orders: number, clicks: number): number {
  let lower = 0,
    upper = 1;
  for (let i = 0; i < 48; i++) {
    const middle = (lower + upper) / 2;
    if (1 - probabilityAbove(middle, orders, clicks) < probability) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

export function evaluateWave(
  store: Store,
  wave: TestWave,
  now = store.reportingTime(wave.dataset),
  campaignViews?: ReadonlyMap<string, CommerceProductView>,
): WaveEvaluation {
  const current = store.campaign(wave.dataset, wave.campaignId);
  const resolvedCommerceViews =
    current.vertical === 'commerce'
      ? (campaignViews ?? commerceCampaignViews(store, wave.dataset, now))
      : undefined;
  const productState = resolvedCommerceViews?.get(current.id) ?? null;
  const snapshot = wave.campaignSnapshot;
  const today = dayAt(now, 0, snapshot.reportingTimezone);
  const through = [
    wave.endDate,
    dayAt(now, -snapshot.attributionDays - 1, snapshot.reportingTimezone),
  ].sort()[0];
  const expected = Math.max(
    0,
    Math.floor(
      (Date.parse([wave.endDate, dayAt(now, -1, snapshot.reportingTimezone)].sort()[0]) -
        Date.parse(wave.startDate)) /
        86_400_000,
    ) + 1,
  );
  const parent = inWindow(wave, store.observations(wave.campaignId)).filter((r) => r.date < today);
  const sources = wave.arms.map((arm) => ({
    arm,
    rows: inWindow(wave, store.targetRows(arm.target.id)).filter((r) => r.date < today),
  }));
  const blockers: string[] = [];
  if (hash(economics(current)) !== hash(economics(snapshot)))
    blockers.push(
      'Campaign economics or reporting settings changed after this plan was frozen. Create a new plan with the revised assumptions.',
    );
  if (!current.economicsVerified || !current.trackingVerified || !current.supplyReady)
    blockers.push('Verify current campaign economics, tracking, and availability.');
  blockers.push(...commerceCampaignBlockers(store, current, now, resolvedCommerceViews));
  if (current.status === 'paused') blockers.push('Local campaign monitoring is paused.');
  if (expected && parent.length !== expected)
    blockers.push('The parent campaign is missing daily rows in this test window.');
  if (targetsExceedCampaign(sources, parent))
    blockers.push(
      'Mapped arm totals exceed the parent campaign or have no matching parent day. Reconcile the reports.',
    );
  if (
    [...parent, ...sources.flatMap((s) => s.rows)].some(
      (r) => now.getTime() - Date.parse(r.observedAt) > 48 * 3_600_000,
    )
  )
    blockers.push(
      'Refresh campaign and arm reports; every test cohort needs an export from the last 48 hours.',
    );
  const arms = sources.map(({ arm, rows }) => {
    const matureRows = rows.filter((r) => r.date <= through);
    const m = metrics(snapshot, matureRows);
    if (rows.length !== expected)
      blockers.push(
        `${arm.target.label}: ${expected - rows.length} daily rows missing. Include explicit zeros only for confirmed no-delivery days.`,
      );
    const unit =
      snapshot.netReceiptCents -
      snapshot.variableCostCents -
      snapshot.targetProfitCents -
      (m.orders ? m.refundsCents / m.orders : 0);
    const cpc = m.cpcCents;
    const tail = 0.05 / (2 * wave.arms.length);
    if (m.refundsCents > 0 && m.orders === 0)
      blockers.push(
        `${arm.target.label}: mature refunds have no matched purchases. Reconcile the cohort before estimating per-purchase refunds.`,
      );
    const endpoints =
      m.clicks > 0 && cpc !== null
        ? [
            100 * (unit * betaQuantile(tail, m.orders, m.clicks) - cpc),
            100 * (unit * betaQuantile(1 - tail, m.orders, m.clicks) - cpc),
          ]
        : null;
    const band =
      endpoints && cpc !== null
        ? {
            mean: 100 * ((unit * (m.orders + 1)) / (m.clicks + 20) - cpc),
            lower: Math.min(...endpoints),
            upper: Math.max(...endpoints),
          }
        : null;
    return {
      targetId: arm.target.id,
      label: arm.target.label,
      role: arm.role,
      observed: metrics(snapshot, rows),
      mature: m,
      coveredDays: rows.length,
      expectedDays: expected,
      matureDays: matureRows.length,
      probabilityProfitable:
        cpc === null ? null : unit <= 0 ? 0 : probabilityAbove(cpc / unit, m.orders, m.clicks),
      contributionPer100Clicks: band,
    };
  });
  const spentCents = sum(arms.map((a) => a.observed.spendCents));
  const matureLossCents = Math.max(0, -sum(arms.map((a) => a.mature.contributionCents ?? 0)));
  const facts = (rows: Observation[]) => rows.map(({ observedAt: _refresh, ...r }) => r);
  const dataId = hash({
    plan: wave.planId,
    economics: economics(current),
    ...(current.vertical === 'commerce' ? { productState } : {}),
    parent: facts(parent),
    arms: sources.map((s) => ({ target: s.arm.target.id, rows: facts(s.rows) })),
  });
  let outcome: WaveEvaluation['outcome'] = 'collecting';
  let title = 'Let this wave mature';
  let reason =
    'Keep the registered window and candidate definitions fixed. A result is evaluated after the final click cohort matures.';
  let promisingTargetId: string | null = null;
  const mature = through >= wave.endDate;
  if (spentCents >= wave.budgetCents) {
    outcome = 'limit-reached';
    title = 'The wave budget has been reached';
    reason =
      'Review delivery in the advertising console. Orbit has not paused ads. Do not extend the test to chase a result.';
  } else if (blockers.length) {
    outcome = 'repair';
    title = 'Repair the evidence before judging the test';
    reason = blockers[0];
  } else if (matureLossCents >= wave.lossLimitCents) {
    outcome = 'limit-reached';
    title = 'The mature loss boundary has been reached';
    reason =
      'Preserve the remaining allowance and review delivery in the console. Recent conversions may still arrive.';
  } else if (today <= wave.startDate) {
    outcome = 'scheduled';
    title = 'Plan registered; waiting for reporting days';
    reason =
      'Export the setup sheet, configure the mapped cells in your console, and import their daily reports.';
  } else if (mature) {
    outcome = 'inconclusive';
    title = 'No clear separation in this wave';
    reason =
      'The registered window is complete. Keep this as an inconclusive result or register a new hypothesis; do not rename the strongest observed number a winner.';
    if (arms.some((a) => a.mature.clicks < wave.minClicksPerArm || a.matureDays < 7)) {
      title = 'The wave finished with limited evidence';
      reason =
        'At least one arm did not reach the registered click floor and seven mature days. Record the sparse result before planning another wave.';
    } else {
      const baseline = arms.find((a) => a.role === 'baseline')!;
      const challengers = arms.filter((a) => a.role === 'challenger');
      const candidates = challengers
        .filter(
          (a) =>
            a.contributionPer100Clicks &&
            baseline.contributionPer100Clicks &&
            a.mature.orders >= 20 &&
            a.contributionPer100Clicks.lower > 0 &&
            a.contributionPer100Clicks.lower >
              baseline.contributionPer100Clicks.upper + wave.minLiftCentsPer100Clicks,
        )
        .sort((a, b) => b.contributionPer100Clicks!.lower - a.contributionPer100Clicks!.lower);
      if (candidates.length) {
        outcome = 'promising';
        title = 'A candidate is ready for confirmation';
        promisingTargetId = candidates[0].targetId;
        reason =
          'Its conservative modeled contribution band clears zero and the baseline by the registered margin. This observational screen supports a new controlled test, not automatic scaling or a causal claim.';
      } else if (
        arms.every((a) => a.contributionPer100Clicks && a.contributionPer100Clicks.upper < 0)
      ) {
        outcome = 'unprofitable';
        title = 'No arm cleared the contribution hurdle';
        reason =
          'All modeled upper bands remain below the profit-reserve hurdle. Revisit the offer, targeting, or economics before funding another similar wave.';
      } else if (
        baseline.contributionPer100Clicks &&
        baseline.contributionPer100Clicks.lower > 0 &&
        challengers.every(
          (a) =>
            a.contributionPer100Clicks &&
            baseline.contributionPer100Clicks!.lower >
              a.contributionPer100Clicks.upper + wave.minLiftCentsPer100Clicks,
        )
      ) {
        outcome = 'baseline-leading';
        title = 'The baseline remains the stronger candidate';
        reason =
          'The baseline’s conservative band clears every challenger. Retain the finding and choose a different hypothesis for the next wave.';
      }
    }
  }
  const canRecord =
    blockers.length === 0 &&
    ['limit-reached', 'promising', 'baseline-leading', 'unprofitable', 'inconclusive'].includes(
      outcome,
    );
  return {
    evidenceId: hash({ dataId, through, outcome, blockers, status: current.status }),
    dataId,
    evaluatedAt: now.toISOString(),
    matureThrough: through,
    outcome,
    title,
    reason,
    blockers,
    arms,
    spentCents,
    matureLossCents,
    remainingPlanCents:
      wave.status === 'measuring' ? Math.max(0, wave.budgetCents - spentCents) : 0,
    promisingTargetId,
    canRecord,
  };
}

export function getWaveViews(
  store: Store,
  dataset: Dataset,
  campaignViews?: ReadonlyMap<string, CommerceProductView>,
): WaveView[] {
  const now = store.reportingTime(dataset);
  const waves = store.records<TestWave>(dataset, 'wave', 200);
  const resolvedViews =
    campaignViews ??
    (waves.some((wave) => wave.campaignSnapshot.vertical === 'commerce')
      ? commerceCampaignViews(store, dataset, now)
      : undefined);
  return waves.map((wave) => ({
    ...wave,
    evaluation: evaluateWave(store, wave, now, resolvedViews),
  }));
}

export function getLearningViews(
  store: Store,
  dataset: Dataset,
  waves = getWaveViews(store, dataset),
): LearningView[] {
  return store.records<Learning>(dataset, 'learning', 4000).map((l) => {
    const wave = waves.find((w) => w.id === l.waveId);
    return {
      ...l,
      evidenceChanged: !wave || wave.evaluation.dataId !== l.result.dataId,
      superseded: !wave || wave.latestLearningId !== l.id,
    };
  });
}

export function recordLearning(
  store: Store,
  wave: TestWave,
  evidenceId: string,
  notes: string,
): Learning {
  if (wave.status === 'cancelled')
    throw new AppError('A cancelled wave cannot record a conclusion.');
  const result = evaluateWave(store, wave);
  if (result.evidenceId !== evidenceId)
    throw new AppError('Evidence changed. Refresh the wave before recording a conclusion.', 409);
  if (!result.canRecord)
    throw new AppError(
      'The wave is not ready for a conclusion. Resolve its evidence or wait for maturity.',
    );
  if (wave.latestLearningId) {
    const old = store.record<Learning>(wave.dataset, 'learning', wave.latestLearningId);
    if (old.result.evidenceId === evidenceId) return old;
  }
  if (store.records<Learning>(wave.dataset, 'learning', 4001).length >= 4000)
    throw new AppError('The local learning library has reached 4,000 revisions.');
  const learning: Learning = {
    id: randomUUID(),
    dataset: wave.dataset,
    campaignId: wave.campaignId,
    experimentId: wave.experimentId,
    waveId: wave.id,
    waveName: wave.name,
    entityName: wave.campaignSnapshot.entityName,
    vertical: wave.campaignSnapshot.vertical,
    hypothesis: wave.hypothesis,
    notes,
    result,
    promisingCandidate:
      wave.arms.find((a) => a.target.id === result.promisingTargetId)?.candidate ?? null,
    ...(wave.latestLearningId ? { supersedesId: wave.latestLearningId } : {}),
    createdAt: new Date().toISOString(),
  };
  store.putRecord('learning', learning);
  store.putRecord('wave', {
    ...wave,
    status: 'closed',
    latestLearningId: learning.id,
    closedAt: learning.createdAt,
  });
  store.activity(
    wave.dataset,
    'decision',
    'Test learning recorded',
    `${wave.name}: ${result.title}. ${wave.latestLearningId ? 'A new revision preserves the previous finding.' : 'Unused local planning allowance released.'}`,
  );
  return learning;
}
