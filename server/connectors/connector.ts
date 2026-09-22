import type {
  KeywordMatch,
  NegativeMatch,
  PlatformAdGroup,
  PlatformCampaign,
  PlatformKeyword,
  PlatformNegativeKeyword,
  PlatformState,
} from '../../shared/types.js';

/**
 * Every platform integration exposes the same capability surface. A connector
 * reads account structure and performance, and (only when writes are enabled)
 * applies exact, previewed changes. Connectors never decide anything.
 */
export type ConnectorErrorKind =
  | 'auth'
  | 'throttled'
  | 'timeout'
  | 'invalid'
  | 'unavailable'
  | 'ambiguous'
  | 'unsupported'
  | 'pending';

export class ConnectorError extends Error {
  constructor(
    public kind: ConnectorErrorKind,
    message: string,
    public retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export type ReportKind = 'campaign' | 'keyword' | 'searchTerm' | 'advertisedProduct';

export interface ReportRow {
  date: string;
  campaignExternalId: string;
  adGroupExternalId: string | null;
  keywordExternalId: string | null;
  keywordText: string | null;
  matchType: KeywordMatch | 'auto' | null;
  searchTerm: string | null;
  impressions: number;
  clicks: number;
  costCents: number;
  purchases: number;
  salesCents: number;
  observedAt?: string;
  advertisedAsin?: string;
  adExternalId?: string;
  sameSkuPurchases?: number;
  sameSkuUnits?: number;
  sameSkuSalesCents?: number;
}

export type MutationResult =
  | { index: number; ok: true; externalId: string }
  | { index: number; ok: false; code: string; message: string };

export interface KeywordCreate {
  campaignExternalId: string;
  adGroupExternalId: string;
  text: string;
  matchType: KeywordMatch;
  bidCents: number;
}
export interface KeywordUpdate {
  externalId: string;
  /** Optional scope for platforms whose keyword IDs are not globally unique. */
  campaignExternalId?: string;
  bidCents?: number;
  state?: PlatformState;
}
export interface NegativeCreate {
  campaignExternalId: string;
  adGroupExternalId: string;
  text: string;
  matchType: NegativeMatch;
}
export interface CampaignUpdate {
  externalId: string;
  dailyBudgetCents?: number;
  state?: PlatformState;
}

export interface Connector {
  readonly kind: 'sandbox' | 'amazon-ads';
  readonly writesEnabled: boolean;
  listCampaigns(): Promise<PlatformCampaign[]>;
  listAdGroups(campaignExternalIds: string[]): Promise<PlatformAdGroup[]>;
  listKeywords(campaignExternalIds: string[]): Promise<PlatformKeyword[]>;
  listNegativeKeywords(campaignExternalIds: string[]): Promise<PlatformNegativeKeyword[]>;
  report(
    kind: ReportKind,
    startDate: string,
    endDate: string,
    attributionDays: number,
  ): Promise<ReportRow[]>;
  createKeywords(items: KeywordCreate[]): Promise<MutationResult[]>;
  updateKeywords(items: KeywordUpdate[]): Promise<MutationResult[]>;
  createNegativeKeywords(items: NegativeCreate[]): Promise<MutationResult[]>;
  updateCampaigns(items: CampaignUpdate[]): Promise<MutationResult[]>;
}

export const normalizeTerm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
