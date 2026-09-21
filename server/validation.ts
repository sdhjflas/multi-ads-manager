import { z } from 'zod';

export const datasetSchema = z.enum(['demo', 'workspace']);
const cents = z.number().int().min(0).max(100_000_000);
const text = z.string().trim().min(1).max(160);
export const campaignInput = z
  .object({
    dataset: datasetSchema,
    name: text,
    vertical: z.enum(['commerce', 'books']),
    channel: z.enum(['meta', 'amazon', 'tiktok']),
    entityName: text,
    accountName: text,
    retailPriceCents: cents.positive(),
    netReceiptCents: cents,
    variableCostCents: cents,
    targetProfitCents: cents,
    dailyBudgetCents: cents,
    totalLearningBudgetCents: cents,
    attributionDays: z.number().int().min(1).max(30),
    economicsVerified: z.boolean(),
    trackingVerified: z.boolean(),
    supplyReady: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.vertical === 'books') !== (v.channel === 'amazon'))
      ctx.addIssue({
        code: 'custom',
        message: 'Books use Amazon; products use Meta or TikTok in this release.',
      });
    if (v.netReceiptCents > v.retailPriceCents)
      ctx.addIssue({ code: 'custom', message: 'Net receipts cannot exceed retail price.' });
    if (v.economicsVerified && v.netReceiptCents <= v.variableCostCents + v.targetProfitCents)
      ctx.addIssue({
        code: 'custom',
        message: 'Verified economics must leave room for advertising after your profit reserve.',
      });
    if (v.dailyBudgetCents > v.totalLearningBudgetCents)
      ctx.addIssue({
        code: 'custom',
        message: 'Daily planning budget cannot exceed the total learning budget.',
      });
  });

export const experimentInput = z
  .object({
    dataset: datasetSchema,
    campaignId: text,
    name: text,
    hypothesis: z.string().trim().min(10).max(1200),
    variable: z.enum(['hook', 'headline', 'audience', 'keyword']),
    seedTerms: z.array(z.string().trim().min(2).max(100)).min(1).max(30),
    count: z.number().int().min(2).max(300),
    budgetCents: cents.positive(),
    maxConcurrent: z.number().int().min(1).max(10),
    provider: z.enum(['structured-planner', 'openai']),
    sourceTargetId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type ExperimentInput = z.infer<typeof experimentInput>;

export const importInput = z
  .object({
    dataset: datasetSchema,
    campaignId: text,
    format: z.enum(['canonical', 'amazon']),
    attributionDays: z.number().int().min(1).max(30),
    timezone: z.literal('UTC'),
    currency: z.literal('USD'),
    exportedAt: z.iso.datetime(),
    csv: z.string().min(1).max(1_000_000),
  })
  .strict();

export const reviewInput = z
  .object({
    dataset: datasetSchema,
    campaignId: text,
    evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(['accepted', 'dismissed']),
  })
  .strict();

export function dateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
