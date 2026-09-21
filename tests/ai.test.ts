import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateIdeas } from '../server/ai.js';
import { seedDemo } from '../server/seed.js';
import { Store } from '../server/store.js';
import type { ExperimentInput } from '../server/validation.js';

afterEach(() => vi.unstubAllEnvs());
describe('AI boundary', () => {
  it('sends a strict non-storing request and validates returned hypotheses', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-not-a-real-key');
    vi.stubEnv('OPENAI_MODEL', 'configured-model');
    const store = new Store(':memory:');
    seedDemo(store);
    const c = store.campaigns('demo')[0];
    store.close();
    const input: ExperimentInput = {
      dataset: 'demo',
      campaignId: c.id,
      name: 'Test',
      hypothesis: 'A bounded keyword hypothesis.',
      variable: 'keyword',
      seedTerms: ['nature'],
      count: 2,
      budgetCents: 1000,
      maxConcurrent: 2,
      provider: 'openai',
    };
    const ideas = {
      ideas: [
        {
          label: 'Nature essays',
          value: 'nature essays · exact',
          hypothesis: 'Test reader intent.',
        },
        {
          label: 'Outdoor essays',
          value: 'outdoor essays · exact',
          hypothesis: 'Compare a related intent.',
        },
      ],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ideas) }] },
            ],
          }),
          { status: 200 },
        ),
      );
    const variants = await generateIdeas(input, c, fetcher);
    expect(variants).toHaveLength(2);
    const sent = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(sent.store).toBe(false);
    expect(sent.text.format.strict).toBe(true);
    expect(sent.max_output_tokens).toBe(4000);
    expect(sent.tools).toBeUndefined();
  });
  it('rejects incomplete output instead of claiming a successful AI result', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-not-a-real-key');
    vi.stubEnv('OPENAI_MODEL', 'configured-model');
    const store = new Store(':memory:');
    seedDemo(store);
    const c = store.campaigns('demo')[0];
    store.close();
    const input: ExperimentInput = {
      dataset: 'demo',
      campaignId: c.id,
      name: 'Test',
      hypothesis: 'A bounded hypothesis.',
      variable: 'keyword',
      seedTerms: ['nature'],
      count: 2,
      budgetCents: 1000,
      maxConcurrent: 2,
      provider: 'openai',
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'incomplete', output: [] }), { status: 200 }),
      );
    await expect(generateIdeas(input, c, fetcher)).rejects.toThrow(/incomplete/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
