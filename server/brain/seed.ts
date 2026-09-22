import type { AdAccount, LedgerEntry } from '../../shared/types.js';
import { Store } from '../store.js';
import { sandboxSpec } from '../connectors/sandbox.js';
import { connectorFor, defaultPolicy } from './accounts.js';
import { runBrain } from './execution.js';
import { seedBooks } from '../seed-books.js';

/**
 * Connects the demo book campaigns to a simulated advertiser so the brain is
 * fully exercisable without credentials. Everything here is synthetic.
 */
export async function seedBrain(store: Store) {
  if (store.accounts('demo').length) {
    seedBooks(store);
    return;
  }
  const now = store.reportingTime('demo');
  const books = store.campaigns('demo').filter((c) => c.vertical === 'books');
  if (!books.length) return;
  const account: AdAccount = {
    id: 'demo-sandbox',
    dataset: 'demo',
    provider: 'amazon',
    connector: 'sandbox',
    name: 'Sample publisher · simulated Amazon Ads',
    profileId: 'sandbox-profile',
    marketplace: 'US',
    currency: 'USD',
    timezone: 'UTC',
    attributionDays: 14,
    policy: defaultPolicy({ mode: 'supervised' }),
    health: {
      status: 'never',
      message: 'Not synchronized yet.',
      lastAttemptAt: null,
      lastSuccessAt: null,
      watermarkDate: null,
      coverage: { campaigns: 0, keywords: 0, negatives: 0, searchTerms: 0 },
    },
    createdAt: now.toISOString(),
  };
  store.transaction(() => {
    store.saveAccount(account);
    store.saveSandboxState(
      account.id,
      sandboxSpec(
        books.map((c) => ({
          externalId: `sbx-${c.id}`,
          name: c.name,
          dailyBudgetCents: c.dailyBudgetCents,
        })),
      ),
    );
    for (const c of books)
      store.saveCampaign({
        ...c,
        brief:
          c.id === 'demo-atlas'
            ? 'Literary nature writing: essays about landscape, walking, and attention. Paperback for readers of contemplative nonfiction.'
            : c.id === 'demo-home'
              ? 'A memoir about building a slower home life outdoors. For readers of slow living and simple living books.'
              : 'A novel set in a remote lighthouse community; quiet literary fiction with an outdoor setting.',
      });
    // A reconciled ledger for one title shows real receipts beside attribution.
    const rows = store.observations('demo-atlas');
    const ledger: LedgerEntry[] = rows.map((r) => ({
      campaignId: 'demo-atlas',
      date: r.date,
      units: Math.round(r.orders * 1.15),
      netReceiptsCents: Math.round(r.orders * 1.15) * 1297,
      refundsCents: r.refundsCents,
      observedAt: now.toISOString(),
    }));
    store.importLedger(ledger);
  });
  const state = store.sandboxState<{
    campaigns: { externalId: string; adGroup: { externalId: string } }[];
  }>(account.id)!;
  store.transaction(() => {
    for (const c of books) {
      const sandbox = state.campaigns.find((s) => s.externalId === `sbx-${c.id}`)!;
      store.saveLink({
        campaignId: c.id,
        accountId: account.id,
        externalCampaignId: sandbox.externalId,
        adGroupExternalId: sandbox.adGroup.externalId,
      });
    }
  });
  // Initial sync and evaluation use the demo snapshot clock and never call an AI provider.
  const quiet = { ...account, policy: { ...account.policy, aiReview: false } };
  store.saveAccount(quiet);
  await runBrain(store, quiet, connectorFor(store, quiet, now), now, { sync: true });
  store.saveAccount({ ...store.account('demo', account.id), policy: account.policy });
  seedBooks(store);
}
