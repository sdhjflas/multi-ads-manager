import { Store } from './store.js';
import { books, saveBooks, saveProductReport } from './books.js';

/** Fictional catalog and product reports for the existing simulated publisher. */
export function seedBooks(store: Store) {
  if (books(store, 'demo').length || !store.accounts('demo').some((a) => a.id === 'demo-sandbox'))
    return;
  const account = store.account('demo', 'demo-sandbox');
  const now = store.reportingTime('demo');
  store.transaction(() => {
    const campaigns = store.campaigns('demo').filter((c) => c.vertical === 'books');
    const catalog = saveBooks(
      store,
      account,
      campaigns.map((c, i) => ({
        asin: `B0DEMO000${i + 1}`,
        isbn: '',
        title: c.entityName,
        publisher: 'Sample publisher',
        format: 'paperback',
        retailPriceCents: c.retailPriceCents,
        netReceiptCents: c.netReceiptCents,
        variableCostCents: c.variableCostCents,
        profitReserveCents: c.targetProfitCents,
        lossLimitCents: c.totalLearningBudgetCents,
        dailyBudgetLimitCents: c.dailyBudgetCents * 2,
        economicsVerified: c.economicsVerified,
        supplyReady: c.supplyReady,
      })),
      now,
    );
    const rows = campaigns.flatMap((c, i) => {
      store.db
        .prepare('INSERT INTO book_campaigns(campaign_id,book_id) VALUES(?,?)')
        .run(c.id, catalog[i].id);
      return store.observations(c.id).map((r) => ({
        date: r.date,
        campaignExternalId: `sbx-${c.id}`,
        adGroupExternalId: null,
        keywordExternalId: null,
        keywordText: null,
        matchType: null,
        searchTerm: null,
        impressions: r.impressions,
        clicks: r.clicks,
        purchases: r.orders,
        costCents: r.spendCents,
        salesCents: r.salesCents,
        observedAt: r.observedAt,
        adExternalId: `demo-ad-${i}`,
        advertisedAsin: catalog[i].asin,
        sameSkuPurchases: r.orders,
        sameSkuUnits: r.orders,
        sameSkuSalesCents: r.salesCents,
      }));
    });
    const dates = rows.map((r) => r.date).sort();
    if (dates.length) saveProductReport(store, account.id, rows, dates[0], dates.at(-1)!);
  });
}
