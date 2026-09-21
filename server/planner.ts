import { randomUUID } from 'node:crypto';
import type { Campaign, Experiment, Variant } from '../shared/types.js';
import type { ExperimentInput } from './validation.js';
import { AppError } from './validation.js';

const hookFrames = [
  'A closer look at {term}',
  'Before you choose {term}',
  'What to check in {term}',
  'One detail. A different {term}.',
  'The everyday side of {term}',
  'Start with the details: {term}',
  'Inside the process: {term}',
  'Your questions about {term}',
  'From first look to {term}',
  'A practical guide to {term}',
  'Make room for {term}',
  'The story behind {term}',
];
const keywordFrames = [
  '{term}',
  '{term} books',
  'books about {term}',
  '{term} guide',
  '{term} for beginners',
  'introduction to {term}',
  '{term} stories',
  '{term} handbook',
  'learn about {term}',
  '{term} reading',
  'understanding {term}',
  '{term} collection',
];
const audiences = [
  'Broad prospecting',
  'Relevant interest audience',
  'Contextual audience',
  'Engaged visitors (consent required)',
];

export function planVariants(
  input: Pick<ExperimentInput, 'seedTerms' | 'variable' | 'count' | 'hypothesis'>,
): Variant[] {
  const values: string[] = [];
  for (const seed of [...new Set(input.seedTerms.map((t) => t.trim().toLowerCase()))]) {
    if (input.variable === 'keyword') {
      for (const frame of keywordFrames)
        for (const match of ['exact', 'phrase', 'broad'])
          values.push(`${frame.replace('{term}', seed)} · ${match}`);
    } else if (input.variable === 'audience') {
      for (const frame of audiences) values.push(`${frame} · ${seed}`);
    } else {
      for (const frame of hookFrames) values.push(frame.replace('{term}', seed));
    }
  }
  return [...new Set(values)].slice(0, input.count).map((value, i) => ({
    id: `v-${String(i + 1).padStart(3, '0')}`,
    label: input.variable === 'keyword' ? value.split(' · ')[0] : value,
    hypothesis: input.hypothesis,
    variable: input.variable,
    value,
    state: 'queued',
  }));
}

export function createExperiment(
  input: ExperimentInput,
  campaign: Campaign,
  variants: Variant[],
  now = new Date(),
): Experiment {
  if (campaign.dataset !== input.dataset) throw new AppError('Workspace mismatch.');
  if ((campaign.vertical === 'books') !== (input.variable === 'keyword'))
    throw new AppError(
      'Use keyword experiments for books, or creative/audience experiments for products.',
    );
  if (input.budgetCents > campaign.totalLearningBudgetCents)
    throw new AppError(
      'Experiment planning budget exceeds this campaign’s total learning allowance.',
    );
  if (variants.length < 2) throw new AppError('At least two distinct candidates are required.');
  return {
    id: randomUUID(),
    dataset: input.dataset,
    campaignId: campaign.id,
    name: input.name,
    hypothesis: input.hypothesis,
    variable: input.variable,
    budgetCents: input.budgetCents,
    maxConcurrent: Math.min(input.maxConcurrent, variants.length),
    status: 'draft',
    provider: input.provider,
    variants,
    createdAt: now.toISOString(),
    ...(input.sourceTargetId ? { sourceTargetId: input.sourceTargetId } : {}),
    ...(input.sourceLearningId ? { sourceLearningId: input.sourceLearningId } : {}),
  };
}
