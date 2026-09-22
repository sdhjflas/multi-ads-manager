import { gunzipSync } from 'node:zlib';
import type {
  KeywordMatch,
  PlatformAdGroup,
  PlatformCampaign,
  PlatformKeyword,
  PlatformNegativeKeyword,
  PlatformState,
} from '../../shared/types.js';
import {
  ConnectorError,
  type CampaignUpdate,
  type Connector,
  type KeywordCreate,
  type KeywordUpdate,
  type MutationResult,
  type NegativeCreate,
  type ReportKind,
  type ReportRow,
} from './connector.js';

/**
 * Amazon Ads API adapter for Sponsored Products (campaign management v3 and
 * reporting v3). Request shapes follow Amazon's published Postman collection.
 * Report column names follow the documented v3 report types; confirm them
 * against the account's approved API version during onboarding, because the
 * documentation portal renders client-side and could not be captured here.
 *
 * Credentials come from the server environment only. Writes require
 * AMAZON_ADS_WRITES_ENABLED=true in addition to a connected account.
 */
export interface AmazonConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  profileId: string;
  region: 'NA' | 'EU' | 'FE';
  writesEnabled: boolean;
}

const endpoints = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};
const tokenUrl = 'https://api.amazon.com/auth/o2/token';

export function amazonConfigFromEnv(profileId: string): AmazonConfig | null {
  const clientId = process.env.AMAZON_ADS_CLIENT_ID?.trim();
  const clientSecret = process.env.AMAZON_ADS_CLIENT_SECRET?.trim();
  const refreshToken = process.env.AMAZON_ADS_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  const region = (process.env.AMAZON_ADS_REGION || 'NA').toUpperCase();
  return {
    clientId,
    clientSecret,
    refreshToken,
    profileId,
    region: region === 'EU' || region === 'FE' ? region : 'NA',
    writesEnabled: process.env.AMAZON_ADS_WRITES_ENABLED === 'true',
  };
}
export const amazonConfigured = () => amazonConfigFromEnv('probe') !== null;

const state = (value: string): PlatformState =>
  value === 'ENABLED' ? 'enabled' : value === 'PAUSED' ? 'paused' : 'archived';
const upperState = (value: PlatformState) =>
  value === 'enabled' ? 'ENABLED' : value === 'paused' ? 'PAUSED' : 'ARCHIVED';
const cents = (value: unknown) => Math.round(Number(value || 0) * 100);
const match = (value: unknown): KeywordMatch | 'auto' => {
  const v = String(value || '').toUpperCase();
  return v === 'EXACT' ? 'exact' : v === 'PHRASE' ? 'phrase' : v === 'BROAD' ? 'broad' : 'auto';
};

export class AmazonAdsConnector implements Connector {
  readonly kind = 'amazon-ads' as const;
  readonly writesEnabled: boolean;
  private accessToken: { value: string; expiresAt: number } | null = null;
  constructor(
    private config: AmazonConfig,
    private fetcher: typeof fetch = fetch,
    private clock: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.writesEnabled = config.writesEnabled;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > this.clock() + 60_000)
      return this.accessToken.value;
    let response: Response;
    try {
      response = await this.fetcher(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(20_000),
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.config.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }).toString(),
      });
    } catch {
      throw new ConnectorError('timeout', 'Token refresh did not complete.');
    }
    if (!response.ok)
      throw new ConnectorError(
        'auth',
        `Token refresh failed with HTTP ${response.status}. Re-authorize the account.`,
      );
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = {
      value: body.access_token,
      expiresAt: this.clock() + body.expires_in * 1000,
    };
    return body.access_token;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    mediaType: string | null,
    write: boolean,
    attempt = 0,
  ): Promise<T> {
    const token = await this.token();
    const headers: Record<string, string> = {
      'Amazon-Advertising-API-ClientId': this.config.clientId,
      'Amazon-Advertising-API-Scope': this.config.profileId,
      Authorization: `Bearer ${token}`,
    };
    if (mediaType) {
      headers.Accept = mediaType;
      headers['Content-Type'] = mediaType;
    } else if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (write) headers.Prefer = 'return=representation';
    let response: Response;
    try {
      response = await this.fetcher(`${endpoints[this.config.region]}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(write ? 45_000 : 30_000),
      });
    } catch {
      // A write that times out may or may not have been applied.
      throw new ConnectorError(
        write ? 'ambiguous' : 'timeout',
        write
          ? 'The platform did not confirm the change. Read the current state before retrying.'
          : 'The platform did not answer within the time limit.',
      );
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') || '2') * 1000;
      if (!write && attempt < 2) {
        await this.sleep(Math.min(retryAfter, 10_000));
        return this.call(method, path, body, mediaType, write, attempt + 1);
      }
      throw new ConnectorError(
        'throttled',
        'Amazon Ads is rate limiting this account.',
        retryAfter,
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new ConnectorError(
        'auth',
        `Amazon Ads rejected the credentials (HTTP ${response.status}).`,
      );
    if (response.status >= 500)
      throw new ConnectorError(
        write ? 'ambiguous' : 'unavailable',
        `Amazon Ads returned HTTP ${response.status}.`,
      );
    if (!response.ok)
      throw new ConnectorError(
        'invalid',
        `Amazon Ads returned HTTP ${response.status} for ${path}.`,
      );
    return (await response.json()) as T;
  }

  private async listAll<T>(
    path: string,
    mediaType: string,
    key: string,
    filter: Record<string, unknown>,
  ): Promise<T[]> {
    const items: T[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < 100; page++) {
      const body = (await this.call<Record<string, unknown>>(
        'POST',
        path,
        { ...filter, maxResults: 1000, ...(nextToken ? { nextToken } : {}) },
        mediaType,
        false,
      )) as Record<string, unknown>;
      items.push(...((body[key] as T[]) || []));
      nextToken = body.nextToken as string | undefined;
      if (!nextToken) break;
    }
    return items;
  }

  async listCampaigns(): Promise<PlatformCampaign[]> {
    type C = {
      campaignId: string;
      name: string;
      state: string;
      budget: { budget: number; budgetType: string };
      targetingType: string;
    };
    const items = await this.listAll<C>(
      '/sp/campaigns/list',
      'application/vnd.spCampaign.v3+json',
      'campaigns',
      {
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
      },
    );
    return items.map((c) => ({
      externalId: String(c.campaignId),
      name: c.name,
      state: state(c.state),
      dailyBudgetCents: cents(c.budget?.budget),
      targetingType: c.targetingType === 'AUTO' ? 'auto' : 'manual',
    }));
  }
  async listAdGroups(ids: string[]): Promise<PlatformAdGroup[]> {
    if (!ids.length) return [];
    type G = {
      adGroupId: string;
      campaignId: string;
      name: string;
      state: string;
      defaultBid: number;
    };
    const items = await this.listAll<G>(
      '/sp/adGroups/list',
      'application/vnd.spAdGroup.v3+json',
      'adGroups',
      {
        campaignIdFilter: { include: ids },
      },
    );
    return items.map((g) => ({
      externalId: String(g.adGroupId),
      campaignExternalId: String(g.campaignId),
      name: g.name,
      state: state(g.state),
      defaultBidCents: cents(g.defaultBid),
    }));
  }
  async listKeywords(ids: string[]): Promise<PlatformKeyword[]> {
    if (!ids.length) return [];
    type K = {
      keywordId: string;
      campaignId: string;
      adGroupId: string;
      keywordText: string;
      matchType: string;
      state: string;
      bid: number;
    };
    const items = await this.listAll<K>(
      '/sp/keywords/list',
      'application/vnd.spKeyword.v3+json',
      'keywords',
      {
        campaignIdFilter: { include: ids },
      },
    );
    return items
      .map((k) => ({
        externalId: String(k.keywordId),
        campaignExternalId: String(k.campaignId),
        adGroupExternalId: String(k.adGroupId),
        text: k.keywordText,
        matchType: match(k.matchType),
        state: state(k.state),
        bidCents: cents(k.bid),
      }))
      .filter((k): k is PlatformKeyword => k.matchType !== 'auto');
  }
  async listNegativeKeywords(ids: string[]): Promise<PlatformNegativeKeyword[]> {
    if (!ids.length) return [];
    type N = {
      keywordId: string;
      campaignId: string;
      adGroupId?: string;
      keywordText: string;
      matchType: string;
      state: string;
    };
    const items = await this.listAll<N>(
      '/sp/negativeKeywords/list',
      'application/vnd.spNegativeKeyword.v3+json',
      'negativeKeywords',
      { campaignIdFilter: { include: ids } },
    );
    return items.map((n) => ({
      externalId: String(n.keywordId),
      campaignExternalId: String(n.campaignId),
      adGroupExternalId: n.adGroupId ? String(n.adGroupId) : null,
      text: n.keywordText,
      matchType: n.matchType === 'NEGATIVE_PHRASE' ? 'negative-phrase' : 'negative-exact',
      state: state(n.state),
    }));
  }

  async report(
    kind: ReportKind,
    startDate: string,
    endDate: string,
    attributionDays: number,
  ): Promise<ReportRow[]> {
    if (![1, 7, 14, 30].includes(attributionDays))
      throw new ConnectorError(
        'unsupported',
        'Amazon reporting supports 1, 7, 14, or 30 day attribution windows.',
      );
    const purchases = `purchases${attributionDays}d`;
    const sales = `sales${attributionDays}d`;
    const configuration =
      kind === 'campaign'
        ? {
            reportTypeId: 'spCampaigns',
            groupBy: ['campaign'],
            columns: [
              'date',
              'campaignId',
              'campaignName',
              'impressions',
              'clicks',
              'cost',
              purchases,
              sales,
            ],
          }
        : kind === 'keyword'
          ? {
              reportTypeId: 'spTargeting',
              groupBy: ['targeting'],
              columns: [
                'date',
                'campaignId',
                'adGroupId',
                'keywordId',
                'keyword',
                'matchType',
                'impressions',
                'clicks',
                'cost',
                purchases,
                sales,
              ],
            }
          : {
              reportTypeId: 'spSearchTerm',
              groupBy: ['searchTerm'],
              columns: [
                'date',
                'campaignId',
                'adGroupId',
                'keywordId',
                'keyword',
                'matchType',
                'searchTerm',
                'impressions',
                'clicks',
                'cost',
                purchases,
                sales,
              ],
            };
    type Report = {
      reportId: string;
      status: string;
      url: string | null;
      failureReason: string | null;
    };
    const created = await this.call<Report>(
      'POST',
      '/reporting/reports',
      {
        name: `orbit ${kind} ${startDate} ${endDate}`,
        startDate,
        endDate,
        configuration: {
          adProduct: 'SPONSORED_PRODUCTS',
          timeUnit: 'DAILY',
          format: 'GZIP_JSON',
          ...configuration,
        },
      },
      'application/vnd.createasyncreportrequest.v3+json',
      false,
    );
    let report = created;
    const deadline = this.clock() + 15 * 60_000;
    while (report.status !== 'COMPLETED') {
      if (report.status === 'FAILED')
        throw new ConnectorError(
          'unavailable',
          `Amazon report failed: ${report.failureReason || 'unknown reason'}.`,
        );
      if (this.clock() > deadline)
        throw new ConnectorError('timeout', 'Amazon report generation exceeded 15 minutes.');
      await this.sleep(15_000);
      report = await this.call<Report>(
        'GET',
        `/reporting/reports/${created.reportId}`,
        undefined,
        null,
        false,
      );
    }
    if (!report.url)
      throw new ConnectorError('unavailable', 'Amazon report completed without a download URL.');
    let download: Response;
    try {
      download = await this.fetcher(report.url, { signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new ConnectorError('timeout', 'Report download did not complete.');
    }
    if (!download.ok)
      throw new ConnectorError('unavailable', `Report download returned HTTP ${download.status}.`);
    const raw = Buffer.from(await download.arrayBuffer());
    let rows: Record<string, unknown>[];
    try {
      rows = JSON.parse(gunzipSync(raw).toString('utf8'));
    } catch {
      try {
        rows = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new ConnectorError('invalid', 'Report payload could not be parsed.');
      }
    }
    return rows.map((r) => ({
      date: String(r.date),
      campaignExternalId: String(r.campaignId),
      adGroupExternalId: r.adGroupId === undefined ? null : String(r.adGroupId),
      keywordExternalId: r.keywordId === undefined ? null : String(r.keywordId),
      keywordText: r.keyword === undefined ? null : String(r.keyword),
      matchType: r.matchType === undefined ? null : match(r.matchType),
      searchTerm: r.searchTerm === undefined ? null : String(r.searchTerm),
      impressions: Number(r.impressions || 0),
      clicks: Number(r.clicks || 0),
      costCents: cents(r.cost),
      purchases: Number(r[purchases] || 0),
      salesCents: cents(r[sales]),
    }));
  }

  private results(
    body: Record<
      string,
      {
        success?: { index: number; [k: string]: unknown }[];
        error?: {
          index: number;
          errors?: { errorType?: string; errorValue?: Record<string, { message?: string }> }[];
        }[];
      }
    >,
    key: string,
    idKey: string,
  ): MutationResult[] {
    const section = body[key] || {};
    const results: MutationResult[] = [];
    for (const item of section.success || [])
      results.push({ index: item.index, ok: true, externalId: String(item[idKey]) });
    for (const item of section.error || []) {
      const first = item.errors?.[0];
      const detail = first?.errorValue ? Object.values(first.errorValue)[0] : undefined;
      results.push({
        index: item.index,
        ok: false,
        code: first?.errorType || 'ERROR',
        message: detail?.message || 'The platform rejected this item.',
      });
    }
    return results.sort((a, b) => a.index - b.index);
  }
  private writable() {
    if (!this.writesEnabled)
      throw new ConnectorError(
        'unsupported',
        'Platform writes are disabled. Set AMAZON_ADS_WRITES_ENABLED=true after the supervised pilot is approved.',
      );
  }
  async createKeywords(items: KeywordCreate[]): Promise<MutationResult[]> {
    this.writable();
    const body = await this.call<Record<string, never>>(
      'POST',
      '/sp/keywords',
      {
        keywords: items.map((k) => ({
          campaignId: k.campaignExternalId,
          adGroupId: k.adGroupExternalId,
          keywordText: k.text,
          matchType: k.matchType.toUpperCase(),
          state: 'ENABLED',
          bid: k.bidCents / 100,
        })),
      },
      'application/vnd.spKeyword.v3+json',
      true,
    );
    return this.results(body, 'keywords', 'keywordId');
  }
  async updateKeywords(items: KeywordUpdate[]): Promise<MutationResult[]> {
    this.writable();
    const body = await this.call<Record<string, never>>(
      'PUT',
      '/sp/keywords',
      {
        keywords: items.map((k) => ({
          keywordId: k.externalId,
          ...(k.bidCents !== undefined ? { bid: k.bidCents / 100 } : {}),
          ...(k.state !== undefined ? { state: upperState(k.state) } : {}),
        })),
      },
      'application/vnd.spKeyword.v3+json',
      true,
    );
    return this.results(body, 'keywords', 'keywordId');
  }
  async createNegativeKeywords(items: NegativeCreate[]): Promise<MutationResult[]> {
    this.writable();
    const body = await this.call<Record<string, never>>(
      'POST',
      '/sp/negativeKeywords',
      {
        negativeKeywords: items.map((n) => ({
          campaignId: n.campaignExternalId,
          adGroupId: n.adGroupExternalId,
          keywordText: n.text,
          matchType: n.matchType === 'negative-phrase' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT',
          state: 'ENABLED',
        })),
      },
      'application/vnd.spNegativeKeyword.v3+json',
      true,
    );
    return this.results(body, 'negativeKeywords', 'negativeKeywordId');
  }
  async updateCampaigns(items: CampaignUpdate[]): Promise<MutationResult[]> {
    this.writable();
    const body = await this.call<Record<string, never>>(
      'PUT',
      '/sp/campaigns',
      {
        campaigns: items.map((c) => ({
          campaignId: c.externalId,
          ...(c.dailyBudgetCents !== undefined
            ? { budget: { budgetType: 'DAILY', budget: c.dailyBudgetCents / 100 } }
            : {}),
          ...(c.state !== undefined ? { state: upperState(c.state) } : {}),
        })),
      },
      'application/vnd.spCampaign.v3+json',
      true,
    );
    return this.results(body, 'campaigns', 'campaignId');
  }
}
