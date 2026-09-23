import type { AdAccount, Dataset } from './types.js';

export interface Book {
  id: string;
  dataset: Dataset;
  accountId: string;
  asin: string;
  isbn: string;
  title: string;
  publisher: string;
  format: 'paperback' | 'hardcover' | 'ebook' | 'audiobook';
  retailPriceCents: number;
  netReceiptCents: number;
  variableCostCents: number;
  profitReserveCents: number;
  lossLimitCents: number;
  dailyBudgetLimitCents: number;
  economicsVerified: boolean;
  supplyReady: boolean;
  supplySource?: 'pbs';
  supplyVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface BookView extends Book {
  accountName: string;
  currency: 'USD';
  timezone: string;
  campaigns: number;
  linkedCampaignIds: string[];
  spendCents: number;
  sameAsinUnits: number;
  sameAsinSalesCents: number;
  matureSpendCents: number;
  matureUnits: number;
  contributionCents: number | null;
  riskExposureCents: number | null;
  remainingLossAllowanceCents: number | null;
  affordableAcquisitionCents: number | null;
  breakEvenAcos: number | null;
  dailyBudgetCents: number;
  lastReportedAt: string | null;
  matureThrough: string;
  status:
    | 'unverified'
    | 'not-viable'
    | 'unavailable'
    | 'no-data'
    | 'stale'
    | 'loss-limit'
    | 'budget-limit'
    | 'positive'
    | 'learning';
  reason: string;
}
export interface BookPortfolio {
  dataset: Dataset;
  days: number;
  books: BookView[];
  total: number;
  page: number;
  pages: number;
  accounts: AdAccount[];
  summary: {
    titles: number;
    verified: number;
    needsAttention: number;
    spendCents: number;
    modeledContributionCents: number;
    measuredTitles: number;
    unmappedAsins: number;
  };
}
