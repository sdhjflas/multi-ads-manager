import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { createAccount } from '../server/brain/accounts.js';
import {
  bookBlockers,
  bookCommitmentBlocker,
  bookHeaders,
  bookViews,
  parseBooks,
  productRows,
  saveBooks,
  saveProductReport,
} from '../server/books.js';
import { seedDemo } from '../server/seed.js';
import { dayAt } from '../server/engine.js';
import type { AdAccount, Proposal } from '../shared/types.js';
import type { ReportRow } from '../server/connectors/connector.js';

const now = new Date('2026-09-22T00:30:00Z');
let store: Store, account: AdAccount;
const input = {
  asin: 'B000000001',
  isbn: '',
  title: 'A test book',
  publisher: 'Example',
  format: 'paperback' as const,
  retailPriceCents: 2000,
  netReceiptCents: 800,
  variableCostCents: 300,
  profitReserveCents: 100,
  lossLimitCents: 2000,
  dailyBudgetLimitCents: 3000,
  economicsVerified: true,
  supplyReady: true,
};
const report = (overrides: Partial<ReportRow> = {}): ReportRow => ({
  date: '2026-09-06',
  campaignExternalId: '9',
  adGroupExternalId: '5',
  keywordExternalId: null,
  keywordText: null,
  matchType: null,
  searchTerm: null,
  impressions: 1000,
  clicks: 30,
  purchases: 5,
  costCents: 300,
  salesCents: 10000,
  advertisedAsin: input.asin,
  adExternalId: '3',
  sameSkuPurchases: 1,
  sameSkuUnits: 2,
  sameSkuSalesCents: 4000,
  observedAt: now.toISOString(),
  ...overrides,
});
beforeEach(() => {
  store = new Store(':memory:');
  account = createAccount(
    store,
    {
      dataset: 'workspace',
      name: 'Test publisher',
      connector: 'sandbox',
      profileId: 'test',
      marketplace: 'US',
      attributionDays: 14,
    },
    now,
  );
  account = {
    ...account,
    timezone: 'America/Los_Angeles',
    health: { ...account.health, status: 'ok' },
  };
  store.saveAccount(account);
});
afterEach(() => store.close());

describe('book economics', () => {
  it('shares loss and daily budget headroom across campaigns for the same title', () => {
    seedDemo(store, now);
    account = { ...account, connector: 'amazon-ads' };
    store.saveAccount(account);
    const [book] = saveBooks(
      store,
      account,
      [{ ...input, dailyBudgetLimitCents: 5000, lossLimitCents: 1000 }],
      now,
    );
    const campaign = {
      ...store.campaign('demo', 'demo-home'),
      id: 'book-campaign',
      dataset: 'workspace' as const,
      retailPriceCents: input.retailPriceCents,
      netReceiptCents: input.netReceiptCents,
      variableCostCents: input.variableCostCents,
      targetProfitCents: input.profitReserveCents,
    };
    store.saveCampaign(campaign);
    store.saveLink({
      accountId: account.id,
      campaignId: campaign.id,
      externalCampaignId: '9',
      adGroupExternalId: '5',
    });
    store.db
      .prepare('INSERT INTO book_campaigns(campaign_id,book_id) VALUES(?,?)')
      .run(campaign.id, book.id);
    const pending = {
      id: 'next',
      accountId: account.id,
      campaignId: campaign.id,
      maxCommitmentCents: 400,
    } as Proposal;
    const applied = {
      ...pending,
      id: 'previous',
      dataset: 'workspace',
      status: 'applied',
      idempotencyKey: 'earlier',
      maxCommitmentCents: 700,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    } as Proposal;
    store.saveProposal(applied);
    expect(bookCommitmentBlocker(store, account, pending, now)).toMatch(/loss allowance/);
    expect(
      bookCommitmentBlocker(store, account, { ...pending, maxCommitmentCents: 200 }, now),
    ).toBeNull();
    store.saveSnapshot(account.id, {
      observedAt: now.toISOString(),
      campaigns: [
        {
          externalId: '9',
          name: 'Book',
          state: 'enabled',
          dailyBudgetCents: 4900,
          targetingType: 'manual',
        },
      ],
      adGroups: [],
      keywords: [],
      negatives: [],
    });
    expect(
      bookCommitmentBlocker(store, account, { ...pending, maxCommitmentCents: 200 }, now),
    ).toMatch(/daily budget ceiling/);
    expect(bookBlockers(store, account, campaign, '9', now)[0]).toMatch(/single mapped ASIN/);
    store.transaction(() =>
      saveProductReport(store, account.id, [report()], '2026-09-01', '2026-09-20'),
    );
    expect(bookBlockers(store, account, campaign, '9', now)[0]).toMatch(
      /other-SKU sales or multiple units/,
    );
    store.transaction(() =>
      saveProductReport(
        store,
        account.id,
        [report({ advertisedAsin: 'B000000002' })],
        '2026-09-01',
        '2026-09-20',
      ),
    );
    expect(bookBlockers(store, account, campaign, '9', now)[0]).toMatch(/single mapped ASIN/);
  });
  it('uses same-ASIN units, excludes halo sales, and charges immature spend against the loss allowance', () => {
    store.transaction(() => {
      saveBooks(store, account, [input], now);
      saveProductReport(
        store,
        account.id,
        [report(), report({ date: '2026-09-07', costCents: 1500, sameSkuUnits: 20 })],
        '2026-09-01',
        '2026-09-20',
      );
    });
    const book = bookViews(store, 'workspace', 56, now)[0];
    expect(book.matureThrough).toBe('2026-09-06');
    expect(book.sameAsinUnits).toBe(22);
    expect(book.matureUnits).toBe(2);
    expect(book.contributionCents).toBe(700);
    expect(book.riskExposureCents).toBe(1000);
    expect(book.remainingLossAllowanceCents).toBe(1000);
    expect(book.status).toBe('positive');
    expect(bookViews(store, 'workspace', 7, now)[0].riskExposureCents).toBe(1000); // fixed risk window
    expect(bookViews(store, 'demo', 56, now)).toHaveLength(0);
  });
  it('holds unverified, unavailable, unviable, and overspent titles independently', () => {
    saveBooks(store, account, [input], now);
    store.transaction(() =>
      saveProductReport(
        store,
        account.id,
        [report({ sameSkuUnits: 0, sameSkuPurchases: 0, costCents: 2100 })],
        '2026-09-01',
        '2026-09-20',
      ),
    );
    expect(bookViews(store, 'workspace', 56, now)[0].status).toBe('loss-limit');
    saveBooks(store, account, [{ ...input, economicsVerified: false }], now);
    expect(bookViews(store, 'workspace', 56, now)[0]).toMatchObject({
      status: 'unverified',
      contributionCents: null,
      riskExposureCents: null,
    });
    saveBooks(store, account, [{ ...input, netReceiptCents: 300 }], now);
    expect(bookViews(store, 'workspace', 56, now)[0].status).toBe('not-viable');
    saveBooks(store, account, [{ ...input, supplyReady: false }], now);
    expect(bookViews(store, 'workspace', 56, now)[0].status).toBe('unavailable');
  });
  it('replaces a complete product interval once and never sums report revisions', () => {
    saveBooks(store, account, [input], now);
    store.transaction(() =>
      saveProductReport(store, account.id, [report()], '2026-09-01', '2026-09-20'),
    );
    store.transaction(() =>
      saveProductReport(
        store,
        account.id,
        [report({ costCents: 400, observedAt: new Date(now.getTime() + 60000).toISOString() })],
        '2026-09-01',
        '2026-09-20',
      ),
    );
    expect(productRows(store, account.id)).toHaveLength(1);
    expect(bookViews(store, 'workspace', 56, new Date(now.getTime() + 60000))[0].spendCents).toBe(
      400,
    );
    expect(() =>
      store.transaction(() =>
        saveProductReport(store, account.id, [report()], '2026-09-01', '2026-09-20'),
      ),
    ).toThrow(/older/);
    expect(productRows(store, account.id)[0].costCents).toBe(400);
  });
  it('preserves existing product facts when an empty replacement has no generation evidence', () => {
    store.transaction(() =>
      saveProductReport(store, account.id, [report()], '2026-09-01', '2026-09-20'),
    );
    expect(() =>
      store.transaction(() => saveProductReport(store, account.id, [], '2026-09-01', '2026-09-20')),
    ).toThrow(/empty advertised-product report/);
    expect(productRows(store, account.id)).toHaveLength(1);
    store.transaction(() =>
      saveProductReport(
        store,
        account.id,
        [],
        '2026-09-01',
        '2026-09-20',
        '2026-09-22T00:31:00.000Z',
      ),
    );
    expect(productRows(store, account.id)).toHaveLength(0);
  });
  it('keeps date arithmetic on the Amazon calendar across DST and midnight', () => {
    expect(dayAt(now, -1, 'America/Los_Angeles')).toBe('2026-09-20');
    expect(dayAt(new Date('2026-03-09T06:30:00Z'), -1, 'America/Los_Angeles')).toBe('2026-03-07');
    expect(dayAt(new Date('2026-11-02T07:30:00Z'), -1, 'America/Los_Angeles')).toBe('2026-10-31');
  });
});

describe('catalog at portfolio scale', () => {
  const csv = (count: number) =>
    [
      bookHeaders.join(','),
      ...Array.from({ length: count }, (_, i) =>
        [
          `B0${String(i).padStart(8, '0')}`,
          '',
          `Book ${i}`,
          'Publisher',
          'paperback',
          '2000',
          '800',
          '300',
          '100',
          '2000',
          '3000',
          'true',
          'true',
        ].join(','),
      ),
    ].join('\n');
  it('imports and searches 500 formats, paginates, and updates stable ASIN identities', async () => {
    const app = createApp(store);
    const imported = await request(app)
      .post('/api/books/import')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', accountId: account.id, csv: csv(500) })
      .expect(201);
    expect(imported.body).toEqual({ created: 500, updated: 0 });
    const list = await request(app).get('/api/books?dataset=workspace&page=10').expect(200);
    expect(list.body).toMatchObject({
      total: 500,
      pages: 10,
      page: 10,
      summary: { titles: 500, verified: 500, needsAttention: 500 },
    });
    expect(list.body.books).toHaveLength(50);
    const firstId = list.body.books[0].id;
    const again = await request(app)
      .post('/api/books/import')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', accountId: account.id, csv: csv(500) })
      .expect(201);
    expect(again.body).toEqual({ created: 0, updated: 500 });
    expect((await request(app).get('/api/books?dataset=workspace&page=10')).body.books[0].id).toBe(
      firstId,
    );
    const filtered = await request(app)
      .get('/api/books?dataset=workspace&query=Book%20499')
      .expect(200);
    expect(filtered.body.total).toBe(1);
    expect((await request(app).get('/api/books?dataset=demo')).body.total).toBe(0);
    await request(app)
      .post('/api/books/import')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'demo', accountId: account.id, csv: csv(1) })
      .expect(400);
    await request(app)
      .post('/api/books/import')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', accountId: 'wrong-account', csv: csv(1) })
      .expect(404);
  });
  it('rejects duplicates and malformed flags and rolls back a conflicting format update', async () => {
    const two = csv(2).replace('B000000001', 'B000000000');
    expect(() => parseBooks(two)).toThrow(/duplicate/);
    expect(() => parseBooks(csv(1).replace('true,true', 'yes,true'))).toThrow(/true or false/);
    const app = createApp(store);
    await request(app)
      .post('/api/books/import')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', accountId: account.id, csv: csv(1) })
      .expect(201);
    const invalid = csv(2).replace(
      'B000000000,,Book 0,Publisher,paperback',
      'B000000000,,Changed,Publisher,hardcover',
    );
    await request(app)
      .post('/api/books/import')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', accountId: account.id, csv: invalid })
      .expect(400);
    const list = await request(app).get('/api/books?dataset=workspace');
    expect(list.body.total).toBe(1);
    expect(list.body.books[0].title).toBe('Book 0');
  });
});
