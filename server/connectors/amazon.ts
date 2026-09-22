import { z } from 'zod';
import {
  campaignEntity,
  adGroupEntity,
  keywordEntity,
  negativeEntity,
  entities,
} from './amazon-entities.js';
import { dayAt } from '../engine.js';
import { createHash } from 'node:crypto';
import { collectReport } from './amazon-report-runner.js';
import { amazonId, limitedBody, MemoryReportCache, type ReportCache } from './amazon-reports.js';
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
 * Report contracts were checked against Amazon's developer documentation on
 * 2026-09-22. See docs/AMAZON_API.md for sources and account verification limits.
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
  timezone?: string;
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
  if (!['NA', 'EU', 'FE'].includes(region))
    throw new ConnectorError('invalid', 'AMAZON_ADS_REGION must be NA, EU, or FE.');
  return {
    clientId,
    clientSecret,
    refreshToken,
    profileId,
    region: region as AmazonConfig['region'],
    writesEnabled: process.env.AMAZON_ADS_WRITES_ENABLED === 'true',
  };
}
export const amazonConfigured = () => amazonConfigFromEnv('probe') !== null;

const state = (value: string): PlatformState =>
  value === 'ENABLED' ? 'enabled' : value === 'PAUSED' ? 'paused' : 'archived';
const upperState = (value: PlatformState) =>
  value === 'enabled' ? 'ENABLED' : value === 'paused' ? 'PAUSED' : 'ARCHIVED';
const cents = (value: unknown) => Math.round(Number(value || 0) * 100);
export class AmazonAdsConnector implements Connector {
  readonly kind = 'amazon-ads' as const;
  readonly writesEnabled: boolean;
  private accessToken: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;
  constructor(
    private config: AmazonConfig,
    private fetcher: typeof fetch = fetch,
    private clock: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private reportCache: ReportCache = new MemoryReportCache(),
    private reportGeneration = 'local',
  ) {
    this.writesEnabled = config.writesEnabled;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > this.clock() + 60_000)
      return this.accessToken.value;
    if (!this.tokenRequest)
      this.tokenRequest = this.refreshToken().finally(() => {
        this.tokenRequest = null;
      });
    return this.tokenRequest;
  }

  private async refreshToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(tokenUrl, {
        method: 'POST',
        redirect: 'error',
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
    const body = z
      .object({
        access_token: z.string().min(1).max(10000),
        expires_in: z.number().positive().max(86400),
      })
      .parse(await response.json());
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
    if (path === '/v2/profiles') delete headers['Amazon-Advertising-API-Scope'];
    if (mediaType) {
      headers.Accept = mediaType;
      headers['Content-Type'] = mediaType;
    } else if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (write) headers.Prefer = 'return=representation';
    let response: Response;
    try {
      response = await this.fetcher(`${endpoints[this.config.region]}${path}`, {
        method,
        redirect: 'error',
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
      const rawRetry = response.headers.get('retry-after') || '2';
      const parsedRetry = /^\d+(\.\d+)?$/.test(rawRetry)
        ? Number(rawRetry) * 1000
        : Date.parse(rawRetry) - this.clock();
      const retryAfter = Number.isFinite(parsedRetry)
        ? Math.min(3600000, Math.max(1000, parsedRetry))
        : 60000;
      if (!write && attempt < 2 && retryAfter <= 10_000) {
        await this.sleep(retryAfter);
        return this.call(method, path, body, mediaType, write, attempt + 1);
      }
      throw new ConnectorError(
        'throttled',
        'Amazon Ads is rate limiting this account.',
        retryAfter,
      );
    }
    if (response.status === 401 && !write && attempt < 1) {
      this.accessToken = null;
      return this.call(method, path, body, mediaType, write, attempt + 1);
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
    if (response.status === 425 && path === '/reporting/reports' && method === 'POST') {
      // Amazon identifies an existing identical request in its duplicate response.
      let existing: string | undefined;
      try {
        const duplicate = JSON.parse((await limitedBody(response, 20000)).toString('utf8')) as {
          reportId?: unknown;
          detail?: unknown;
        };
        existing =
          typeof duplicate.reportId === 'string' && /^[a-f0-9-]{36}$/i.test(duplicate.reportId)
            ? duplicate.reportId
            : typeof duplicate.detail === 'string'
              ? duplicate.detail.match(
                  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
                )?.[0]
              : undefined;
      } catch {
        /* No response body or no recoverable identifier. */
      }
      if (existing) return { reportId: existing, status: 'PENDING' } as T;
      throw new ConnectorError(
        'ambiguous',
        'Amazon reports an identical pending request. Resume it with its existing report ID or retry the same request later.',
      );
    }
    if (!response.ok)
      throw new ConnectorError(
        'invalid',
        `Amazon Ads returned HTTP ${response.status} for ${path}.`,
      );
    try {
      return JSON.parse((await limitedBody(response, 20_000_000)).toString('utf8')) as T;
    } catch {
      throw new ConnectorError(
        write ? 'ambiguous' : 'invalid',
        'Amazon returned an unreadable response.',
      );
    }
  }

  private async listAll<T>(
    path: string,
    mediaType: string,
    key: string,
    filter: Record<string, unknown>,
  ): Promise<T[]> {
    const items: T[] = [];
    let nextToken: string | undefined;
    let totalResults: number | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const body = (await this.call<Record<string, unknown>>(
        'POST',
        path,
        { ...filter, maxResults: 100, ...(nextToken ? { nextToken } : {}) },
        mediaType,
        false,
      )) as Record<string, unknown>;
      if (!Array.isArray(body[key]))
        throw new ConnectorError('invalid', `Amazon list response is missing ${key}.`);
      items.push(...(body[key] as T[]));
      if (body.totalResults !== undefined) {
        if (!Number.isSafeInteger(body.totalResults) || (body.totalResults as number) < 0)
          throw new ConnectorError('invalid', 'Amazon returned a malformed result count.');
        if (totalResults !== undefined && totalResults !== body.totalResults)
          throw new ConnectorError('invalid', 'Amazon changed the result count during pagination.');
        totalResults = body.totalResults as number;
      }
      const rawNextToken = body.nextToken;
      if (rawNextToken === undefined || rawNextToken === null || rawNextToken === '') {
        if (totalResults !== undefined && items.length !== totalResults)
          throw new ConnectorError(
            'invalid',
            'Amazon ended pagination before returning every advertised result.',
          );
        return items;
      }
      if (typeof rawNextToken !== 'string' || seen.has(rawNextToken))
        throw new ConnectorError('invalid', 'Amazon repeated or malformed a pagination token.');
      nextToken = rawNextToken;
      seen.add(nextToken);
    }
    throw new ConnectorError(
      'invalid',
      'Amazon pagination exceeded the local limit; incomplete state was not accepted.',
    );
  }

  private async listByCampaigns(
    path: string,
    media: string,
    key: string,
    ids: string[],
  ): Promise<unknown[]> {
    const result: unknown[] = [];
    const unique = [...new Set(ids)];
    for (let offset = 0; offset < unique.length; offset += 100)
      result.push(
        ...(await this.listAll<unknown>(path, media, key, {
          campaignIdFilter: { include: unique.slice(offset, offset + 100) },
        })),
      );
    return result;
  }

  async listCampaigns(): Promise<PlatformCampaign[]> {
    const items = entities(
      campaignEntity,
      await this.listAll<unknown>(
        '/sp/campaigns/list',
        'application/vnd.spCampaign.v3+json',
        'campaigns',
        { stateFilter: { include: ['ENABLED', 'PAUSED'] } },
      ),
      'campaignId',
    );
    return items.map((c) => ({
      externalId: c.campaignId,
      name: c.name,
      state: state(c.state),
      dailyBudgetCents: cents(c.budget.budget),
      targetingType: c.targetingType === 'AUTO' ? 'auto' : 'manual',
    }));
  }
  async listAdGroups(ids: string[]): Promise<PlatformAdGroup[]> {
    const items = entities(
      adGroupEntity,
      await this.listByCampaigns(
        '/sp/adGroups/list',
        'application/vnd.spAdGroup.v3+json',
        'adGroups',
        ids,
      ),
      'adGroupId',
    );
    return items.map((g) => ({
      externalId: g.adGroupId,
      campaignExternalId: g.campaignId,
      name: g.name,
      state: state(g.state),
      defaultBidCents: cents(g.defaultBid),
    }));
  }
  async listKeywords(ids: string[]): Promise<PlatformKeyword[]> {
    const items = entities(
      keywordEntity,
      await this.listByCampaigns(
        '/sp/keywords/list',
        'application/vnd.spKeyword.v3+json',
        'keywords',
        ids,
      ),
      'keywordId',
    );
    return items.map((k) => ({
      externalId: k.keywordId,
      campaignExternalId: k.campaignId,
      adGroupExternalId: k.adGroupId,
      text: k.keywordText,
      matchType: k.matchType.toLowerCase() as KeywordMatch,
      state: state(k.state),
      bidCents: cents(k.bid),
    }));
  }
  async listNegativeKeywords(ids: string[]): Promise<PlatformNegativeKeyword[]> {
    const items = entities(
      negativeEntity,
      await this.listByCampaigns(
        '/sp/negativeKeywords/list',
        'application/vnd.spNegativeKeyword.v3+json',
        'negativeKeywords',
        ids,
      ),
      'keywordId',
    );
    return items.map((n) => ({
      externalId: n.keywordId,
      campaignExternalId: n.campaignId,
      adGroupExternalId: n.adGroupId || null,
      text: n.keywordText,
      matchType: n.matchType === 'NEGATIVE_PHRASE' ? 'negative-phrase' : 'negative-exact',
      state: state(n.state),
    }));
  }

  async listProfiles() {
    const data = await this.call<unknown>('GET', '/v2/profiles', undefined, null, false);
    const schema = z.array(
      z.object({
        profileId: amazonId,
        countryCode: z.string().length(2),
        currencyCode: z.string().length(3),
        timezone: z.string().refine((value) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: value });
            return true;
          } catch {
            return false;
          }
        }),
        accountInfo: z.object({
          id: z.string(),
          name: z.string().optional(),
          type: z.string(),
          marketplaceStringId: z.string().optional(),
          validPaymentMethod: z.boolean().optional(),
        }),
      }),
    );
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw new ConnectorError(
        'invalid',
        'Amazon profiles do not match the documented account contract.',
      );
    return parsed.data;
  }

  async report(
    kind: ReportKind,
    startDate: string,
    endDate: string,
    attributionDays: number,
  ): Promise<ReportRow[]> {
    const today = dayAt(new Date(this.clock()), 0, this.config.timezone || 'UTC');
    if (
      startDate < dayAt(new Date(this.clock()), -94, this.config.timezone || 'UTC') ||
      endDate >= today
    )
      throw new ConnectorError(
        'invalid',
        'Amazon reports must use completed account dates within the 95-day retention window.',
      );
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          this.config.clientId,
          this.config.refreshToken,
          this.config.region,
          this.config.profileId,
          this.reportGeneration,
        ]),
      )
      .digest('hex');
    return collectReport({
      scope: identity,
      kind,
      startDate,
      endDate,
      attributionDays,
      cache: this.reportCache,
      call: (method, path, body, media, write) => this.call(method, path, body, media, write),
      fetcher: this.fetcher,
      now: this.clock,
    });
  }

  private results(body: unknown, key: string, idKey: string, expected: number): MutationResult[] {
    const malformed = () =>
      new ConnectorError(
        'ambiguous',
        'Amazon did not account for every requested write. Read platform state before retrying.',
      );
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw malformed();
    const section = (body as Record<string, unknown>)[key];
    if (!section || typeof section !== 'object' || Array.isArray(section)) throw malformed();
    const success = (section as Record<string, unknown>).success;
    const error = (section as Record<string, unknown>).error;
    if (!Array.isArray(success) || !Array.isArray(error)) throw malformed();
    if (success.length + error.length !== expected) throw malformed();

    const results: MutationResult[] = [];
    const seen = new Set<number>();
    const indexOf = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
      const index = (value as Record<string, unknown>).index;
      if (
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= expected ||
        seen.has(index as number)
      )
        throw malformed();
      seen.add(index as number);
      return index as number;
    };
    for (const raw of success) {
      const index = indexOf(raw);
      const item = raw as Record<string, unknown>;
      const externalId = amazonId.safeParse(item[idKey]);
      if (!externalId.success) throw malformed();
      results.push({ index, ok: true, externalId: externalId.data });
    }
    for (const raw of error) {
      const index = indexOf(raw);
      const item = raw as Record<string, unknown>;
      if (!Array.isArray(item.errors) || item.errors.length < 1 || item.errors.length > 20)
        throw malformed();
      const first = item.errors[0];
      if (!first || typeof first !== 'object' || Array.isArray(first)) throw malformed();
      const errorRecord = first as Record<string, unknown>;
      const code = errorRecord.errorType;
      const values = errorRecord.errorValue;
      if (
        typeof code !== 'string' ||
        code.length < 1 ||
        code.length > 200 ||
        !values ||
        typeof values !== 'object' ||
        Array.isArray(values)
      )
        throw malformed();
      const detail = Object.values(values as Record<string, unknown>).find(
        (value) => value && typeof value === 'object' && !Array.isArray(value),
      ) as Record<string, unknown> | undefined;
      const message = detail?.message;
      if (typeof message !== 'string' || message.length < 1 || message.length > 2000)
        throw malformed();
      results.push({
        index,
        ok: false,
        code,
        message,
      });
    }
    if (seen.size !== expected) throw malformed();
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
    const body = await this.call<unknown>(
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
    return this.results(body, 'keywords', 'keywordId', items.length);
  }
  async updateKeywords(items: KeywordUpdate[]): Promise<MutationResult[]> {
    this.writable();
    const body = await this.call<unknown>(
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
    return this.results(body, 'keywords', 'keywordId', items.length);
  }
  async createNegativeKeywords(items: NegativeCreate[]): Promise<MutationResult[]> {
    this.writable();
    const body = await this.call<unknown>(
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
    return this.results(body, 'negativeKeywords', 'negativeKeywordId', items.length);
  }
  async updateCampaigns(items: CampaignUpdate[]): Promise<MutationResult[]> {
    this.writable();
    const body = await this.call<unknown>(
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
    return this.results(body, 'campaigns', 'campaignId', items.length);
  }
}
