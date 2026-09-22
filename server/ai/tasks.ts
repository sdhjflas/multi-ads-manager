import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Campaign, Proposal, Relevance, Variant } from '../../shared/types.js';
import type { ExperimentInput } from '../validation.js';
import { AppError } from '../validation.js';
import type { AiProvider } from './provider.js';
import { Store } from '../store.js';
import { normalizeTerm } from '../connectors/connector.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// ---- Search-term relevance -------------------------------------------------

const relevanceSchema = z
  .object({
    reviews: z
      .array(
        z
          .object({
            term: z.string().min(1).max(200),
            relevance: z.enum(['high', 'medium', 'low', 'irrelevant']),
            reason: z.string().min(1).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(60),
  })
  .strict();

export const relevanceKey = (campaignId: string, term: string, brief: string) =>
  hash(['term-relevance', campaignId, normalizeTerm(term), brief]);

export type RelevanceReview = { level: Relevance; reason: string };

/**
 * Classifies shopper search terms against the operator's own description of
 * the item. The model sees no performance numbers, so its judgment is about
 * reader intent only; economics stay in deterministic code.
 */
export async function reviewSearchTerms(
  provider: AiProvider,
  store: Store,
  campaign: Campaign,
  terms: string[],
): Promise<Map<string, RelevanceReview>> {
  const brief = campaign.brief?.trim() || '';
  const unique = [...new Set(terms.map(normalizeTerm))].filter(Boolean).slice(0, 60);
  const results = new Map<string, RelevanceReview>();
  const pending: string[] = [];
  for (const term of unique) {
    const cached = store.aiReview<RelevanceReview>(relevanceKey(campaign.id, term, brief));
    if (cached) results.set(term, cached);
    else pending.push(term);
  }
  if (!pending.length) return results;
  const output = await provider.structured({
    name: 'search_term_relevance',
    system:
      'You review Amazon shopper search terms for a book or product advertiser. For each term, judge how closely the shopper intent matches the described item: high (clearly seeking this kind of item), medium (plausibly interested), low (loosely related), or irrelevant (different intent, free content, other formats, or unrelated products). Judge only from the supplied description; do not infer contents from the title. Return one review per supplied term, using the term text exactly as given.',
    input: {
      vertical: campaign.vertical,
      item: campaign.entityName,
      description: brief || 'No description supplied; judge conservatively.',
      terms: pending,
    },
    schema: relevanceSchema,
    maxOutputTokens: 4000,
  });
  for (const review of output.reviews) {
    const key = normalizeTerm(review.term);
    if (!pending.includes(key)) continue;
    const value = { level: review.relevance, reason: review.reason };
    results.set(key, value);
    store.saveAiReview(
      relevanceKey(campaign.id, key, brief),
      campaign.dataset,
      'term-relevance',
      value,
    );
  }
  for (const term of pending)
    if (!results.has(term))
      results.set(term, {
        level: 'low',
        reason: 'The model did not return a review for this term.',
      });
  return results;
}

// ---- Proposal explanation --------------------------------------------------

const explanationSchema = z
  .object({
    summary: z.string().min(1).max(1200),
    risks: z.array(z.string().min(1).max(300)).max(8),
    checks: z.array(z.string().min(1).max(300)).max(8),
  })
  .strict();
export type ProposalExplanation = z.infer<typeof explanationSchema>;

export async function explainProposals(
  provider: AiProvider,
  store: Store,
  campaign: Campaign,
  proposals: Proposal[],
): Promise<ProposalExplanation> {
  if (!proposals.length) throw new AppError('Select at least one proposal to explain.');
  const digest = proposals.map((p) => ({
    actionClass: p.actionClass,
    action: p.action,
    target: p.targetRef,
    title: p.title,
    reason: p.reason,
    evidence: p.evidence,
    maxCommitmentCents: p.maxCommitmentCents,
    relevance: p.relevance,
  }));
  const key = hash(['explain', campaign.id, digest]);
  const cached = store.aiReview<ProposalExplanation>(key);
  if (cached) return cached;
  const output = await provider.structured({
    name: 'proposal_explanation',
    system:
      'You are an advertising analyst explaining proposed keyword, bid, and budget changes to the operator who must approve them. Write a plain-language summary of what the changes do and why the evidence supports them, list concrete risks (delayed attribution, small samples, relevance doubts, budget elasticity), and list checks the operator should make before authorizing. Do not add new numbers beyond those supplied.',
    input: {
      item: campaign.entityName,
      economics: {
        retailPriceCents: campaign.retailPriceCents,
        netReceiptCents: campaign.netReceiptCents,
        variableCostCents: campaign.variableCostCents,
        targetProfitCents: campaign.targetProfitCents,
        attributionDays: campaign.attributionDays,
      },
      proposals: digest,
    },
    schema: explanationSchema,
    maxOutputTokens: 3000,
  });
  store.saveAiReview(key, campaign.dataset, 'explain', output);
  return output;
}

// ---- Experiment ideas (previously OpenAI-only) ------------------------------

const ideasSchema = z
  .object({
    ideas: z
      .array(
        z
          .object({
            label: z.string().min(1).max(160),
            value: z.string().min(1).max(240),
            hypothesis: z.string().min(1).max(600),
          })
          .strict(),
      )
      .min(2)
      .max(24),
  })
  .strict();

export async function generateIdeas(
  provider: AiProvider,
  input: ExperimentInput,
  campaign: Campaign,
  recordedLearning?: {
    id: string;
    hypothesis: string;
    outcome: string;
    finding: string;
    notes: string;
    candidate: string | null;
  },
): Promise<Variant[]> {
  if (input.count > 24)
    throw new AppError(
      'AI generation supports up to 24 candidates per request. Use the structured planner for a larger screening library.',
    );
  const parsed = await provider.structured({
    name: 'advertising_hypotheses',
    system:
      'Generate distinct, testable advertising hypotheses. Change only the specified variable. Keywords must be relevant to the supplied item description; do not infer topics from a title alone. These are draft ideas requiring review.',
    input: {
      vertical: campaign.vertical,
      channel: campaign.channel,
      item: campaign.entityName,
      description: campaign.brief || null,
      variable: input.variable,
      seedTerms: input.seedTerms,
      hypothesis: input.hypothesis,
      count: input.count,
      ...(recordedLearning ? { recordedLearning } : {}),
    },
    schema: ideasSchema,
    maxOutputTokens: 4000,
  });
  const seen = new Set<string>();
  const variants = parsed.ideas
    .filter((idea) => {
      const key = idea.value.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, input.count)
    .map((idea, i) => ({
      ...idea,
      id: `v-${String(i + 1).padStart(3, '0')}`,
      variable: input.variable,
      state: 'queued' as const,
    }));
  if (variants.length < 2)
    throw new AppError('AI returned too few distinct ideas. No experiment was saved.', 502);
  return variants;
}
