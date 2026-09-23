import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Campaign } from '../shared/types.js';
import { createApp } from '../server/app.js';
import {
  commerceCampaignBlockers,
  commerceProductHeaders,
  commerceProductViews,
  createCommerceStore,
  gateCommerceDecision,
  importCommerceLedger,
  linkCommerceCampaign,
  parseCommerceLedger,
  productReadiness,
  productSellableUnits,
  saveCommerceProducts,
  type CommerceProductInput,
} from '../server/commerce.js';
import { Store } from '../server/store.js';

const now = new Date('2026-09-22T16:00:00.000Z');
let store: Store;

const baseProduct: CommerceProductInput = {
  productRef: 'sequential-indicators',
  sku: 'ENT-SEQ-001',
  name: 'Sequential Indicators',
  variantName: 'Smoked',
  externalVariantId: '',
  inventoryMode: 'stocked',
  retailPriceCents: 2000,
  plannedNetReceiptCents: 1800,
  unitCostCents: 400,
  inboundFreightCents: 100,
  dutiesAndFeesCents: 50,
  packagingCostCents: 50,
  paymentFeeAllowanceCents: 50,
  outboundFulfillmentCents: 100,
  returnAllowanceCents: 25,
  warrantyAllowanceCents: 10,
  supportAllowanceCents: 15,
  profitReserveCents: 300,
  lossLimitCents: 5000,
  dailyBudgetLimitCents: 3000,
  economicsVerified: true,
  commercialRightsApproved: true,
  productEvidenceApproved: true,
  claimsApproved: true,
  trackingVerified: true,
  fulfillmentReady: true,
  releaseApproved: true,
  routeVerified: true,
  preorderTermsApproved: false,
  availableUnits: 100,
  committedUnits: 5,
  quarantinedUnits: 2,
  supplierCapacityUnits: null,
  preorderCapacityUnits: null,
  safetyStockUnits: 20,
  reorderPointUnits: 30,
  inventoryVerifiedAt: now.toISOString(),
  inventoryMaxAgeHours: 168,
};

const campaign = (id = 'commerce-campaign'): Campaign => ({
  id,
  dataset: 'workspace',
  name: 'Product conversion test',
  vertical: 'commerce',
  channel: 'meta',
  entityName: 'Draft item',
  accountName: 'Test ad account',
  status: 'observing',
  currency: 'USD',
  reportingTimezone: 'UTC',
  retailPriceCents: 1,
  netReceiptCents: 1,
  variableCostCents: 0,
  targetProfitCents: 0,
  dailyBudgetCents: 1000,
  totalLearningBudgetCents: 10_000,
  attributionDays: 7,
  economicsVerified: false,
  trackingVerified: false,
  supplyReady: false,
  createdAt: now.toISOString(),
});

beforeEach(() => {
  store = new Store(':memory:');
});
afterEach(() => store.close());

describe('commerce readiness and profit truth', () => {
  it('fails closed on unknown economics and inventory modes', () => {
    const commerceStore = createCommerceStore(
      store,
      'workspace',
      { name: 'Test store', provider: 'manual', timezone: 'UTC', maxDataAgeHours: 72 },
      now,
    );
    const [unknown] = saveCommerceProducts(
      store,
      commerceStore,
      [
        {
          ...baseProduct,
          economicsVerified: false,
          unitCostCents: null,
          availableUnits: null,
          inventoryVerifiedAt: null,
        },
      ],
      now,
    );
    expect(productReadiness(unknown, now)).toMatchObject({
      mediaReady: false,
      inventoryReady: false,
      saleReady: false,
    });
    expect(productReadiness(unknown, now).blockers.join(' ')).toMatch(/landed-cost/);
    expect(productSellableUnits(unknown)).toBeNull();
    const [supplier] = saveCommerceProducts(
      store,
      commerceStore,
      [
        {
          ...baseProduct,
          sku: 'ENT-SUPPLIER-001',
          productRef: 'supplier-product',
          inventoryMode: 'supplier-direct',
          availableUnits: 9999,
          supplierCapacityUnits: 40,
          routeVerified: false,
        },
      ],
      now,
    );
    expect(productSellableUnits(supplier)).toBeNull();
    expect(productReadiness(supplier, now).saleReady).toBe(false);
  });

  it('caps attributed orders by paid ledger units and preserves corrected profit', () => {
    const commerceStore = createCommerceStore(
      store,
      'workspace',
      { name: 'Test store', provider: 'manual', timezone: 'UTC', maxDataAgeHours: 72 },
      now,
    );
    const [product] = saveCommerceProducts(store, commerceStore, [baseProduct], now);
    const c = campaign();
    store.saveCampaign(c);
    linkCommerceCampaign(store, product, c, now);
    store.importRows([
      {
        campaignId: c.id,
        date: '2026-09-10',
        impressions: 1000,
        clicks: 50,
        orders: 8,
        spendCents: 500,
        salesCents: 16_000,
        refundsCents: 0,
        observedAt: now.toISOString(),
      },
    ]);
    const firstCsv = [
      'order_ref,line_ref,date,sku,units,net_receipts_cents,refunds_cents,chargebacks_cents,observed_at',
      `order-1,line-1,2026-09-10,${baseProduct.sku},3,5400,0,0,${now.toISOString()}`,
    ].join('\n');
    const first = parseCommerceLedger(firstCsv, commerceStore.id);
    const firstBatch = store.transaction(() =>
      importCommerceLedger(store, commerceStore, first, 'Paid orders', now),
    );
    expect(firstBatch).toMatchObject({ inserted: 1, corrected: 0, unchanged: 0 });
    let view = commerceProductViews(store, 'workspace', 28, now)[0];
    expect(view).toMatchObject({
      ledgerUnits: 3,
      attributedOrders: 8,
      reconciledPaidUnits: 3,
      ledgerNetReceiptsCents: 5400,
      ledgerContributionCents: 2500,
      riskExposureCents: 0,
      status: 'positive',
    });
    const correctedAt = new Date(now.getTime() + 60_000);
    const correctedCsv = firstCsv
      .replace(',5400,0,0,', ',4300,1100,0,')
      .replace(now.toISOString(), correctedAt.toISOString());
    const corrected = parseCommerceLedger(correctedCsv, commerceStore.id);
    const correctedBatch = store.transaction(() =>
      importCommerceLedger(store, commerceStore, corrected, 'Refund refresh', correctedAt),
    );
    expect(correctedBatch).toMatchObject({ inserted: 0, corrected: 1, unchanged: 0 });
    view = commerceProductViews(store, 'workspace', 28, correctedAt)[0];
    expect(view.ledgerNetReceiptsCents).toBe(4300);
    expect(view.refundsCents).toBe(1100);
    expect(view.ledgerContributionCents).toBe(1400);
    const stale = parseCommerceLedger(
      firstCsv.replace(',5400,0,0,', ',5399,1,0,'),
      commerceStore.id,
    );
    expect(() =>
      store.transaction(() =>
        importCommerceLedger(store, commerceStore, stale, 'Stale export', correctedAt),
      ),
    ).toThrow(/older order export/);
    const sameInstant = parseCommerceLedger(
      correctedCsv.replace(',4300,1100,0,', ',4299,1101,0,').replace('.000Z', 'Z'),
      commerceStore.id,
    );
    expect(() =>
      store.transaction(() =>
        importCommerceLedger(store, commerceStore, sameInstant, 'Conflicting export', correctedAt),
      ),
    ).toThrow(/newer observed_at/);
    expect(() =>
      store.transaction(() =>
        importCommerceLedger(store, commerceStore, corrected, 'Duplicate', correctedAt),
      ),
    ).toThrow(/already imported/);
  });

  it('fixes campaign SKU identity and copies the verified readiness contract', () => {
    const commerceStore = createCommerceStore(
      store,
      'workspace',
      { name: 'Test store', provider: 'manual', timezone: 'UTC', maxDataAgeHours: 72 },
      now,
    );
    const [first, second] = saveCommerceProducts(
      store,
      commerceStore,
      [
        { ...baseProduct, externalVariantId: 'gid://shopify/ProductVariant/1001' },
        { ...baseProduct, productRef: 'other-product', sku: 'ENT-OTHER-001' },
      ],
      now,
    );
    expect(() =>
      saveCommerceProducts(
        store,
        commerceStore,
        [
          {
            ...baseProduct,
            productRef: 'duplicate-external-product',
            sku: 'ENT-DUPLICATE-001',
            externalVariantId: 'gid://shopify/ProductVariant/1001',
          },
        ],
        now,
      ),
    ).toThrow(/external variant ID/);
    const c = campaign();
    store.saveCampaign(c);
    const linked = linkCommerceCampaign(store, first, c, now);
    expect(linked).toMatchObject({
      entityName: 'Sequential Indicators · Smoked',
      retailPriceCents: 2000,
      netReceiptCents: 1800,
      variableCostCents: 800,
      targetProfitCents: 300,
      economicsVerified: true,
      trackingVerified: true,
      supplyReady: true,
    });
    expect(commerceCampaignBlockers(store, linked, now)).toEqual([]);
    const proposal = {
      kind: 'scale' as const,
      title: 'Review a measured increase',
      reason: 'Synthetic proposal.',
      blockers: [],
      probabilityProfitable: 0.96,
      suggestedDailyBudgetCents: 1200,
      maxAffordableCpcCents: 50,
      matureClicks: 100,
      matureOrders: 20,
      matureThrough: '2026-09-14',
      evidenceId: 'campaign-evidence',
    };
    const readyDecision = gateCommerceDecision(store, linked, proposal, now);
    expect(readyDecision.kind).toBe('scale');
    expect(readyDecision.evidenceId).not.toBe(proposal.evidenceId);
    expect(() => linkCommerceCampaign(store, second, linked, now)).toThrow(/identity is fixed/);
    const stale = { ...first, inventoryVerifiedAt: '2026-08-01T00:00:00.000Z' };
    store.db
      .prepare('UPDATE commerce_products SET body=? WHERE id=?')
      .run(JSON.stringify(stale), first.id);
    expect(commerceCampaignBlockers(store, linked, now).join(' ')).toMatch(/inventory/);
    const blockedDecision = gateCommerceDecision(store, linked, proposal, now);
    expect(blockedDecision).toMatchObject({ kind: 'repair', suggestedDailyBudgetCents: null });
    expect(blockedDecision.evidenceId).not.toBe(readyDecision.evidenceId);
    expect(gateCommerceDecision(store, linked, { ...proposal, kind: 'reduce' }, now).kind).toBe(
      'reduce',
    );
  });

  it('keeps paid-ledger freshness scoped to each exact SKU', () => {
    const commerceStore = createCommerceStore(
      store,
      'workspace',
      { name: 'Test store', provider: 'manual', timezone: 'UTC', maxDataAgeHours: 72 },
      now,
    );
    const [staleProduct, freshProduct] = saveCommerceProducts(
      store,
      commerceStore,
      [baseProduct, { ...baseProduct, productRef: 'fresh-product', sku: 'ENT-FRESH-001' }],
      now,
    );
    for (const [product, id] of [
      [staleProduct, 'stale-campaign'],
      [freshProduct, 'fresh-campaign'],
    ] as const) {
      const linkedCampaign = campaign(id);
      store.saveCampaign(linkedCampaign);
      linkCommerceCampaign(store, product, linkedCampaign, now);
      store.importRows([
        {
          campaignId: id,
          date: '2026-09-10',
          impressions: 1000,
          clicks: 50,
          orders: 1,
          spendCents: 500,
          salesCents: 2000,
          refundsCents: 0,
          observedAt: now.toISOString(),
        },
      ]);
    }
    const rows = parseCommerceLedger(
      [
        'order_ref,line_ref,date,sku,units,net_receipts_cents,refunds_cents,chargebacks_cents,observed_at',
        'stale-order,line-1,2026-09-10,ENT-SEQ-001,1,1800,0,0,2026-09-01T00:00:00.000Z',
        `fresh-order,line-1,2026-09-10,ENT-FRESH-001,1,1800,0,0,${now.toISOString()}`,
      ].join('\n'),
      commerceStore.id,
    );
    store.transaction(() =>
      importCommerceLedger(store, commerceStore, rows, 'Mixed freshness', now),
    );
    const views = new Map(
      commerceProductViews(store, 'workspace', 28, now).map((product) => [product.sku, product]),
    );
    expect(views.get('ENT-SEQ-001')?.status).toBe('stale-ledger');
    expect(views.get('ENT-FRESH-001')?.status).toBe('positive');
    expect(
      commerceCampaignBlockers(store, store.campaign('workspace', 'stale-campaign'), now).join(' '),
    ).toMatch(/paid-order ledger/);
    expect(
      commerceCampaignBlockers(store, store.campaign('workspace', 'fresh-campaign'), now),
    ).toEqual([]);
    expect(() =>
      store.transaction(() =>
        importCommerceLedger(
          store,
          commerceStore,
          [
            {
              ...rows[1],
              orderRef: 'future-order',
              observedAt: '2026-09-23T00:00:00.000Z',
            },
          ],
          'Future export',
          now,
        ),
      ),
    ).toThrow(/timestamp in the future/);
  });
});

describe('commerce API at portfolio scale', () => {
  const row = (index: number) => {
    const values: Record<(typeof commerceProductHeaders)[number], string> = {
      product_ref: `product-${index}`,
      sku: `SKU-${String(index).padStart(5, '0')}`,
      name: `Product ${index}`,
      variant_name: 'Default',
      external_variant_id: '',
      inventory_mode: 'stocked',
      retail_price_cents: '2000',
      planned_net_receipt_cents: '1800',
      unit_cost_cents: '400',
      inbound_freight_cents: '100',
      duties_and_fees_cents: '50',
      packaging_cost_cents: '50',
      payment_fee_allowance_cents: '50',
      outbound_fulfillment_cents: '100',
      return_allowance_cents: '25',
      warranty_allowance_cents: '10',
      support_allowance_cents: '15',
      profit_reserve_cents: '300',
      loss_limit_cents: '5000',
      daily_budget_limit_cents: '3000',
      economics_verified: 'true',
      commercial_rights_approved: 'true',
      product_evidence_approved: 'true',
      claims_approved: 'true',
      tracking_verified: 'true',
      fulfillment_ready: 'true',
      release_approved: 'true',
      route_verified: 'true',
      preorder_terms_approved: 'false',
      available_units: '100',
      committed_units: '0',
      quarantined_units: '0',
      supplier_capacity_units: '',
      preorder_capacity_units: '',
      safety_stock_units: '20',
      reorder_point_units: '30',
      inventory_verified_at: now.toISOString(),
      inventory_max_age_hours: '168',
    };
    return commerceProductHeaders.map((header) => values[header]).join(',');
  };
  const csv = (count: number) =>
    [
      commerceProductHeaders.join(','),
      ...Array.from({ length: count }, (_, index) => row(index)),
    ].join('\n');

  it('imports, searches, paginates, and updates 500 stable SKUs', async () => {
    const app = createApp(store);
    const createdStore = await request(app)
      .post('/api/commerce/stores')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        store: { name: 'Scale store', provider: 'manual', timezone: 'UTC', maxDataAgeHours: 72 },
      })
      .expect(201);
    const storeId = createdStore.body.id;
    const imported = await request(app)
      .post('/api/commerce/products/import')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', storeId, csv: csv(500) })
      .expect(201);
    expect(imported.body).toEqual({ created: 500, updated: 0 });
    const list = await request(app).get('/api/commerce?dataset=workspace&page=10').expect(200);
    expect(list.body).toMatchObject({
      total: 500,
      page: 10,
      pages: 10,
      summary: { skus: 500, saleReady: 500, sellableUnits: 40_000 },
    });
    expect(list.body.products).toHaveLength(50);
    const firstId = list.body.products[0].id;
    const again = await request(app)
      .post('/api/commerce/products/import')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', storeId, csv: csv(500) })
      .expect(201);
    expect(again.body).toEqual({ created: 0, updated: 500 });
    expect(
      (await request(app).get('/api/commerce?dataset=workspace&page=10')).body.products[0].id,
    ).toBe(firstId);
    const filtered = await request(app)
      .get('/api/commerce?dataset=workspace&query=Product%20499')
      .expect(200);
    expect(filtered.body.total).toBe(1);
    expect((await request(app).get('/api/commerce?dataset=demo')).body.total).toBe(0);
  });

  it('rejects unknown order SKUs, person-level columns, and cross-workspace mutations', async () => {
    const app = createApp(store);
    const commerceStore = createCommerceStore(
      store,
      'workspace',
      { name: 'Test store', provider: 'manual', timezone: 'UTC', maxDataAgeHours: 72 },
      now,
    );
    saveCommerceProducts(store, commerceStore, [baseProduct], now);
    const invalidHeader =
      'order_ref,line_ref,date,sku,units,net_receipts_cents,refunds_cents,chargebacks_cents,observed_at,email\n';
    await request(app)
      .post('/api/commerce/ledger/import')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        storeId: commerceStore.id,
        sourceName: 'Bad',
        csv: invalidHeader,
      })
      .expect(400);
    const unknown = [
      'order_ref,line_ref,date,sku,units,net_receipts_cents,refunds_cents,chargebacks_cents,observed_at',
      `order-1,line-1,2026-09-10,UNKNOWN,1,1000,0,0,${now.toISOString()}`,
    ].join('\n');
    await request(app)
      .post('/api/commerce/ledger/import')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', storeId: commerceStore.id, sourceName: 'Bad', csv: unknown })
      .expect(400);
    const wrongCase = unknown.replace('UNKNOWN', baseProduct.sku.toLowerCase());
    await request(app)
      .post('/api/commerce/ledger/import')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        storeId: commerceStore.id,
        sourceName: 'Wrong SKU case',
        csv: wrongCase,
      })
      .expect(400);
    await request(app)
      .post('/api/commerce/products/import')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'demo', storeId: commerceStore.id, csv: csv(1) })
      .expect(400);
  });
});
