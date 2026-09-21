import { createHash } from 'node:crypto';
import type { Campaign, CampaignView, Decision, Metrics, Observation } from '../shared/types.js';

const DAY = 86_400_000;
export const dayAt = (now: Date, offset = 0) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offset * DAY)
    .toISOString()
    .slice(0, 10);
export const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
export const unitContribution = (c: Campaign) =>
  c.economicsVerified ? c.netReceiptCents - c.variableCostCents : null;

export function metrics(campaign: Campaign, rows: Observation[]): Metrics {
  const sums = rows.reduce(
    (m, r) => ({
      impressions: m.impressions + r.impressions,
      clicks: m.clicks + r.clicks,
      orders: m.orders + r.orders,
      spendCents: m.spendCents + r.spendCents,
      salesCents: m.salesCents + r.salesCents,
      refundsCents: m.refundsCents + r.refundsCents,
    }),
    { impressions: 0, clicks: 0, orders: 0, spendCents: 0, salesCents: 0, refundsCents: 0 },
  );
  const unit = unitContribution(campaign);
  // This is a unit-economics estimate, never reconciled business profit. Refunds
  // are reductions to the operator's net receipts, not retail return values.
  return {
    ...sums,
    contributionCents:
      unit === null ? null : sums.orders * unit - sums.refundsCents - sums.spendCents,
    roas: ratio(sums.salesCents, sums.spendCents),
    acos: ratio(sums.spendCents, sums.salesCents),
    cpcCents: ratio(sums.spendCents, sums.clicks),
    cpaCents: ratio(sums.spendCents, sums.orders),
  };
}

export function sumMetrics(items: Metrics[]): Metrics {
  const sums = items.reduce(
    (a, b) => ({
      impressions: a.impressions + b.impressions,
      clicks: a.clicks + b.clicks,
      orders: a.orders + b.orders,
      spendCents: a.spendCents + b.spendCents,
      salesCents: a.salesCents + b.salesCents,
      refundsCents: a.refundsCents + b.refundsCents,
      contributionCents:
        a.contributionCents === null || b.contributionCents === null
          ? null
          : a.contributionCents + b.contributionCents,
    }),
    {
      impressions: 0,
      clicks: 0,
      orders: 0,
      spendCents: 0,
      salesCents: 0,
      refundsCents: 0,
      contributionCents: 0 as number | null,
    },
  );
  return {
    ...sums,
    roas: ratio(sums.salesCents, sums.spendCents),
    acos: ratio(sums.spendCents, sums.salesCents),
    cpcCents: ratio(sums.spendCents, sums.clicks),
    cpaCents: ratio(sums.spendCents, sums.orders),
  };
}

// Lanczos log-gamma and a bounded continued fraction for the incomplete beta.
// Cost does not grow with the number of imported conversions.
function logGamma(x: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  const z = x - 1;
  let sum = 0.9999999999998099;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i] / (z + i + 1);
  const t = z + 7.5;
  return 0.9189385332046727 + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  const bound = (v: number) => (Math.abs(v) < tiny ? tiny : v);
  let c = 1,
    d = 1 / bound(1 - ((a + b) * x) / (a + 1)),
    h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 / bound(1 + aa * d);
    c = bound(1 + aa / c);
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 / bound(1 + aa * d);
    c = bound(1 + aa / c);
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-12) return h;
  }
  // Fail closed instead of returning an unconverged probability.
  throw new Error('Posterior calculation did not converge.');
}

// Prior Beta(1,19) encodes an explicit 5% conversion baseline with 20 pseudo-clicks.
export function probabilityAbove(threshold: number, successes: number, trials: number): number {
  if (threshold <= 0) return 1;
  if (threshold >= 1) return 0;
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(trials) ||
    successes < 0 ||
    trials < successes
  )
    throw new Error('Invalid Bernoulli observations.');
  const a = successes + 1,
    b = trials - successes + 19,
    x = threshold;
  const factor = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  );
  const probability =
    x < (a + 1) / (a + b + 2)
      ? 1 - (factor * betaFraction(a, b, x)) / a
      : (factor * betaFraction(b, a, 1 - x)) / b;
  return Math.max(0, Math.min(1, probability));
}

export function decide(c: Campaign, allRows: Observation[], now = new Date()): Decision {
  const today = dayAt(now);
  const rows = allRows
    .filter((r) => r.date >= dayAt(now, -56) && r.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
  // Exclude the last attributionDays complete click cohorts, plus today's partial cohort.
  const matureThrough = dayAt(now, -c.attributionDays - 1);
  const mature = rows.filter((r) => r.date <= matureThrough);
  const m = metrics(c, mature);
  const unit = unitContribution(c);
  const refundPerOrder = m.orders > 0 ? m.refundsCents / m.orders : 0;
  const afterReserve = (unit ?? 0) - c.targetProfitCents - refundPerOrder;
  const probability =
    m.clicks > 0 && m.cpcCents !== null && afterReserve > 0
      ? probabilityAbove(m.cpcCents / afterReserve, m.orders, m.clicks)
      : null;
  const affordable =
    afterReserve > 0 && m.clicks > 0
      ? Math.floor((afterReserve * (m.orders + 1)) / (m.clicks + 20))
      : null;
  const evidenceId = createHash('sha256')
    .update(JSON.stringify({ c, rows, today, engine: 'v1' }))
    .digest('hex');
  const base: Decision = {
    kind: 'hold',
    title: 'Keep collecting evidence',
    reason: '',
    blockers: [],
    probabilityProfitable: probability,
    suggestedDailyBudgetCents: null,
    maxAffordableCpcCents: affordable,
    matureClicks: m.clicks,
    matureOrders: m.orders,
    matureThrough,
    evidenceId,
  };
  if (c.status === 'paused')
    return {
      ...base,
      title: 'Observation paused',
      reason: 'This local campaign is paused. Platform state is managed separately.',
    };
  if (!c.economicsVerified)
    base.blockers.push('Verify net receipts, variable costs, and your profit reserve.');
  if (!c.trackingVerified)
    base.blockers.push('Verify click attribution and the reporting contract.');
  if (!c.supplyReady)
    base.blockers.push(
      c.vertical === 'books'
        ? 'Confirm title availability and advertising eligibility.'
        : 'Confirm inventory, fulfillment, and product evidence.',
    );
  if (!rows.length) base.blockers.push('Import a daily performance report.');
  else {
    const latestRefresh = Math.max(...rows.map((r) => Date.parse(r.observedAt)));
    if (!Number.isFinite(latestRefresh) || now.getTime() - latestRefresh > 48 * 3_600_000)
      base.blockers.push('Refresh reports; the latest export is over 48 hours old.');
    // Complete date coverage prevents partial reports masquerading as fresh evidence.
    const dates = new Set(rows.map((r) => r.date));
    for (let date = rows[0].date; date < today; date = dayAt(new Date(`${date}T00:00:00Z`), 1)) {
      if (!dates.has(date)) {
        base.blockers.push(
          'Daily report coverage has gaps; import explicit zero rows for days without delivery.',
        );
        break;
      }
    }
    if (mature.some((r) => now.getTime() - Date.parse(r.observedAt) > 48 * 3_600_000))
      base.blockers.push('Re-export mature cohorts so delayed conversions are included.');
  }
  if (base.blockers.length)
    return { ...base, kind: 'repair', title: 'Close the evidence gaps', reason: base.blockers[0] };
  if (afterReserve <= 0)
    return {
      ...base,
      kind: 'reduce',
      title: 'Review the unit economics',
      reason: 'Net contribution leaves no room for acquisition after the profit reserve.',
    };
  const totalSpent = allRows.reduce((sum, r) => sum + r.spendCents, 0);
  if (totalSpent >= c.totalLearningBudgetCents)
    return {
      ...base,
      kind: 'reduce',
      title: 'Learning budget reached',
      reason:
        'The recorded spend has reached the total learning allowance. Review before allocating more.',
    };
  if (mature.length < 7 || m.clicks < 100)
    return {
      ...base,
      title: 'Let the test mature',
      reason:
        'Wait for at least 7 mature reporting days and 100 clicks. These are screening floors, not proof of a winner.',
    };
  if (probability !== null && probability < 0.1 && m.spendCents > Math.max(2500, afterReserve * 3))
    return {
      ...base,
      kind: 'reduce',
      title: 'Reduce wasted spend',
      reason:
        'Mature clicks show a low modeled chance of covering acquisition costs. Review weak targets and preserve the remaining learning budget.',
    };
  if (
    probability !== null &&
    probability >= 0.95 &&
    m.orders >= 20 &&
    (m.contributionCents ?? 0) > 0
  ) {
    const next = Math.min(
      Math.floor(c.dailyBudgetCents * 1.2),
      c.totalLearningBudgetCents - totalSpent,
    );
    if (next <= c.dailyBudgetCents)
      return {
        ...base,
        title: 'Preserve the remaining allowance',
        reason:
          'Performance is promising, but the remaining learning budget cannot support a 20% step.',
      };
    return {
      ...base,
      kind: 'scale',
      title: 'Review a measured increase',
      reason:
        'Mature observations support a capped 20% budget proposal. Confirm it in a controlled test; this model does not establish causal lift.',
      suggestedDailyBudgetCents: next,
    };
  }
  return {
    ...base,
    kind: 'explore',
    title: 'Test the next hypothesis',
    reason:
      'Evidence is still mixed. Keep a control and screen one new variable within the existing learning allowance.',
  };
}

export function campaignView(
  c: Campaign,
  rows: Observation[],
  days: number,
  now = new Date(),
): CampaignView {
  const selected = rows.filter((r) => r.date >= dayAt(now, -days) && r.date < dayAt(now));
  const unit = unitContribution(c);
  return {
    ...c,
    metrics: metrics(c, selected),
    decision: decide(c, rows, now),
    unitContributionCents: unit,
    breakEvenAcos: unit !== null && unit > 0 ? unit / c.retailPriceCents : null,
    breakEvenRoas: unit !== null && unit > 0 ? c.retailPriceCents / unit : null,
    sparkline: selected.slice(-14).map((r) => metrics(c, [r]).contributionCents ?? 0),
  };
}
