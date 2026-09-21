import { describe, expect, it } from 'vitest';
import type { Campaign, Observation } from '../shared/types.js';
import {
  campaignView,
  dayAt,
  decide,
  metrics,
  probabilityAbove,
  sumMetrics,
} from '../server/engine.js';

const now = new Date('2026-09-20T15:00:00Z');
const campaign: Campaign = {
  id: 'book',
  dataset: 'workspace',
  name: 'Book test',
  entityName: 'A sample book',
  accountName: 'Sample client',
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
function rows(count = 40): Observation[] {
  return Array.from({ length: count }, (_, i) => ({
    campaignId: campaign.id,
    date: dayAt(now, -i - 1),
    impressions: 1000,
    clicks: 100,
    orders: 15,
    spendCents: 2500,
    salesCents: 30000,
    refundsCents: 0,
    observedAt: now.toISOString(),
  }));
}

describe('contribution and uncertainty', () => {
  it('detects a loss despite positive retail ROAS', () => {
    const result = metrics(campaign, [
      { ...rows(1)[0], orders: 10, salesCents: 20000, spendCents: 10000 },
    ]);
    expect(result.roas).toBe(2);
    expect(result.contributionCents).toBe(-4000);
    const view = campaignView(campaign, [], 28, now);
    expect(view.breakEvenAcos).toBe(0.3);
    expect(view.breakEvenRoas).toBeCloseTo(3.3333, 4);
  });
  it('subtracts net receipt refunds, and never turns missing economics into zero cost', () => {
    expect(metrics(campaign, [{ ...rows(1)[0], refundsCents: 1000 }]).contributionCents).toBe(5500);
    const unknown = metrics({ ...campaign, economicsVerified: false }, rows(1));
    expect(unknown.contributionCents).toBeNull();
    expect(sumMetrics([metrics(campaign, rows(1)), unknown]).contributionCents).toBeNull();
    expect(metrics(campaign, []).roas).toBeNull();
  });
  it('matches analytic beta tails and symmetric posteriors', () => {
    expect(probabilityAbove(0.05, 0, 0)).toBeCloseTo(0.95 ** 19, 10);
    expect(probabilityAbove(0.1, 0, 100)).toBeCloseTo(0.9 ** 119, 10);
    expect(probabilityAbove(0.5, 50, 82)).toBeCloseTo(0.5, 10);
    expect(probabilityAbove(0, 3, 20)).toBe(1);
    expect(probabilityAbove(1, 3, 20)).toBe(0);
    expect(probabilityAbove(0.07, 900, 10000)).toBeGreaterThan(0.99);
    expect(probabilityAbove(0.12, 900, 10000)).toBeLessThan(0.01);
  });
  it('calculates large report tails in bounded time', () => {
    const start = performance.now();
    expect(probabilityAbove(0.05, 8_000_000, 100_000_000)).toBeGreaterThan(0.99);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('decision policy', () => {
  it('caps a supported increase at 20% and remaining allowance', () => {
    const decision = decide(campaign, rows(), now);
    expect(decision.kind).toBe('scale');
    expect(decision.suggestedDailyBudgetCents).toBe(3600);
    expect(decision.matureClicks).toBe(2600);
    expect(decision.matureThrough).toBe('2026-09-05');
    const constrained = decide({ ...campaign, totalLearningBudgetCents: 103200 }, rows(), now);
    expect(constrained.suggestedDailyBudgetCents).toBe(3200);
  });
  it('excludes late conversions and refuses to manufacture confidence from immature data', () => {
    const result = decide(campaign, rows(14), now);
    expect(result.kind).toBe('hold');
    expect(result.matureClicks).toBe(0);
    expect(result.probabilityProfitable).toBeNull();
  });
  it.each(['economicsVerified', 'trackingVerified', 'supplyReady'] as const)(
    'blocks scaling without %s',
    (key) => {
      expect(decide({ ...campaign, [key]: false }, rows(), now).kind).toBe('repair');
    },
  );
  it('holds on stale, partially refreshed, and missing daily reports', () => {
    const stale = rows().map((r) => ({ ...r, observedAt: '2026-09-16T15:00:00Z' }));
    expect(decide(campaign, stale, now).kind).toBe('repair');
    stale[0].observedAt = now.toISOString();
    expect(decide(campaign, stale, now).blockers.join(' ')).toContain('Re-export mature');
    expect(
      decide(
        campaign,
        rows().filter((_, i) => i !== 5),
        now,
      ).kind,
    ).toBe('repair');
  });
  it('stops at the learning allowance even if observed performance is strong', () => {
    expect(decide({ ...campaign, totalLearningBudgetCents: 100000 }, rows(), now).title).toBe(
      'Learning budget reached',
    );
  });
  it('creates a new evidence fingerprint for changed costs, reporting, or decision day', () => {
    const original = decide(campaign, rows(), now).evidenceId;
    expect(decide({ ...campaign, variableCostCents: 401 }, rows(), now).evidenceId).not.toBe(
      original,
    );
    expect(
      decide(
        campaign,
        rows().map((r) => ({ ...r, orders: r.orders - 1 })),
        now,
      ).evidenceId,
    ).not.toBe(original);
    expect(decide(campaign, rows(), new Date('2026-09-21T15:00:00Z')).evidenceId).not.toBe(
      original,
    );
  });
});
