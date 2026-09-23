import type { Campaign, Dataset } from './types.js';

export type CommerceProvider = 'manual' | 'shopify';
export type InventoryMode = 'stocked' | 'supplier-direct' | 'preorder';

export interface CommerceStore {
  id: string;
  dataset: Dataset;
  name: string;
  provider: CommerceProvider;
  shopDomain: string | null;
  currency: 'USD';
  timezone: string;
  maxDataAgeHours: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceProduct {
  id: string;
  dataset: Dataset;
  storeId: string;
  productRef: string;
  sku: string;
  name: string;
  variantName: string;
  externalVariantId: string;
  inventoryMode: InventoryMode;
  retailPriceCents: number | null;
  plannedNetReceiptCents: number | null;
  unitCostCents: number | null;
  inboundFreightCents: number | null;
  dutiesAndFeesCents: number | null;
  packagingCostCents: number | null;
  paymentFeeAllowanceCents: number | null;
  outboundFulfillmentCents: number | null;
  returnAllowanceCents: number | null;
  warrantyAllowanceCents: number | null;
  supportAllowanceCents: number | null;
  profitReserveCents: number | null;
  lossLimitCents: number | null;
  dailyBudgetLimitCents: number | null;
  economicsVerified: boolean;
  commercialRightsApproved: boolean;
  productEvidenceApproved: boolean;
  claimsApproved: boolean;
  trackingVerified: boolean;
  fulfillmentReady: boolean;
  releaseApproved: boolean;
  routeVerified: boolean;
  preorderTermsApproved: boolean;
  availableUnits: number | null;
  committedUnits: number | null;
  quarantinedUnits: number | null;
  supplierCapacityUnits: number | null;
  preorderCapacityUnits: number | null;
  safetyStockUnits: number | null;
  reorderPointUnits: number | null;
  inventoryVerifiedAt: string | null;
  inventoryMaxAgeHours: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceOrderLine {
  storeId: string;
  orderRef: string;
  lineRef: string;
  date: string;
  sku: string;
  units: number;
  /** Paid receipts after discounts, refunds, and chargebacks; excludes sales tax. */
  netReceiptsCents: number;
  /** Informational subset already reflected in netReceiptsCents. */
  refundsCents: number;
  /** Informational subset already reflected in netReceiptsCents. */
  chargebacksCents: number;
  observedAt: string;
}

export interface CommerceLedgerBatch {
  id: string;
  dataset: Dataset;
  storeId: string;
  sourceName: string;
  contentHash: string;
  rows: number;
  inserted: number;
  corrected: number;
  unchanged: number;
  startDate: string;
  endDate: string;
  createdAt: string;
}

export interface CommerceLedgerRevision {
  before: CommerceOrderLine | null;
  after: CommerceOrderLine;
}

export interface CommerceReadiness {
  mediaReady: boolean;
  inventoryReady: boolean;
  saleReady: boolean;
  blockers: string[];
}

export type CommerceProductStatus =
  | 'unverified'
  | 'not-viable'
  | 'media-blocked'
  | 'release-blocked'
  | 'inventory-stale'
  | 'unavailable'
  | 'low-stock'
  | 'no-data'
  | 'stale-ledger'
  | 'loss-limit'
  | 'budget-limit'
  | 'positive'
  | 'learning';

export interface CommerceProductView extends CommerceProduct {
  storeName: string;
  storeTimezone: string;
  readiness: CommerceReadiness;
  unitVariableCostCents: number | null;
  preAdContributionCents: number | null;
  affordableAcquisitionCents: number | null;
  breakEvenRoas: number | null;
  sellableUnits: number | null;
  campaigns: number;
  linkedCampaignIds: string[];
  adSpendCents: number;
  attributedOrders: number;
  ledgerUnits: number;
  reconciledPaidUnits: number;
  ledgerNetReceiptsCents: number;
  refundsCents: number;
  chargebacksCents: number;
  ledgerContributionCents: number | null;
  riskExposureCents: number | null;
  remainingLossAllowanceCents: number | null;
  dailyBudgetCents: number;
  lastLedgerAt: string | null;
  matureThrough: string;
  status: CommerceProductStatus;
  reason: string;
}

export interface CommercePortfolio {
  dataset: Dataset;
  days: number;
  stores: CommerceStore[];
  products: CommerceProductView[];
  total: number;
  page: number;
  pages: number;
  recentBatches: CommerceLedgerBatch[];
  summary: {
    skus: number;
    saleReady: number;
    needsAttention: number;
    sellableUnits: number;
    adSpendCents: number;
    ledgerNetReceiptsCents: number;
    ledgerContributionCents: number;
    measuredSkus: number;
    unmappedOrderSkus: number;
  };
}

export interface CommerceCampaignChoice extends Pick<Campaign, 'id' | 'name' | 'channel'> {
  mappedProductId: string | null;
}
