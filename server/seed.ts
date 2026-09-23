import type { Campaign, Observation } from '../shared/types.js';
import { Store } from './store.js';
import { dayAt } from './engine.js';
import { createExperiment, planVariants } from './planner.js';
import type { ExperimentInput } from './validation.js';
import { targetKey } from './targets.js';
import type { Target } from '../shared/types.js';
import { seedCommerce } from './seed-commerce.js';

// All titles, performance, economics, accounts, and decisions here are synthetic.
// No source project customer or financial data is bundled into this public repository.
export function seedDemo(store: Store, now = new Date()) {
  if (store.campaigns('demo').length) {
    seedTargets(store);
    seedCommerce(store);
    return;
  }
  const specs = [
    {
      id: 'demo-indicators',
      name: 'The details make the drive',
      entityName: 'Sequential indicators',
      vertical: 'commerce',
      channel: 'meta',
      price: 6900,
      receipt: 6900,
      cost: 3050,
      reserve: 600,
      daily: 11000,
      clicks: 152,
      cpc: 48,
      rate: 0.045,
    },
    {
      id: 'demo-wrap',
      name: 'A better daily driver',
      entityName: 'Steering wheel wrap',
      vertical: 'commerce',
      channel: 'tiktok',
      price: 5900,
      receipt: 5900,
      cost: 2600,
      reserve: 500,
      daily: 9000,
      clicks: 135,
      cpc: 43,
      rate: 0.041,
    },
    {
      id: 'demo-frame',
      name: 'Small detail. Big difference.',
      entityName: 'License plate frames',
      vertical: 'commerce',
      channel: 'meta',
      price: 3900,
      receipt: 3900,
      cost: 2180,
      reserve: 400,
      daily: 5500,
      clicks: 100,
      cpc: 66,
      rate: 0.028,
    },
    {
      id: 'demo-atlas',
      name: 'The Quiet Atlas · discovery',
      entityName: 'The Quiet Atlas',
      vertical: 'books',
      channel: 'amazon',
      price: 2495,
      receipt: 1297,
      cost: 420,
      reserve: 150,
      daily: 4000,
      clicks: 74,
      cpc: 32,
      rate: 0.119,
    },
    {
      id: 'demo-home',
      name: 'A Wilder Kind of Home · exact',
      entityName: 'A Wilder Kind of Home',
      vertical: 'books',
      channel: 'amazon',
      price: 1995,
      receipt: 1037,
      cost: 360,
      reserve: 100,
      daily: 3500,
      clicks: 64,
      cpc: 35,
      rate: 0.089,
    },
    {
      id: 'demo-light',
      name: 'The Last Lightkeeper · exploration',
      entityName: 'The Last Lightkeeper',
      vertical: 'books',
      channel: 'amazon',
      price: 1695,
      receipt: 881,
      cost: 340,
      reserve: 100,
      daily: 2500,
      clicks: 61,
      cpc: 48,
      rate: 0.034,
    },
  ] as const;
  store.transaction(() => {
    for (const [index, spec] of specs.entries()) {
      const campaign: Campaign = {
        id: spec.id,
        dataset: 'demo',
        name: spec.name,
        entityName: spec.entityName,
        vertical: spec.vertical,
        channel: spec.channel,
        accountName:
          spec.vertical === 'books' ? 'Pathway · sample publisher' : 'Enthusiast · sample account',
        status: 'observing',
        currency: 'USD',
        retailPriceCents: spec.price,
        netReceiptCents: spec.receipt,
        variableCostCents: spec.cost,
        targetProfitCents: spec.reserve,
        dailyBudgetCents: spec.daily,
        totalLearningBudgetCents: 1_000_000,
        attributionDays: spec.vertical === 'books' ? 14 : 7,
        economicsVerified: true,
        trackingVerified: true,
        supplyReady: true,
        createdAt: new Date(now.getTime() - 60 * 86_400_000).toISOString(),
      };
      store.saveCampaign(campaign);
      let rng = 73 + index * 37;
      const random = () => {
        rng = (rng * 16807) % 2147483647;
        return (rng - 1) / 2147483646;
      };
      const rows: Observation[] = [];
      for (let d = 56; d >= 1; d--) {
        const momentum = 0.8 + (56 - d) / 100;
        const clicks = Math.round(spec.clicks * (0.75 + random() * 0.5) * momentum);
        const orders = Math.max(
          0,
          Math.round(clicks * spec.rate * (0.65 + random() * 0.7) * momentum),
        );
        rows.push({
          campaignId: campaign.id,
          date: dayAt(now, -d),
          clicks,
          orders,
          impressions: clicks * Math.round(30 + random() * 30),
          spendCents: Math.round(clicks * spec.cpc * (0.9 + random() * 0.2)),
          salesCents: orders * spec.price,
          refundsCents: d % 13 === 0 ? spec.receipt : 0,
          observedAt: now.toISOString(),
        });
      }
      store.importRows(rows);
      if (index < 2 || index === 3 || index === 4) {
        const input: ExperimentInput = {
          dataset: 'demo',
          campaignId: campaign.id,
          name:
            spec.vertical === 'books'
              ? `${spec.entityName} · reader discovery`
              : `${spec.entityName} · opening hooks`,
          hypothesis:
            spec.vertical === 'books'
              ? 'Specific reader-intent keywords will produce better contribution per click than broad genre terms.'
              : 'A close-up of the product details will drive more qualified purchase intent than a general lifestyle opening.',
          variable: spec.vertical === 'books' ? 'keyword' : 'hook',
          seedTerms:
            spec.vertical === 'books'
              ? ['nature writing', 'slow living', 'outdoor adventure', 'personal growth']
              : ['the details', 'your daily drive', 'the installation', 'your next upgrade'],
          count: spec.vertical === 'books' ? 72 : 36,
          budgetCents: 30000,
          maxConcurrent: 3,
          provider: 'structured-planner',
        };
        const experiment = createExperiment(
          input,
          campaign,
          planVariants(input),
          new Date(now.getTime() - (index + 1) * 86_400_000),
        );
        experiment.variants.slice(0, 3).forEach((v) => {
          v.state = 'shortlisted';
        });
        store.putRecord('experiment', experiment);
      }
    }
    const activity = [
      [
        'import',
        'Sample reports are ready',
        '56 days of synthetic performance, refreshed for the demo.',
      ],
      [
        'experiment',
        'A new angle to explore',
        '36 product-hook candidates added to the experiment queue.',
      ],
      [
        'system',
        'Two portfolios. One clear picture.',
        'Product and book workflows initialized in the demo workspace.',
      ],
    ] as const;
    activity.forEach(([kind, title, detail], i) =>
      store.activity(
        'demo',
        kind,
        title,
        detail,
        new Date(now.getTime() - (i + 1) * 3_600_000).toISOString(),
      ),
    );
  });
  seedTargets(store);
  seedCommerce(store);
}

function seedTargets(store: Store) {
  store.transaction(() => {
    for (const campaign of store.campaigns('demo')) {
      if (store.targets(campaign.id).length) continue;
      const rows = store.observations(campaign.id);
      const labels =
        campaign.vertical === 'books'
          ? ['nature writing', 'books about slow living', 'outdoor essays']
          : ['Detail-led opening', 'Installation walkthrough', 'Lifestyle context'];
      const split = (value: number, weights: number[]) => [
        Math.floor(value * weights[0]),
        Math.floor(value * weights[1]),
        value - Math.floor(value * weights[0]) - Math.floor(value * weights[1]),
      ];
      const entries = labels.map((label, i) => {
        const sourceId = `sample-cell-${i + 1}`;
        const target: Target = {
          id: targetKey(campaign.id, sourceId),
          campaignId: campaign.id,
          sourceId,
          label,
          kind: campaign.vertical === 'books' ? 'keyword' : 'creative',
          matchType:
            campaign.vertical === 'books' ? (['broad', 'exact', 'phrase'] as const)[i] : 'creative',
        };
        return {
          target,
          rows: rows.map((row) => {
            const orders = split(row.orders, [0.65, 0.25, 0.1])[i];
            return {
              ...row,
              clicks: split(row.clicks, [0.4, 0.35, 0.25])[i],
              impressions: split(row.impressions, [0.4, 0.35, 0.25])[i],
              spendCents: split(row.spendCents, [0.32, 0.35, 0.33])[i],
              refundsCents: split(row.refundsCents, [0.65, 0.25, 0.1])[i],
              orders,
              salesCents: orders * campaign.retailPriceCents,
            };
          }),
        };
      });
      store.importTargets(entries);
    }
  });
}
