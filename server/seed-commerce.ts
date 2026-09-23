import type { CommerceOrderLine } from '../shared/commerce.js';
import { Store } from './store.js';
import {
  commerceStores,
  createCommerceStore,
  importCommerceLedger,
  linkCommerceCampaign,
  saveCommerceProducts,
} from './commerce.js';

/** Fictional SKU economics and paid orders for the existing demo product campaigns. */
export function seedCommerce(store: Store) {
  if (commerceStores(store, 'demo').length) return;
  const campaigns = store.campaigns('demo').filter((campaign) => campaign.vertical === 'commerce');
  if (!campaigns.length) return;
  const now = store.reportingTime('demo');
  store.transaction(() => {
    const commerceStore = createCommerceStore(
      store,
      'demo',
      {
        name: 'Enthusiast · sample store',
        provider: 'manual',
        timezone: 'America/New_York',
        maxDataAgeHours: 72,
      },
      now,
    );
    const products = saveCommerceProducts(
      store,
      commerceStore,
      campaigns.map((campaign, index) => {
        const unitCost = Math.floor(campaign.variableCostCents * 0.55);
        const freight = Math.floor(campaign.variableCostCents * 0.1);
        const duties = Math.floor(campaign.variableCostCents * 0.04);
        const packaging = Math.floor(campaign.variableCostCents * 0.06);
        const payment = Math.floor(campaign.variableCostCents * 0.08);
        const fulfillment = Math.floor(campaign.variableCostCents * 0.1);
        const returns = Math.floor(campaign.variableCostCents * 0.03);
        const warranty = Math.floor(campaign.variableCostCents * 0.02);
        const support =
          campaign.variableCostCents -
          unitCost -
          freight -
          duties -
          packaging -
          payment -
          fulfillment -
          returns -
          warranty;
        return {
          productRef: campaign.id.replace(/^demo-/, ''),
          sku: `DEMO-SKU-${index + 1}`,
          name: campaign.entityName,
          variantName: 'Sample variant',
          externalVariantId: '',
          inventoryMode: 'stocked' as const,
          retailPriceCents: campaign.retailPriceCents,
          plannedNetReceiptCents: campaign.netReceiptCents,
          unitCostCents: unitCost,
          inboundFreightCents: freight,
          dutiesAndFeesCents: duties,
          packagingCostCents: packaging,
          paymentFeeAllowanceCents: payment,
          outboundFulfillmentCents: fulfillment,
          returnAllowanceCents: returns,
          warrantyAllowanceCents: warranty,
          supportAllowanceCents: support,
          profitReserveCents: campaign.targetProfitCents,
          lossLimitCents: campaign.totalLearningBudgetCents,
          dailyBudgetLimitCents: campaign.dailyBudgetCents * 2,
          economicsVerified: true,
          commercialRightsApproved: true,
          productEvidenceApproved: true,
          claimsApproved: true,
          trackingVerified: true,
          fulfillmentReady: true,
          releaseApproved: true,
          routeVerified: true,
          preorderTermsApproved: false,
          availableUnits: 250 - index * 70,
          committedUnits: 8 + index,
          quarantinedUnits: index,
          supplierCapacityUnits: null,
          preorderCapacityUnits: null,
          safetyStockUnits: 20,
          reorderPointUnits: 40,
          inventoryVerifiedAt: now.toISOString(),
          inventoryMaxAgeHours: 168,
        };
      }),
      now,
    );
    for (const [index, campaign] of campaigns.entries())
      linkCommerceCampaign(store, products[index], campaign, now);
    const rows: CommerceOrderLine[] = campaigns.flatMap((campaign, index) =>
      store
        .observations(campaign.id)
        .filter((row) => row.orders > 0)
        .map((row) => ({
          storeId: commerceStore.id,
          orderRef: `${campaign.id}-${row.date}`,
          lineRef: '1',
          date: row.date,
          sku: products[index].sku,
          units: row.orders,
          netReceiptsCents: Math.max(0, row.orders * campaign.netReceiptCents - row.refundsCents),
          refundsCents: row.refundsCents,
          chargebacksCents: 0,
          observedAt: row.observedAt,
        })),
    );
    if (rows.length)
      importCommerceLedger(store, commerceStore, rows, 'Synthetic paid-order ledger', now);
  });
}
