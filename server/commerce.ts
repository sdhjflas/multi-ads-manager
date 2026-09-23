import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type {
  CommerceLedgerBatch,
  CommerceLedgerRevision,
  CommerceOrderLine,
  CommerceProduct,
  CommerceProductView,
  CommerceReadiness,
  CommerceStore,
} from '../shared/commerce.js';
import type { Campaign, Dataset, Decision, Observation } from '../shared/types.js';
import { dayAt } from './engine.js';
import { Store } from './store.js';
import { AppError, dateOnly } from './validation.js';

const nullableCents = z.number().int().min(0).max(100_000_000).nullable();
const nullableUnits = z.number().int().min(0).max(100_000_000).nullable();
const ref = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    'References cannot contain control characters.',
  );
const timezone = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Use a valid IANA timezone.');

export const commerceStoreInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    provider: z.literal('manual').default('manual'),
    timezone,
    maxDataAgeHours: z.number().int().min(1).max(720).default(72),
  })
  .strict();

export const costFields = [
  'unitCostCents',
  'inboundFreightCents',
  'dutiesAndFeesCents',
  'packagingCostCents',
  'paymentFeeAllowanceCents',
  'outboundFulfillmentCents',
  'returnAllowanceCents',
  'warrantyAllowanceCents',
  'supportAllowanceCents',
] as const satisfies readonly (keyof CommerceProduct)[];

export const commerceProductInput = z
  .object({
    productRef: ref,
    sku: ref,
    name: z.string().trim().min(1).max(240),
    variantName: z.string().trim().max(160).default(''),
    externalVariantId: z.string().trim().max(200).default(''),
    inventoryMode: z.enum(['stocked', 'supplier-direct', 'preorder']),
    retailPriceCents: nullableCents,
    plannedNetReceiptCents: nullableCents,
    unitCostCents: nullableCents,
    inboundFreightCents: nullableCents,
    dutiesAndFeesCents: nullableCents,
    packagingCostCents: nullableCents,
    paymentFeeAllowanceCents: nullableCents,
    outboundFulfillmentCents: nullableCents,
    returnAllowanceCents: nullableCents,
    warrantyAllowanceCents: nullableCents,
    supportAllowanceCents: nullableCents,
    profitReserveCents: nullableCents,
    lossLimitCents: nullableCents,
    dailyBudgetLimitCents: nullableCents,
    economicsVerified: z.boolean(),
    commercialRightsApproved: z.boolean(),
    productEvidenceApproved: z.boolean(),
    claimsApproved: z.boolean(),
    trackingVerified: z.boolean(),
    fulfillmentReady: z.boolean(),
    releaseApproved: z.boolean(),
    routeVerified: z.boolean(),
    preorderTermsApproved: z.boolean(),
    availableUnits: nullableUnits,
    committedUnits: nullableUnits,
    quarantinedUnits: nullableUnits,
    supplierCapacityUnits: nullableUnits,
    preorderCapacityUnits: nullableUnits,
    safetyStockUnits: nullableUnits,
    reorderPointUnits: nullableUnits,
    inventoryVerifiedAt: z.iso.datetime().nullable(),
    inventoryMaxAgeHours: z.number().int().min(1).max(2160).default(168),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.retailPriceCents !== null &&
      value.plannedNetReceiptCents !== null &&
      value.plannedNetReceiptCents > value.retailPriceCents
    )
      context.addIssue({
        code: 'custom',
        message: 'Planned net receipts cannot exceed retail price.',
      });
    if (value.economicsVerified) {
      const required = [
        'retailPriceCents',
        'plannedNetReceiptCents',
        ...costFields,
        'profitReserveCents',
        'lossLimitCents',
        'dailyBudgetLimitCents',
      ] as const;
      if (required.some((key) => value[key] === null))
        context.addIssue({
          code: 'custom',
          message: 'Verified economics require the complete cost stack and operating limits.',
        });
      if (value.retailPriceCents === 0)
        context.addIssue({ code: 'custom', message: 'Verified retail price must be positive.' });
      if (value.lossLimitCents === 0 || value.dailyBudgetLimitCents === 0)
        context.addIssue({
          code: 'custom',
          message: 'Verified operating limits must be positive.',
        });
    }
  });
export type CommerceProductInput = z.infer<typeof commerceProductInput>;

export const commerceProductHeaders = [
  'product_ref',
  'sku',
  'name',
  'variant_name',
  'external_variant_id',
  'inventory_mode',
  'retail_price_cents',
  'planned_net_receipt_cents',
  'unit_cost_cents',
  'inbound_freight_cents',
  'duties_and_fees_cents',
  'packaging_cost_cents',
  'payment_fee_allowance_cents',
  'outbound_fulfillment_cents',
  'return_allowance_cents',
  'warranty_allowance_cents',
  'support_allowance_cents',
  'profit_reserve_cents',
  'loss_limit_cents',
  'daily_budget_limit_cents',
  'economics_verified',
  'commercial_rights_approved',
  'product_evidence_approved',
  'claims_approved',
  'tracking_verified',
  'fulfillment_ready',
  'release_approved',
  'route_verified',
  'preorder_terms_approved',
  'available_units',
  'committed_units',
  'quarantined_units',
  'supplier_capacity_units',
  'preorder_capacity_units',
  'safety_stock_units',
  'reorder_point_units',
  'inventory_verified_at',
  'inventory_max_age_hours',
] as const;

const parseExactCsv = (csv: string, headers: readonly string[], label: string) => {
  try {
    return parse(csv, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 20_000,
      columns: (names: string[]) => {
        if (
          names.length !== headers.length ||
          new Set(names).size !== headers.length ||
          names.some((name) => !headers.includes(name))
        )
          throw new Error();
        return names;
      },
    }) as Record<string, string>[];
  } catch {
    throw new AppError(`Use the exact columns in the ${label} template.`);
  }
};

const csvBoolean = (value: string) =>
  value === 'true' ? true : value === 'false' ? false : undefined;
const csvNullableInteger = (value: string) =>
  value === '' ? null : /^\d+$/.test(value) ? Number(value) : Number.NaN;

export function parseCommerceProducts(csv: string): CommerceProductInput[] {
  const rows = parseExactCsv(csv, commerceProductHeaders, 'product catalog');
  if (!rows.length || rows.length > 2000) throw new AppError('Import 1 to 2,000 SKUs at a time.');
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const parsed = commerceProductInput.safeParse({
      productRef: row.product_ref,
      sku: row.sku,
      name: row.name,
      variantName: row.variant_name,
      externalVariantId: row.external_variant_id,
      inventoryMode: row.inventory_mode,
      retailPriceCents: csvNullableInteger(row.retail_price_cents),
      plannedNetReceiptCents: csvNullableInteger(row.planned_net_receipt_cents),
      unitCostCents: csvNullableInteger(row.unit_cost_cents),
      inboundFreightCents: csvNullableInteger(row.inbound_freight_cents),
      dutiesAndFeesCents: csvNullableInteger(row.duties_and_fees_cents),
      packagingCostCents: csvNullableInteger(row.packaging_cost_cents),
      paymentFeeAllowanceCents: csvNullableInteger(row.payment_fee_allowance_cents),
      outboundFulfillmentCents: csvNullableInteger(row.outbound_fulfillment_cents),
      returnAllowanceCents: csvNullableInteger(row.return_allowance_cents),
      warrantyAllowanceCents: csvNullableInteger(row.warranty_allowance_cents),
      supportAllowanceCents: csvNullableInteger(row.support_allowance_cents),
      profitReserveCents: csvNullableInteger(row.profit_reserve_cents),
      lossLimitCents: csvNullableInteger(row.loss_limit_cents),
      dailyBudgetLimitCents: csvNullableInteger(row.daily_budget_limit_cents),
      economicsVerified: csvBoolean(row.economics_verified),
      commercialRightsApproved: csvBoolean(row.commercial_rights_approved),
      productEvidenceApproved: csvBoolean(row.product_evidence_approved),
      claimsApproved: csvBoolean(row.claims_approved),
      trackingVerified: csvBoolean(row.tracking_verified),
      fulfillmentReady: csvBoolean(row.fulfillment_ready),
      releaseApproved: csvBoolean(row.release_approved),
      routeVerified: csvBoolean(row.route_verified),
      preorderTermsApproved: csvBoolean(row.preorder_terms_approved),
      availableUnits: csvNullableInteger(row.available_units),
      committedUnits: csvNullableInteger(row.committed_units),
      quarantinedUnits: csvNullableInteger(row.quarantined_units),
      supplierCapacityUnits: csvNullableInteger(row.supplier_capacity_units),
      preorderCapacityUnits: csvNullableInteger(row.preorder_capacity_units),
      safetyStockUnits: csvNullableInteger(row.safety_stock_units),
      reorderPointUnits: csvNullableInteger(row.reorder_point_units),
      inventoryVerifiedAt: row.inventory_verified_at || null,
      inventoryMaxAgeHours: /^\d+$/.test(row.inventory_max_age_hours)
        ? Number(row.inventory_max_age_hours)
        : Number.NaN,
    });
    if (!parsed.success)
      throw new AppError(
        `Row ${index + 2}: ${parsed.error.issues[0].message}. Money uses whole cents; unknown numbers stay blank; flags use true or false.`,
      );
    const key = parsed.data.sku;
    if (seen.has(key)) throw new AppError(`Row ${index + 2}: duplicate SKU in this import.`);
    seen.add(key);
    return parsed.data;
  });
}

export function commerceStores(store: Store, dataset: Dataset): CommerceStore[] {
  return (
    store.db
      .prepare('SELECT body FROM commerce_stores WHERE dataset=? ORDER BY id')
      .all(dataset) as { body: string }[]
  ).map((row) => JSON.parse(row.body));
}

export function commerceStoreById(store: Store, dataset: Dataset, id: string): CommerceStore {
  const row = store.db
    .prepare('SELECT body FROM commerce_stores WHERE dataset=? AND id=?')
    .get(dataset, id) as { body: string } | undefined;
  if (!row) throw new AppError('Commerce store not found in this workspace.', 404);
  return JSON.parse(row.body);
}

export function createCommerceStore(
  store: Store,
  dataset: Dataset,
  input: z.infer<typeof commerceStoreInput>,
  now = new Date(),
): CommerceStore {
  if (commerceStores(store, dataset).length >= 50)
    throw new AppError('This local release supports 50 commerce stores per workspace.');
  const value: CommerceStore = {
    id: randomUUID(),
    dataset,
    name: input.name,
    provider: input.provider,
    shopDomain: null,
    currency: 'USD',
    timezone: input.timezone,
    maxDataAgeHours: input.maxDataAgeHours,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  store.db
    .prepare('INSERT INTO commerce_stores(id,dataset,body) VALUES(?,?,?)')
    .run(value.id, value.dataset, JSON.stringify(value));
  return value;
}

export function commerceProducts(store: Store, dataset: Dataset): CommerceProduct[] {
  return (
    store.db
      .prepare('SELECT body FROM commerce_products WHERE dataset=? ORDER BY sku')
      .all(dataset) as { body: string }[]
  ).map((row) => JSON.parse(row.body));
}

export function commerceProductById(store: Store, dataset: Dataset, id: string): CommerceProduct {
  const row = store.db
    .prepare('SELECT body FROM commerce_products WHERE dataset=? AND id=?')
    .get(dataset, id) as { body: string } | undefined;
  if (!row) throw new AppError('Product not found in this workspace.', 404);
  return JSON.parse(row.body);
}

export function saveCommerceProducts(
  store: Store,
  commerceStore: CommerceStore,
  inputs: CommerceProductInput[],
  now = new Date(),
): CommerceProduct[] {
  const existingProducts = commerceProducts(store, commerceStore.dataset).filter(
    (product) => product.storeId === commerceStore.id,
  );
  const prior = new Map(existingProducts.map((product) => [product.sku, product]));
  const externalOwners = new Map(
    existingProducts
      .filter((product) => product.externalVariantId)
      .map((product) => [product.externalVariantId, product.sku]),
  );
  const inputSkus = new Set<string>();
  for (const input of inputs) {
    if (inputSkus.has(input.sku)) throw new AppError('A product save cannot repeat the same SKU.');
    inputSkus.add(input.sku);
    const old = prior.get(input.sku);
    if (old && old.productRef !== input.productRef)
      throw new AppError('A SKU cannot change product identity. Create a new SKU record.');
    if (old?.externalVariantId && input.externalVariantId !== old.externalVariantId)
      throw new AppError('A linked external variant ID cannot change. Create a new SKU record.');
    const externalOwner = input.externalVariantId
      ? externalOwners.get(input.externalVariantId)
      : undefined;
    if (externalOwner && externalOwner !== input.sku)
      throw new AppError('An external variant ID can belong to only one SKU in a store.');
    if (input.externalVariantId) externalOwners.set(input.externalVariantId, input.sku);
  }
  if (prior.size + [...inputSkus].filter((sku) => !prior.has(sku)).length > 20_000)
    throw new AppError('This local release supports 20,000 SKUs per store.');
  const put = store.db.prepare(
    'INSERT INTO commerce_products(id,dataset,store_id,sku,body) VALUES(?,?,?,?,?) ON CONFLICT(store_id,sku) DO UPDATE SET body=excluded.body',
  );
  return inputs.map((input) => {
    const old = prior.get(input.sku);
    const product: CommerceProduct = {
      ...input,
      id: old?.id || randomUUID(),
      dataset: commerceStore.dataset,
      storeId: commerceStore.id,
      createdAt: old?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
    };
    put.run(product.id, product.dataset, product.storeId, product.sku, JSON.stringify(product));
    return product;
  });
}

export const commerceLedgerHeaders = [
  'order_ref',
  'line_ref',
  'date',
  'sku',
  'units',
  'net_receipts_cents',
  'refunds_cents',
  'chargebacks_cents',
  'observed_at',
] as const;

const ledgerRow = z
  .object({
    orderRef: ref,
    lineRef: ref,
    date: z.string().refine(dateOnly, 'Use a real YYYY-MM-DD date.'),
    sku: ref,
    units: z.number().int().min(1).max(100_000),
    netReceiptsCents: z.number().int().min(0).max(100_000_000),
    refundsCents: z.number().int().min(0).max(100_000_000),
    chargebacksCents: z.number().int().min(0).max(100_000_000),
    observedAt: z.iso.datetime(),
  })
  .strict();

export function parseCommerceLedger(csv: string, storeId: string): CommerceOrderLine[] {
  const rows = parseExactCsv(csv, commerceLedgerHeaders, 'paid-order ledger');
  if (!rows.length || rows.length > 20_000)
    throw new AppError('Import 1 to 20,000 paid order lines at a time.');
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const integer = (key: string) => (/^\d+$/.test(row[key] || '') ? Number(row[key]) : Number.NaN);
    const parsed = ledgerRow.safeParse({
      orderRef: row.order_ref,
      lineRef: row.line_ref,
      date: row.date,
      sku: row.sku,
      units: integer('units'),
      netReceiptsCents: integer('net_receipts_cents'),
      refundsCents: integer('refunds_cents'),
      chargebacksCents: integer('chargebacks_cents'),
      observedAt: row.observed_at,
    });
    if (!parsed.success)
      throw new AppError(
        `Row ${index + 2}: ${parsed.error.issues[0].message}. Import paid, non-test lines without customer data.`,
      );
    const key = `${parsed.data.orderRef}\u0000${parsed.data.lineRef}`;
    if (seen.has(key)) throw new AppError(`Row ${index + 2}: duplicate order line in this import.`);
    seen.add(key);
    return { ...parsed.data, storeId };
  });
}

export function commerceOrderLines(store: Store, storeId: string): CommerceOrderLine[] {
  return (
    store.db
      .prepare(
        'SELECT body FROM commerce_order_lines WHERE store_id=? ORDER BY date,order_ref,line_ref',
      )
      .all(storeId) as { body: string }[]
  ).map((row) => JSON.parse(row.body));
}

export function commerceLedgerBatches(
  store: Store,
  dataset: Dataset,
  limit = 50,
): CommerceLedgerBatch[] {
  return (
    store.db
      .prepare(
        'SELECT body FROM commerce_ledger_batches WHERE dataset=? ORDER BY created_at DESC LIMIT ?',
      )
      .all(dataset, limit) as { body: string }[]
  ).map((row) => JSON.parse(row.body));
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function importCommerceLedger(
  store: Store,
  commerceStore: CommerceStore,
  rows: CommerceOrderLine[],
  sourceName: string,
  now = new Date(),
): CommerceLedgerBatch {
  for (const row of rows) {
    if (row.storeId !== commerceStore.id)
      throw new AppError('Every paid-order line must belong to the selected store.');
    if (Date.parse(row.observedAt) > now.getTime() + 5 * 60_000)
      throw new AppError(
        `Order line ${row.orderRef}/${row.lineRef} has an observed_at timestamp in the future.`,
      );
  }
  const contentHash = digest(rows);
  if (
    store.db
      .prepare('SELECT 1 FROM commerce_ledger_batches WHERE store_id=? AND content_hash=?')
      .get(commerceStore.id, contentHash)
  )
    throw new AppError('This exact paid-order ledger was already imported.', 409);
  const catalog = new Set(
    commerceProducts(store, commerceStore.dataset)
      .filter((product) => product.storeId === commerceStore.id)
      .map((product) => product.sku),
  );
  for (const row of rows)
    if (!catalog.has(row.sku))
      throw new AppError(`Order line ${row.orderRef}/${row.lineRef} uses unknown SKU ${row.sku}.`);
  const get = store.db.prepare(
    'SELECT body FROM commerce_order_lines WHERE store_id=? AND order_ref=? AND line_ref=?',
  );
  const put = store.db.prepare(
    'INSERT INTO commerce_order_lines(store_id,order_ref,line_ref,sku,date,observed_at,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(store_id,order_ref,line_ref) DO UPDATE SET sku=excluded.sku,date=excluded.date,observed_at=excluded.observed_at,body=excluded.body',
  );
  let inserted = 0,
    corrected = 0,
    unchanged = 0;
  const revisions: CommerceLedgerRevision[] = [];
  for (const row of rows) {
    const existing = get.get(row.storeId, row.orderRef, row.lineRef) as
      { body: string } | undefined;
    const old = existing ? (JSON.parse(existing.body) as CommerceOrderLine) : null;
    if (old && (old.sku !== row.sku || old.date !== row.date))
      throw new AppError(
        'An order line cannot change SKU or order date. Correct the source identity.',
      );
    const oldObservedAt = old ? Date.parse(old.observedAt) : null;
    const nextObservedAt = Date.parse(row.observedAt);
    if (oldObservedAt !== null && oldObservedAt > nextObservedAt)
      throw new AppError('An older order export cannot replace a newer ledger line.');
    if (
      oldObservedAt !== null &&
      oldObservedAt === nextObservedAt &&
      JSON.stringify(old) !== JSON.stringify(row)
    )
      throw new AppError('A changed order line needs a newer observed_at timestamp.');
    if (old && JSON.stringify(old) === JSON.stringify(row)) {
      unchanged++;
      continue;
    }
    if (old) corrected++;
    else inserted++;
    revisions.push({ before: old, after: row });
  }
  const dates = rows.map((row) => row.date).sort();
  const batch: CommerceLedgerBatch = {
    id: randomUUID(),
    dataset: commerceStore.dataset,
    storeId: commerceStore.id,
    sourceName,
    contentHash,
    rows: rows.length,
    inserted,
    corrected,
    unchanged,
    startDate: dates[0],
    endDate: dates.at(-1)!,
    createdAt: now.toISOString(),
  };
  store.db
    .prepare(
      'INSERT INTO commerce_ledger_batches(id,dataset,store_id,content_hash,created_at,body) VALUES(?,?,?,?,?,?)',
    )
    .run(
      batch.id,
      batch.dataset,
      batch.storeId,
      batch.contentHash,
      batch.createdAt,
      JSON.stringify(batch),
    );
  const revisionPut = store.db.prepare(
    'INSERT INTO commerce_ledger_revisions(batch_id,position,body) VALUES(?,?,?)',
  );
  for (const [position, revision] of revisions.entries()) {
    put.run(
      revision.after.storeId,
      revision.after.orderRef,
      revision.after.lineRef,
      revision.after.sku,
      revision.after.date,
      revision.after.observedAt,
      JSON.stringify(revision.after),
    );
    revisionPut.run(batch.id, position, JSON.stringify(revision));
  }
  return batch;
}

export function productUnitVariableCost(product: CommerceProduct): number | null {
  const values = costFields.map((key) => product[key]);
  return values.some((value) => value === null)
    ? null
    : (values as number[]).reduce((sum, value) => sum + value, 0);
}

export function productSellableUnits(product: CommerceProduct): number | null {
  if (product.safetyStockUnits === null) return null;
  const capacity =
    product.inventoryMode === 'stocked'
      ? product.availableUnits
      : product.inventoryMode === 'supplier-direct'
        ? product.routeVerified
          ? product.supplierCapacityUnits
          : null
        : product.routeVerified && product.preorderTermsApproved
          ? product.preorderCapacityUnits
          : null;
  return capacity === null ? null : Math.max(0, capacity - product.safetyStockUnits);
}

export function productReadiness(product: CommerceProduct, now = new Date()): CommerceReadiness {
  const blockers: string[] = [];
  const variableCost = productUnitVariableCost(product);
  const completeEconomics =
    product.retailPriceCents !== null &&
    product.retailPriceCents > 0 &&
    product.plannedNetReceiptCents !== null &&
    variableCost !== null &&
    product.profitReserveCents !== null &&
    product.lossLimitCents !== null &&
    product.lossLimitCents > 0 &&
    product.dailyBudgetLimitCents !== null &&
    product.dailyBudgetLimitCents > 0;
  const room = completeEconomics
    ? product.plannedNetReceiptCents! - variableCost! - product.profitReserveCents!
    : null;
  if (!product.economicsVerified || !completeEconomics)
    blockers.push('Verify the complete landed-cost stack and operating limits.');
  else if (room! <= 0) blockers.push('Unit economics leave no room for customer acquisition.');
  if (!product.commercialRightsApproved)
    blockers.push('Approve commercial rights for final media.');
  if (!product.productEvidenceApproved) blockers.push('Approve exact-SKU product evidence.');
  if (!product.claimsApproved) blockers.push('Approve advertising and product claims.');
  if (!product.trackingVerified) blockers.push('Verify paid-order tracking and consent.');
  const mediaReady =
    product.economicsVerified &&
    completeEconomics &&
    room! > 0 &&
    product.commercialRightsApproved &&
    product.productEvidenceApproved &&
    product.claimsApproved &&
    product.trackingVerified;
  if (!product.fulfillmentReady) blockers.push('Verify the fulfillment and returns route.');
  if (!product.releaseApproved) blockers.push('Approve the product release.');
  if (!product.routeVerified)
    blockers.push('Verify the stock, supplier-direct, or preorder route.');
  if (product.committedUnits === null || product.quarantinedUnits === null)
    blockers.push('Record committed and quarantined inventory separately.');
  if (product.safetyStockUnits === null || product.reorderPointUnits === null)
    blockers.push('Set safety stock and the reorder point.');
  if (product.inventoryMode === 'stocked' && product.availableUnits === null)
    blockers.push('Record inspected saleable stock.');
  if (product.inventoryMode === 'supplier-direct' && product.supplierCapacityUnits === null)
    blockers.push('Record verified supplier-direct capacity.');
  if (product.inventoryMode === 'preorder') {
    if (!product.preorderTermsApproved) blockers.push('Approve preorder terms.');
    if (product.preorderCapacityUnits === null) blockers.push('Record preorder capacity.');
  }
  const verifiedAt = product.inventoryVerifiedAt ? Date.parse(product.inventoryVerifiedAt) : NaN;
  const inventoryAge = now.getTime() - verifiedAt;
  const fresh =
    Number.isFinite(verifiedAt) &&
    inventoryAge >= 0 &&
    inventoryAge <= product.inventoryMaxAgeHours * 3_600_000;
  if (!fresh) blockers.push('Refresh the inventory verification.');
  const sellable = productSellableUnits(product);
  if (sellable === null || sellable <= 0) blockers.push('No verified sellable capacity remains.');
  const inventoryReady =
    product.routeVerified &&
    product.committedUnits !== null &&
    product.quarantinedUnits !== null &&
    product.safetyStockUnits !== null &&
    product.reorderPointUnits !== null &&
    fresh &&
    sellable !== null &&
    sellable > 0;
  return {
    mediaReady,
    inventoryReady,
    saleReady: mediaReady && product.fulfillmentReady && product.releaseApproved && inventoryReady,
    blockers: [...new Set(blockers)],
  };
}

type ProductCampaignRow = { productId: string; campaign: Campaign; rows: Observation[] };

function productCampaignRows(store: Store, dataset: Dataset): ProductCampaignRow[] {
  const mappings = store.db
    .prepare(
      'SELECT cc.product_id,cc.campaign_id FROM commerce_campaigns cc JOIN campaigns c ON c.id=cc.campaign_id WHERE c.dataset=?',
    )
    .all(dataset) as { product_id: string; campaign_id: string }[];
  return mappings.map((mapping) => ({
    productId: mapping.product_id,
    campaign: store.campaign(dataset, mapping.campaign_id),
    rows: store.observations(mapping.campaign_id),
  }));
}

const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const toSafeInteger = (value: bigint) => {
  if (value > maxSafeInteger || value < -maxSafeInteger)
    throw new AppError('Commerce totals exceed the supported whole-number range.');
  return Number(value);
};
const sum = <T>(values: T[], select: (value: T) => number) =>
  toSafeInteger(values.reduce((total, value) => total + BigInt(select(value)), 0n));

export function commerceProductViews(
  store: Store,
  dataset: Dataset,
  days = 28,
  now = new Date(),
): CommerceProductView[] {
  const clock = store.reportingTime(dataset, now);
  const stores = new Map(commerceStores(store, dataset).map((value) => [value.id, value]));
  const products = commerceProducts(store, dataset);
  const campaignGroups = new Map<string, ProductCampaignRow[]>();
  for (const row of productCampaignRows(store, dataset)) {
    const list = campaignGroups.get(row.productId) || [];
    list.push(row);
    campaignGroups.set(row.productId, list);
  }
  const orderGroups = new Map<string, CommerceOrderLine[]>();
  for (const commerceStore of stores.values())
    for (const line of commerceOrderLines(store, commerceStore.id)) {
      const key = `${commerceStore.id}\u0000${line.sku}`;
      const list = orderGroups.get(key) || [];
      list.push(line);
      orderGroups.set(key, list);
    }
  return products.map((product) => {
    const commerceStore = stores.get(product.storeId)!;
    const today = dayAt(clock, 0, commerceStore.timezone);
    const start = dayAt(clock, -days, commerceStore.timezone);
    const riskStart = dayAt(clock, -56, commerceStore.timezone);
    const linked = campaignGroups.get(product.id) || [];
    const attributionDays = Math.max(1, ...linked.map((row) => row.campaign.attributionDays));
    const matureThrough = dayAt(clock, -attributionDays - 1, commerceStore.timezone);
    const campaignRows = linked.flatMap((row) => row.rows).filter((row) => row.date < today);
    const selectedCampaignRows = campaignRows.filter((row) => row.date >= start);
    const riskCampaignRows = campaignRows.filter((row) => row.date >= riskStart);
    const ledgerRows = orderGroups.get(`${product.storeId}\u0000${product.sku}`) || [];
    const selectedLedgerRows = ledgerRows.filter((row) => row.date >= start && row.date < today);
    const riskLedgerRows = ledgerRows.filter((row) => row.date >= riskStart && row.date < today);
    const reconcile = (ads: Observation[], orders: CommerceOrderLine[]) => {
      const adByDay = new Map<string, bigint>();
      const ledgerByDay = new Map<string, bigint>();
      for (const row of ads)
        if (row.date <= matureThrough)
          adByDay.set(row.date, (adByDay.get(row.date) || 0n) + BigInt(row.orders));
      for (const row of orders)
        if (row.date <= matureThrough)
          ledgerByDay.set(row.date, (ledgerByDay.get(row.date) || 0n) + BigInt(row.units));
      return toSafeInteger(
        [...adByDay].reduce((total, [date, attributed]) => {
          const paid = ledgerByDay.get(date) || 0n;
          return total + (attributed < paid ? attributed : paid);
        }, 0n),
      );
    };
    const variableCost = productUnitVariableCost(product);
    const preAdContribution =
      variableCost === null || product.plannedNetReceiptCents === null
        ? null
        : product.plannedNetReceiptCents - variableCost;
    const affordable =
      preAdContribution === null || product.profitReserveCents === null
        ? null
        : Math.max(0, preAdContribution - product.profitReserveCents);
    const readiness = productReadiness(product, clock);
    const sellableUnits = productSellableUnits(product);
    const inventoryAge = product.inventoryVerifiedAt
      ? clock.getTime() - Date.parse(product.inventoryVerifiedAt)
      : null;
    const adSpendCents = sum(selectedCampaignRows, (row) => row.spendCents);
    const ledgerUnits = sum(selectedLedgerRows, (row) => row.units);
    const ledgerNetReceiptsCents = sum(selectedLedgerRows, (row) => row.netReceiptsCents);
    const ledgerContributionCents =
      variableCost === null || !product.economicsVerified
        ? null
        : toSafeInteger(
            BigInt(ledgerNetReceiptsCents) -
              BigInt(ledgerUnits) * BigInt(variableCost) -
              BigInt(adSpendCents),
          );
    const reconciledPaidUnits = reconcile(selectedCampaignRows, selectedLedgerRows);
    const riskReconciledUnits = reconcile(riskCampaignRows, riskLedgerRows);
    const riskSpend = sum(riskCampaignRows, (row) => row.spendCents);
    const riskValue =
      affordable === null
        ? null
        : BigInt(riskSpend) - BigInt(riskReconciledUnits) * BigInt(affordable);
    const riskExposureCents =
      riskValue === null ? null : toSafeInteger(riskValue > 0n ? riskValue : 0n);
    const dailyBudgetCents = sum(
      linked.filter((row) => row.campaign.status === 'observing'),
      (row) => row.campaign.dailyBudgetCents,
    );
    const lastLedgerAt = ledgerRows.reduce<string | null>(
      (latest, row) =>
        !latest || Date.parse(row.observedAt) > Date.parse(latest) ? row.observedAt : latest,
      null,
    );
    const ledgerAge = lastLedgerAt === null ? null : clock.getTime() - Date.parse(lastLedgerAt);
    const ledgerFresh =
      ledgerAge !== null &&
      ledgerAge >= 0 &&
      ledgerAge <= commerceStore.maxDataAgeHours * 3_600_000;
    let status: CommerceProductView['status'] = 'learning';
    let reason = 'Collect mature, paid-order evidence before expanding the test.';
    if (!product.economicsVerified || variableCost === null) {
      status = 'unverified';
      reason = 'Verify every cost component and the product operating limits.';
    } else if (affordable === null || affordable <= 0) {
      status = 'not-viable';
      reason = 'Planned receipts and costs leave no acquisition room after the profit reserve.';
    } else if (!readiness.mediaReady) {
      status = 'media-blocked';
      reason = 'Product evidence, rights, claims, economics, or tracking still blocks paid media.';
    } else if (!product.fulfillmentReady || !product.releaseApproved) {
      status = 'release-blocked';
      reason = 'Fulfillment or final product release is not approved.';
    } else if (
      inventoryAge === null ||
      inventoryAge < 0 ||
      inventoryAge > product.inventoryMaxAgeHours * 3_600_000
    ) {
      status = 'inventory-stale';
      reason = 'Refresh inventory before sending more demand to this SKU.';
    } else if (!readiness.inventoryReady || sellableUnits === null || sellableUnits <= 0) {
      status = 'unavailable';
      reason = 'No verified sellable stock, supplier capacity, or preorder capacity remains.';
    } else if (product.reorderPointUnits !== null && sellableUnits <= product.reorderPointUnits) {
      status = 'low-stock';
      reason = 'Sellable capacity is at or below the reorder point.';
    } else if (adSpendCents > 0 && !selectedLedgerRows.length) {
      status = 'no-data';
      reason = 'Import paid order lines before interpreting platform-attributed purchases.';
    } else if (adSpendCents > 0 && !ledgerFresh) {
      status = 'stale-ledger';
      reason = 'Refresh the paid-order ledger before making a profit decision.';
    } else if (
      riskExposureCents !== null &&
      product.lossLimitCents !== null &&
      riskExposureCents >= product.lossLimitCents
    ) {
      status = 'loss-limit';
      reason = 'The 56-day learning loss allowance is used.';
    } else if (
      product.dailyBudgetLimitCents !== null &&
      dailyBudgetCents > product.dailyBudgetLimitCents
    ) {
      status = 'budget-limit';
      reason = 'Linked active campaign budgets exceed this SKU’s ceiling.';
    } else if (
      ledgerContributionCents !== null &&
      ledgerContributionCents > 0 &&
      reconciledPaidUnits > 0
    ) {
      status = 'positive';
      reason =
        'Paid ledger receipts cover modeled variable costs and linked ad spend; causality still requires a controlled test.';
    }
    return {
      ...product,
      storeName: commerceStore.name,
      storeTimezone: commerceStore.timezone,
      readiness,
      unitVariableCostCents: variableCost,
      preAdContributionCents: preAdContribution,
      affordableAcquisitionCents: affordable,
      breakEvenRoas:
        preAdContribution !== null && preAdContribution > 0 && product.retailPriceCents
          ? product.retailPriceCents / preAdContribution
          : null,
      sellableUnits,
      campaigns: linked.length,
      linkedCampaignIds: linked.map((row) => row.campaign.id).sort(),
      adSpendCents,
      attributedOrders: sum(selectedCampaignRows, (row) => row.orders),
      ledgerUnits,
      reconciledPaidUnits,
      ledgerNetReceiptsCents,
      refundsCents: sum(selectedLedgerRows, (row) => row.refundsCents),
      chargebacksCents: sum(selectedLedgerRows, (row) => row.chargebacksCents),
      ledgerContributionCents,
      riskExposureCents,
      remainingLossAllowanceCents:
        riskExposureCents === null || product.lossLimitCents === null
          ? null
          : Math.max(0, product.lossLimitCents - riskExposureCents),
      dailyBudgetCents,
      lastLedgerAt,
      matureThrough,
      status,
      reason,
    };
  });
}

export function commerceCampaignViews(
  store: Store,
  dataset: Dataset,
  now = new Date(),
): ReadonlyMap<string, CommerceProductView> {
  const result = new Map<string, CommerceProductView>();
  for (const product of commerceProductViews(store, dataset, 56, now))
    for (const campaignId of product.linkedCampaignIds) result.set(campaignId, product);
  return result;
}

export function linkCommerceCampaign(
  store: Store,
  product: CommerceProduct,
  campaign: Campaign,
  now = new Date(),
): Campaign {
  if (campaign.dataset !== product.dataset || campaign.vertical !== 'commerce')
    throw new AppError('Choose a product campaign from the same workspace.');
  const previous = store.db
    .prepare('SELECT product_id FROM commerce_campaigns WHERE campaign_id=?')
    .get(campaign.id) as { product_id: string } | undefined;
  if (previous && previous.product_id !== product.id)
    throw new AppError(
      'A campaign’s SKU identity is fixed. Create a new campaign for a different product.',
    );
  const variableCost = productUnitVariableCost(product);
  const complete =
    product.economicsVerified &&
    product.retailPriceCents !== null &&
    product.plannedNetReceiptCents !== null &&
    variableCost !== null &&
    product.profitReserveCents !== null;
  const readiness = productReadiness(product, now);
  const next: Campaign = {
    ...campaign,
    entityName: product.variantName ? `${product.name} · ${product.variantName}` : product.name,
    ...(complete
      ? {
          retailPriceCents: product.retailPriceCents!,
          netReceiptCents: product.plannedNetReceiptCents!,
          variableCostCents: variableCost!,
          targetProfitCents: product.profitReserveCents!,
        }
      : {}),
    economicsVerified: complete,
    trackingVerified: product.trackingVerified,
    supplyReady: readiness.saleReady,
  };
  store.db
    .prepare(
      'INSERT INTO commerce_campaigns(campaign_id,product_id) VALUES(?,?) ON CONFLICT(campaign_id) DO NOTHING',
    )
    .run(campaign.id, product.id);
  store.saveCampaign(next);
  return next;
}

export function commerceCampaignBlockers(
  store: Store,
  campaign: Campaign,
  now = new Date(),
  campaignViews?: ReadonlyMap<string, CommerceProductView>,
): string[] {
  if (campaign.vertical !== 'commerce') return [];
  const mapping = store.db
    .prepare('SELECT product_id FROM commerce_campaigns WHERE campaign_id=?')
    .get(campaign.id) as { product_id: string } | undefined;
  if (!mapping) return ['Map this campaign to a SKU in the Product portfolio.'];
  const product = commerceProductById(store, campaign.dataset, mapping.product_id);
  const variableCost = productUnitVariableCost(product);
  const readiness = productReadiness(product, now);
  const blockers = readiness.saleReady ? [] : [...readiness.blockers];
  if (
    product.retailPriceCents !== campaign.retailPriceCents ||
    product.plannedNetReceiptCents !== campaign.netReceiptCents ||
    variableCost !== campaign.variableCostCents ||
    product.profitReserveCents !== campaign.targetProfitCents
  )
    blockers.push('Reconcile campaign economics with the mapped SKU before optimization.');
  const view = campaignViews
    ? campaignViews.get(campaign.id)
    : commerceProductViews(store, campaign.dataset, 56, now).find(
        (candidate) => candidate.id === product.id,
      );
  if (view) {
    if (
      product.reorderPointUnits !== null &&
      view.sellableUnits !== null &&
      view.sellableUnits <= product.reorderPointUnits
    )
      blockers.push('Sellable capacity is at or below the reorder point.');
    if (view.adSpendCents > 0 && view.ledgerUnits === 0)
      blockers.push('Import paid order lines before interpreting platform-attributed purchases.');
    else if (view.adSpendCents > 0) {
      const commerceStore = commerceStoreById(store, campaign.dataset, product.storeId);
      const ledgerAge = view.lastLedgerAt ? now.getTime() - Date.parse(view.lastLedgerAt) : null;
      if (
        ledgerAge === null ||
        ledgerAge < 0 ||
        ledgerAge > commerceStore.maxDataAgeHours * 3_600_000
      )
        blockers.push('Refresh the paid-order ledger before making a profit decision.');
    }
    if (
      view.riskExposureCents !== null &&
      product.lossLimitCents !== null &&
      view.riskExposureCents >= product.lossLimitCents
    )
      blockers.push('The 56-day learning loss allowance is used.');
    if (
      product.dailyBudgetLimitCents !== null &&
      view.dailyBudgetCents > product.dailyBudgetLimitCents
    )
      blockers.push('Linked active campaign budgets exceed this SKU’s ceiling.');
  }
  return [...new Set(blockers)];
}

/** Adds current SKU gates to a campaign decision and versions the evidence with product state. */
export function gateCommerceDecision(
  store: Store,
  campaign: Campaign,
  decision: Decision,
  now = new Date(),
  campaignViews?: ReadonlyMap<string, CommerceProductView>,
): Decision {
  if (campaign.vertical !== 'commerce') return decision;
  const resolvedViews = campaignViews ?? commerceCampaignViews(store, campaign.dataset, now);
  const blockers = commerceCampaignBlockers(store, campaign, now, resolvedViews);
  const mapping = store.db
    .prepare('SELECT product_id FROM commerce_campaigns WHERE campaign_id=?')
    .get(campaign.id) as { product_id: string } | undefined;
  const productVersion = mapping
    ? commerceProductById(store, campaign.dataset, mapping.product_id).updatedAt
    : null;
  const productState = resolvedViews.get(campaign.id) ?? null;
  const evidenceId = digest({
    decision: decision.evidenceId,
    productVersion,
    productState,
    blockers,
  });
  if (!blockers.length) return { ...decision, evidenceId };
  const blocked: Decision = {
    ...decision,
    blockers: [...new Set([...decision.blockers, ...blockers])],
    suggestedDailyBudgetCents: null,
    evidenceId,
  };
  if (decision.kind === 'reduce') return blocked;
  return {
    ...blocked,
    kind: 'repair',
    title: 'Close the product readiness gaps',
    reason: blockers[0],
  };
}
