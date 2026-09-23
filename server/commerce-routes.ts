import type { Express } from 'express';
import { z } from 'zod';
import type { CommercePortfolio } from '../shared/commerce.js';
import { Store } from './store.js';
import { AppError, datasetSchema } from './validation.js';
import {
  commerceLedgerBatches,
  commerceLedgerHeaders,
  commerceOrderLines,
  commerceProductById,
  commerceProductHeaders,
  commerceProductInput,
  commerceProducts,
  commerceProductViews,
  commerceStoreById,
  commerceStoreInput,
  commerceStores,
  createCommerceStore,
  importCommerceLedger,
  linkCommerceCampaign,
  parseCommerceLedger,
  parseCommerceProducts,
  saveCommerceProducts,
} from './commerce.js';

export function commerceRoutes(app: Express, store: Store) {
  app.get('/api/commerce', (req, res) => {
    const input = z
      .object({
        dataset: datasetSchema,
        days: z.enum(['7', '28', '56']).default('28'),
        query: z.string().max(300).default(''),
        storeId: z.string().max(160).default('all'),
        status: z.enum(['all', 'attention', 'positive', 'learning']).default('all'),
        page: z.coerce.number().int().min(1).max(10000).default(1),
      })
      .strict()
      .parse(req.query);
    const stores = commerceStores(store, input.dataset);
    if (input.storeId !== 'all' && !stores.some((value) => value.id === input.storeId))
      throw new AppError('Commerce store not found in this workspace.', 404);
    const all = commerceProductViews(store, input.dataset, Number(input.days)).filter(
      (product) => input.storeId === 'all' || product.storeId === input.storeId,
    );
    const attention = (product: (typeof all)[number]) =>
      !['positive', 'learning'].includes(product.status);
    const filtered = all.filter(
      (product) =>
        `${product.name} ${product.variantName} ${product.sku} ${product.productRef} ${product.storeName}`
          .toLowerCase()
          .includes(input.query.toLowerCase()) &&
        (input.status === 'all' ||
          (input.status === 'attention' ? attention(product) : product.status === input.status)),
    );
    const pages = Math.max(1, Math.ceil(filtered.length / 50));
    const page = Math.min(input.page, pages);
    const storeIds = new Set(
      stores
        .filter((value) => input.storeId === 'all' || value.id === input.storeId)
        .map((value) => value.id),
    );
    const catalog = new Set(all.map((product) => `${product.storeId}\u0000${product.sku}`));
    const unmapped = new Set<string>();
    for (const commerceStore of stores)
      if (storeIds.has(commerceStore.id))
        for (const line of commerceOrderLines(store, commerceStore.id)) {
          const key = `${commerceStore.id}\u0000${line.sku}`;
          if (!catalog.has(key)) unmapped.add(key);
        }
    const safeTotal = (values: number[]) => {
      const value = values.reduce((total, item) => total + BigInt(item), 0n);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER))
        throw new AppError('Commerce portfolio totals exceed the supported whole-number range.');
      return Number(value);
    };
    const result: CommercePortfolio = {
      dataset: input.dataset,
      days: Number(input.days),
      stores,
      products: filtered.slice((page - 1) * 50, page * 50),
      total: filtered.length,
      page,
      pages,
      recentBatches: commerceLedgerBatches(store, input.dataset, 20).filter((batch) =>
        storeIds.has(batch.storeId),
      ),
      summary: {
        skus: all.length,
        saleReady: all.filter((product) => product.readiness.saleReady).length,
        needsAttention: all.filter(attention).length,
        sellableUnits: safeTotal(all.map((product) => product.sellableUnits || 0)),
        adSpendCents: safeTotal(all.map((product) => product.adSpendCents)),
        ledgerNetReceiptsCents: safeTotal(all.map((product) => product.ledgerNetReceiptsCents)),
        ledgerContributionCents: safeTotal(
          all.map((product) => product.ledgerContributionCents || 0),
        ),
        measuredSkus: all.filter(
          (product) => product.ledgerContributionCents !== null && product.ledgerUnits > 0,
        ).length,
        unmappedOrderSkus: unmapped.size,
      },
    };
    res.json(result);
  });

  app.get('/api/commerce/products/template', (_req, res) =>
    res
      .type('text/csv')
      .attachment('orbit-product-catalog.csv')
      .send(commerceProductHeaders.join(',') + '\n'),
  );
  app.get('/api/commerce/ledger/template', (_req, res) =>
    res
      .type('text/csv')
      .attachment('orbit-paid-order-ledger.csv')
      .send(commerceLedgerHeaders.join(',') + '\n'),
  );

  app.post('/api/commerce/stores', (req, res) => {
    const { dataset, store: input } = z
      .object({ dataset: z.literal('workspace'), store: commerceStoreInput })
      .strict()
      .parse(req.body);
    res.status(201).json(
      store.transaction(() => {
        const saved = createCommerceStore(store, dataset, input);
        store.activity(
          dataset,
          'system',
          'Commerce store registered',
          `${saved.name} · manual, aggregate paid-order contract. No customer data or credentials stored.`,
        );
        return saved;
      }),
    );
  });

  app.post('/api/commerce/products', (req, res) => {
    const { dataset, storeId, product } = z
      .object({
        dataset: z.literal('workspace'),
        storeId: z.string().min(1),
        product: commerceProductInput,
      })
      .strict()
      .parse(req.body);
    const commerceStore = commerceStoreById(store, dataset, storeId);
    res.status(201).json(
      store.transaction(() => {
        const [saved] = saveCommerceProducts(store, commerceStore, [product]);
        store.activity(
          dataset,
          'campaign',
          'Product economics saved',
          `${saved.name} · ${saved.sku}. Readiness is derived from evidence, inventory, and release gates.`,
        );
        return saved;
      }),
    );
  });

  app.post('/api/commerce/products/import', (req, res) => {
    const input = z
      .object({
        dataset: z.literal('workspace'),
        storeId: z.string().min(1),
        csv: z.string().min(1).max(2_000_000),
      })
      .strict()
      .parse(req.body);
    const commerceStore = commerceStoreById(store, input.dataset, input.storeId);
    const parsed = parseCommerceProducts(input.csv);
    const existing = new Set(
      commerceProducts(store, input.dataset)
        .filter((product) => product.storeId === commerceStore.id)
        .map((product) => product.sku),
    );
    store.transaction(() => {
      saveCommerceProducts(store, commerceStore, parsed);
      store.activity(
        input.dataset,
        'import',
        'Product catalog imported',
        `${parsed.length} SKUs for ${commerceStore.name}. Unknown economics remain explicitly unverified.`,
      );
    });
    res.status(201).json({
      created: parsed.filter((product) => !existing.has(product.sku)).length,
      updated: parsed.filter((product) => existing.has(product.sku)).length,
    });
  });

  app.post('/api/commerce/ledger/import', (req, res) => {
    const input = z
      .object({
        dataset: z.literal('workspace'),
        storeId: z.string().min(1),
        sourceName: z.string().trim().min(1).max(160),
        csv: z.string().min(1).max(2_000_000),
      })
      .strict()
      .parse(req.body);
    const commerceStore = commerceStoreById(store, input.dataset, input.storeId);
    const rows = parseCommerceLedger(input.csv, commerceStore.id);
    const batch = store.transaction(() => {
      const saved = importCommerceLedger(store, commerceStore, rows, input.sourceName);
      store.activity(
        input.dataset,
        'import',
        'Paid-order ledger reconciled',
        `${commerceStore.name}: ${saved.inserted} new, ${saved.corrected} corrected, ${saved.unchanged} unchanged order lines.`,
      );
      return saved;
    });
    res.status(201).json(batch);
  });

  app.get('/api/commerce/ledger/batches/:id/revisions', (req, res) => {
    const { dataset, page: requestedPage } = z
      .object({
        dataset: datasetSchema,
        page: z.coerce.number().int().min(1).max(10000).default(1),
      })
      .strict()
      .parse(req.query);
    const batch = store.db
      .prepare('SELECT body FROM commerce_ledger_batches WHERE id=? AND dataset=?')
      .get(String(req.params.id), dataset) as { body: string } | undefined;
    if (!batch) throw new AppError('Ledger import not found in this workspace.', 404);
    const total = (
      store.db
        .prepare('SELECT COUNT(*) AS count FROM commerce_ledger_revisions WHERE batch_id=?')
        .get(String(req.params.id)) as { count: number }
    ).count;
    const pages = Math.max(1, Math.ceil(total / 100));
    const page = Math.min(requestedPage, pages);
    const revisions = (
      store.db
        .prepare(
          'SELECT body FROM commerce_ledger_revisions WHERE batch_id=? ORDER BY position LIMIT 100 OFFSET ?',
        )
        .all(String(req.params.id), (page - 1) * 100) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
    res.json({ batch: JSON.parse(batch.body), revisions, total, page, pages });
  });

  app.get('/api/commerce/products/:id/campaigns', (req, res) => {
    const { dataset } = z.object({ dataset: datasetSchema }).strict().parse(req.query);
    const product = commerceProductById(store, dataset, String(req.params.id));
    const mappings = new Map(
      (
        store.db.prepare('SELECT campaign_id,product_id FROM commerce_campaigns').all() as {
          campaign_id: string;
          product_id: string;
        }[]
      ).map((mapping) => [mapping.campaign_id, mapping.product_id]),
    );
    res.json({
      campaigns: store
        .campaigns(dataset)
        .filter((campaign) => campaign.vertical === 'commerce')
        .filter(
          (campaign) => !mappings.has(campaign.id) || mappings.get(campaign.id) === product.id,
        )
        .map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          channel: campaign.channel,
          mappedProductId: mappings.get(campaign.id) || null,
        })),
    });
  });

  app.post('/api/commerce/products/:id/link', (req, res) => {
    const { dataset, campaignId } = z
      .object({ dataset: z.literal('workspace'), campaignId: z.string().min(1).max(160) })
      .strict()
      .parse(req.body);
    const product = commerceProductById(store, dataset, String(req.params.id));
    const campaign = store.campaign(dataset, campaignId);
    const next = store.transaction(() => {
      const saved = linkCommerceCampaign(store, product, campaign);
      store.activity(
        dataset,
        'campaign',
        'Product and campaign reconciled',
        `${campaign.name} uses ${product.name} · ${product.sku}. Readiness and economics were copied from the SKU record.`,
      );
      return saved;
    });
    res.json({ ok: true, campaign: next });
  });
}
