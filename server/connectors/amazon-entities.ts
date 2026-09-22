import { z } from 'zod';
import { amazonId } from './amazon-reports.js';
import { ConnectorError } from './connector.js';

const state = z.enum(['ENABLED', 'PAUSED', 'ARCHIVED']);
const money = z.number().finite().nonnegative().max(1_000_000);
export const campaignEntity = z.object({
  campaignId: amazonId,
  name: z.string().min(1),
  state,
  budget: z.object({ budget: money, budgetType: z.literal('DAILY') }),
  targetingType: z.enum(['AUTO', 'MANUAL']),
});
export const adGroupEntity = z.object({
  adGroupId: amazonId,
  campaignId: amazonId,
  name: z.string().min(1),
  state,
  defaultBid: money,
});
export const keywordEntity = z.object({
  keywordId: amazonId,
  campaignId: amazonId,
  adGroupId: amazonId,
  keywordText: z.string().min(1),
  matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']),
  state,
  bid: money,
});
export const negativeEntity = z.object({
  keywordId: amazonId,
  campaignId: amazonId,
  adGroupId: amazonId.optional(),
  keywordText: z.string().min(1),
  matchType: z.enum(['NEGATIVE_EXACT', 'NEGATIVE_PHRASE']),
  state,
});
const targetExpression = z.object({
  type: z.string().regex(/^[A-Z0-9_]{1,100}$/),
  value: z.string().min(1).max(1000).optional(),
});
export const productTargetEntity = z.object({
  targetId: amazonId,
  campaignId: amazonId,
  adGroupId: amazonId,
  expressionType: z.enum(['AUTO', 'MANUAL']),
  expression: z.array(targetExpression).min(1).max(20),
  state,
  bid: money.optional(),
});
export const negativeProductTargetEntity = z.object({
  targetId: amazonId,
  campaignId: amazonId,
  adGroupId: amazonId.optional(),
  expression: z.array(targetExpression).min(1).max(20),
  state,
});

export function entities<T extends z.ZodType>(
  schema: T,
  items: unknown[],
  idKey: string,
): z.output<T>[] {
  const result = z.array(schema).safeParse(items);
  if (!result.success)
    throw new ConnectorError(
      'invalid',
      'Amazon returned incomplete or unsupported entity fields. No state was accepted.',
    );
  const ids = result.data.map((item) => (item as Record<string, unknown>)[idKey]);
  if (new Set(ids).size !== ids.length)
    throw new ConnectorError(
      'invalid',
      'Amazon repeated an entity across pages. Synchronize again for a consistent snapshot.',
    );
  return result.data;
}
