import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { createAccount } from '../server/brain/accounts.js';
import { syncAccount } from '../server/brain/sync.js';
import { analyzeAccount } from '../server/brain/policy.js';
import { seedDemo } from '../server/seed.js';
import {
  ConnectorError,
  type Connector,
  type ReportKind,
  type ReportRow,
} from '../server/connectors/connector.js';
import { productRows, saveProductReport } from '../server/books.js';
import type { AdAccount } from '../shared/types.js';

const now = new Date('2026-09-22T12:00:00Z');
let store: Store, account: AdAccount;
const raw: ReportRow = {
  date: '2026-09-20',
  campaignExternalId: '9',
  adGroupExternalId: null,
  keywordExternalId: null,
  keywordText: null,
  matchType: null,
  searchTerm: null,
  impressions: 100,
  clicks: 10,
  purchases: 1,
  costCents: 100,
  salesCents: 2000,
  observedAt: '2026-09-22T11:00:00Z',
};
beforeEach(() => {
  store = new Store(':memory:');
  seedDemo(store, now);
  const created = createAccount(
    store,
    {
      dataset: 'workspace',
      connector: 'sandbox',
      name: 'Fixture publisher',
      profileId: '42',
      marketplace: 'US',
      attributionDays: 14,
    },
    now,
  );
  account = { ...created, connector: 'amazon-ads', region: 'NA', verifiedAt: now.toISOString() };
  store.saveAccount(account);
  store.saveCampaign({
    ...store.campaign('demo', 'demo-home'),
    id: 'live-book',
    dataset: 'workspace',
    reportingTimezone: 'UTC',
  });
  store.saveLink({
    accountId: account.id,
    campaignId: 'live-book',
    externalCampaignId: '9',
    adGroupExternalId: '5',
  });
});
afterEach(() => store.close());
function fixture(report?: (kind: ReportKind) => Promise<ReportRow[]>): Connector {
  return {
    kind: 'amazon-ads',
    writesEnabled: false,
    listCampaigns: vi.fn(async () => [
      {
        externalId: '9',
        name: 'Book',
        state: 'enabled' as const,
        dailyBudgetCents: 1000,
        targetingType: 'manual' as const,
      },
    ]),
    listAdGroups: async () => [
      {
        externalId: '5',
        campaignExternalId: '9',
        name: 'Book',
        state: 'enabled',
        defaultBidCents: 50,
      },
    ],
    listKeywords: async () => [
      {
        externalId: '1',
        campaignExternalId: '9',
        adGroupExternalId: '5',
        text: 'book',
        matchType: 'exact',
        state: 'enabled',
        bidCents: 50,
      },
    ],
    listNegativeKeywords: async () => [],
    report:
      report ||
      (async (kind) =>
        kind === 'campaign'
          ? [raw, { ...raw, date: '2026-09-21' }]
          : kind === 'keyword'
            ? [
                {
                  ...raw,
                  keywordExternalId: '1',
                  keywordText: 'book',
                  matchType: 'exact',
                  adGroupExternalId: '5',
                },
              ]
            : []),
    createKeywords: async () => {
      throw new Error('No writes in fixture');
    },
    updateKeywords: async () => {
      throw new Error('No writes in fixture');
    },
    createNegativeKeywords: async () => {
      throw new Error('No writes in fixture');
    },
    updateCampaigns: async () => {
      throw new Error('No writes in fixture');
    },
  };
}

describe('live sync gates', () => {
  it('keeps pending work separate from successful evidence and waits for every report', async () => {
    let settled = false;
    const connector = fixture(async (kind) => {
      if (kind === 'campaign') throw new ConnectorError('pending', 'Queued');
      if (kind === 'advertisedProduct') {
        await new Promise((r) => setTimeout(r, 10));
        settled = true;
      }
      return [];
    });
    const run = await syncAccount(store, account, connector, now);
    expect(settled).toBe(true);
    expect(run.status).toBe('pending');
    expect(store.account('workspace', account.id).health).toMatchObject({
      watermarkDate: null,
      lastSuccessAt: null,
    });
    expect(store.observations('live-book')).toHaveLength(0);
    expect(
      analyzeAccount(store, store.account('workspace', account.id), now)[0].proposals,
    ).toHaveLength(0);
    await syncAccount(store, store.account('workspace', account.id), connector, now);
    expect(connector.listCampaigns).toHaveBeenCalledTimes(1);
  });
  it('does not invent missing keyword days and uses report generation time', async () => {
    const run = await syncAccount(store, account, fixture(), now);
    expect(run.status).toBe('ok');
    expect((Date.parse(run.endDate) - Date.parse(run.startDate)) / 86400000).toBe(55);
    const target = store.targets('live-book')[0];
    expect(store.targetRows(target.id)).toHaveLength(1);
    expect(store.targetRows(target.id)[0].observedAt).toBe(raw.observedAt);
    expect(store.observations('live-book')).toHaveLength(2);
  });
  it('rolls back every observation when purchases cannot fit the model instead of capping counts', async () => {
    await syncAccount(store, account, fixture(), now);
    const before = store.observations('live-book');
    const connector = fixture(async (kind) =>
      kind === 'campaign'
        ? [{ ...raw, costCents: 999, purchases: 11 }]
        : kind === 'advertisedProduct'
          ? [
              {
                ...raw,
                adExternalId: '4',
                advertisedAsin: 'B000000001',
                sameSkuPurchases: 1,
                sameSkuUnits: 1,
                sameSkuSalesCents: 2000,
              },
            ]
          : [],
    );
    const run = await syncAccount(store, store.account('workspace', account.id), connector, now);
    expect(run.status).toBe('error');
    expect(run.message).toContain('not capped');
    expect(store.observations('live-book')).toEqual(before);
    expect(productRows(store, account.id)).toHaveLength(0);
  });
  it('shares concurrent account syncs and does not race writes or report requests', async () => {
    const connector = fixture();
    const first = syncAccount(store, account, connector, now);
    const second = syncAccount(store, account, connector, now);
    expect(first).toBe(second);
    expect((await first).status).toBe('ok');
    expect(connector.listCampaigns).toHaveBeenCalledTimes(1);
    expect(store.syncRuns('workspace')).toHaveLength(1);
  });
  it('bounds API-only product and search-term history to Amazon retention', async () => {
    store.transaction(() => {
      saveProductReport(
        store,
        account.id,
        [
          {
            ...raw,
            date: '2026-05-01',
            advertisedAsin: 'B000000001',
            adExternalId: '4',
            sameSkuPurchases: 1,
            sameSkuUnits: 1,
            sameSkuSalesCents: 2000,
          },
        ],
        '2026-05-01',
        '2026-05-01',
      );
      store.importSearchTerms([
        {
          term: {
            id: 'old-term',
            campaignId: 'live-book',
            term: 'old query',
            keywordExternalId: '1',
            keywordText: 'book',
            matchType: 'exact',
            adGroupExternalId: '5',
          },
          rows: [
            {
              campaignId: 'live-book',
              date: '2026-05-01',
              impressions: 1,
              clicks: 1,
              orders: 0,
              spendCents: 10,
              salesCents: 0,
              refundsCents: 0,
              observedAt: raw.observedAt!,
            },
          ],
        },
      ]);
    });
    expect((await syncAccount(store, account, fixture(), now)).status).toBe('ok');
    expect(productRows(store, account.id)).toHaveLength(0);
    expect(store.searchTerms('live-book').some((term) => term.id === 'old-term')).toBe(false);
  });
});
