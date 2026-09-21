import type { Experiment, TestWave } from '../shared/types.js';
import { dayAt } from './engine.js';
import { Store } from './store.js';
import { evaluateWave, recordLearning, registerWave } from './waves.js';

// Illustrative mappings and outcomes only. Existing business data is never touched.
export function seedWaves(store: Store) {
  const now = store.reportingTime('demo');
  for (const [campaignId, name] of [
    ['demo-indicators', 'Detail opening vs. lifestyle'],
    ['demo-atlas', 'Reader intent discovery'],
  ]) {
    const experimentId = `demo-wave-${campaignId}`;
    if (store.records<TestWave>('demo', 'wave', 200).some((w) => w.experimentId === experimentId))
      continue;
    const targets = store.targets(campaignId);
    if (targets.length < 3) continue;
    const campaign = store.campaign('demo', campaignId);
    const challenger = targets.find((t) => t.sourceId === 'sample-cell-1')!;
    const baseline = targets.find((t) => t.sourceId === 'sample-cell-3')!;
    const variable = campaign.vertical === 'books' ? 'keyword' : 'hook';
    const experiment: Experiment = {
      id: experimentId,
      dataset: 'demo',
      campaignId,
      name: `${name} · measured library`,
      hypothesis:
        'A specific, relevant opening or reader-intent target may improve contribution per click compared with the broader baseline.',
      variable,
      budgetCents: 300000,
      maxConcurrent: 2,
      status: 'review',
      provider: 'structured-planner',
      createdAt: dayAt(now, -40) + 'T12:00:00Z',
      variants: [challenger, targets.find((t) => t.sourceId === 'sample-cell-2')!].map((t, i) => ({
        id: `v-${i + 1}`,
        label: t.label,
        value: `${t.label}${t.kind === 'keyword' ? ` · ${t.matchType}` : ''}`,
        hypothesis: 'This focused candidate may improve contribution per click.',
        variable,
        state: i === 0 ? 'shortlisted' : 'queued',
      })),
    };
    store.transaction(() => {
      store.putRecord('experiment', experiment);
      const wave = registerWave(
        store,
        {
          dataset: 'demo',
          experimentId,
          name,
          registration: 'retrospective',
          mappingVerified: true,
          startDate: dayAt(now, -35),
          endDate: dayAt(now, -22),
          budgetCents: 200000,
          lossLimitCents: 100000,
          minClicksPerArm: 100,
          minLiftCentsPer100Clicks: 500,
          arms: [
            { ...baseline, variantId: null, role: 'baseline' },
            { ...challenger, variantId: 'v-1', role: 'challenger' },
          ],
        },
        now,
      );
      const result = evaluateWave(store, wave, now);
      if (campaign.vertical === 'commerce' && result.canRecord)
        recordLearning(
          store,
          wave,
          result.evidenceId,
          'Synthetic demonstration: retain the observed difference and test the opening with a stable audience and controlled delivery before increasing spend.',
        );
    });
  }
}
