import { z } from 'zod';
import type { SourceConnection } from '../../shared/connections.js';
import { ConnectorError } from '../connectors/connector.js';
import { boundedJson, safeFetch } from './http.js';
import type { ProviderObserver, ProviderSyncResult } from './provider.js';

export interface MetaCredential {
  accessToken: string;
}

const graphPage = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
  paging: z
    .object({ next: z.url().optional(), cursors: z.record(z.string(), z.string()).optional() })
    .optional(),
});
const accountSchema = z.object({
  id: z.string().regex(/^act_\d+$/),
  name: z.string(),
  currency: z.string(),
  timezone_name: z.string().nullable().optional(),
  account_status: z.coerce.number().int(),
});
const entitySchema = z.object({ id: z.string(), name: z.string().optional() }).passthrough();
const insightSchema = z
  .object({
    account_id: z.string(),
    campaign_id: z.string(),
    adset_id: z.string(),
    ad_id: z.string(),
    date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_stop: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    impressions: z.string().regex(/^\d+$/),
    clicks: z.string().regex(/^\d+$/),
    spend: z.string().regex(/^\d+(\.\d+)?$/),
    actions: z.array(z.object({ action_type: z.string(), value: z.string() })).optional(),
    action_values: z.array(z.object({ action_type: z.string(), value: z.string() })).optional(),
  })
  .passthrough();

function decimalCents(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER / 100)
    throw new ConnectorError('invalid', 'Meta returned an invalid money value.');
  return Math.round(number * 100);
}

function preferredAction(rows: { action_type: string; value: string }[] | undefined) {
  if (!rows) return 0;
  const preferences = [
    'omni_purchase',
    'purchase',
    'offsite_conversion.fb_pixel_purchase',
  ];
  for (const kind of preferences) {
    const row = rows.find((item) => item.action_type === kind);
    if (row) {
      const value = Number(row.value);
      if (!Number.isFinite(value) || value < 0)
        throw new ConnectorError('invalid', 'Meta returned an invalid purchase action value.');
      return value;
    }
  }
  return 0;
}

export class MetaAdsObserver implements ProviderObserver {
  private readonly root: string;
  constructor(
    private credential: MetaCredential,
    private fetcher: typeof fetch = fetch,
    apiVersion = process.env.META_GRAPH_API_VERSION || 'v24.0',
  ) {
    if (!/^v\d+\.0$/.test(apiVersion))
      throw new ConnectorError('invalid', 'META_GRAPH_API_VERSION must look like v24.0.');
    this.root = `https://graph.facebook.com/${apiVersion}`;
  }

  private async list(path: string, params: Record<string, string>) {
    const results: Record<string, unknown>[] = [];
    let url = new URL(`${this.root}/${path.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries({ ...params, limit: '100' }))
      url.searchParams.set(key, value);
    for (let page = 0; page < 200; page++) {
      const response = await safeFetch(
        this.fetcher,
        url,
        { headers: { Authorization: `Bearer ${this.credential.accessToken}` } },
        'Meta Ads',
        (host) => host === 'graph.facebook.com',
      );
      const parsed = graphPage.safeParse(await boundedJson(response, 'Meta Ads'));
      if (!parsed.success)
        throw new ConnectorError('invalid', 'Meta Ads returned an unexpected list contract.');
      results.push(...parsed.data.data);
      if (!parsed.data.paging?.next) return results;
      const next = new URL(parsed.data.paging.next);
      if (next.hostname !== 'graph.facebook.com' || next.protocol !== 'https:')
        throw new ConnectorError('invalid', 'Meta Ads returned an unsafe pagination URL.');
      if (next.toString() === url.toString())
        throw new ConnectorError('invalid', 'Meta Ads repeated a pagination URL.');
      next.searchParams.delete('access_token');
      url = next;
      if (page === 199)
        throw new ConnectorError('invalid', 'Meta Ads pagination exceeded the safety limit.');
    }
    return results;
  }

  async collect(connection: SourceConnection, since: string | null): Promise<ProviderSyncResult> {
    const rawAccounts = await this.list('me/adaccounts', {
      fields: 'id,name,currency,timezone_name,account_status',
    });
    const accounts = z.array(accountSchema).parse(rawAccounts);
    let account = connection.externalAccountId
      ? accounts.find((item) => item.id === connection.externalAccountId)
      : accounts.length === 1
        ? accounts[0]
        : undefined;
    if (!account && !connection.externalAccountId && accounts.length > 1)
      throw new ConnectorError(
        'invalid',
        'This authorization can see multiple Meta ad accounts. Enter the intended act_ account ID.',
      );
    if (!account)
      throw new ConnectorError('auth', 'The authorized Meta user cannot access the selected ad account.');
    if (account.currency !== 'USD')
      throw new ConnectorError('invalid', `Meta account currency ${account.currency} is unsupported; Orbit currently requires USD.`);
    const id = account.id;
    const [campaignRows, adSetRows, adRows, creativeRows] = await Promise.all([
      this.list(`${id}/campaigns`, {
        fields: 'id,name,status,effective_status,objective,updated_time',
      }),
      this.list(`${id}/adsets`, {
        fields:
          'id,name,campaign_id,status,effective_status,optimization_goal,billing_event,daily_budget,lifetime_budget,attribution_spec,updated_time',
      }),
      this.list(`${id}/ads`, {
        fields: 'id,name,campaign_id,adset_id,creative{id},status,effective_status,updated_time',
      }),
      this.list(`${id}/adcreatives`, {
        fields: 'id,name,title,body,call_to_action_type,object_story_spec,asset_feed_spec,status',
      }),
    ]);
    const from = since
      ? new Date(Math.max(0, Date.parse(since) - 7 * 86_400_000)).toISOString().slice(0, 10)
      : new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const through = new Date().toISOString().slice(0, 10);
    const insightRows = await this.list(`${id}/insights`, {
      level: 'ad',
      time_increment: '1',
      time_range: JSON.stringify({ since: from, until: through }),
      action_report_time: 'conversion',
      use_account_attribution_setting: 'true',
      fields:
        'account_id,campaign_id,adset_id,ad_id,date_start,date_stop,impressions,clicks,spend,actions,action_values',
    });
    const campaigns = z.array(entitySchema).parse(campaignRows);
    const adSets = z.array(entitySchema).parse(adSetRows);
    const ads = z.array(entitySchema).parse(adRows);
    const creatives = z.array(entitySchema).parse(creativeRows);
    const insights = z.array(insightSchema).parse(insightRows);
    const now = new Date().toISOString();
    const objects = (kind: string, rows: Record<string, unknown>[]) =>
      rows.map((value) => ({
        kind,
        externalId: String(value.id),
        observedAt: typeof value.updated_time === 'string' ? value.updated_time : now,
        value,
      }));
    const insightObjects = insights.map((row) => ({
      kind: 'insight',
      externalId: `${row.ad_id}:${row.date_start}`,
      observedAt: now,
      value: {
        ...row,
        impressions: Number(row.impressions),
        clicks: Number(row.clicks),
        spendCents: decimalCents(row.spend),
        purchases: preferredAction(row.actions),
        purchaseValueCents: decimalCents(String(preferredAction(row.action_values))),
      },
    }));
    return {
      identity: {
        externalAccountId: account.id,
        externalAccountName: account.name,
        currency: account.currency,
        timezone: account.timezone_name || 'UTC',
        region: null,
      },
      objects: {
        campaign: objects('campaign', campaigns),
        'ad-set': objects('ad-set', adSets),
        ad: objects('ad', ads),
        creative: objects('creative', creatives),
        insight: insightObjects,
      },
      counts: {
        accounts: accounts.length,
        campaigns: campaigns.length,
        adSets: adSets.length,
        ads: ads.length,
        creatives: creatives.length,
        insights: insights.length,
      },
      watermark: insights.map((row) => row.date_stop).sort().at(-1) || through,
      sourceAsOf: now,
      warnings:
        account.account_status === 1
          ? []
          : [`Meta reports account status ${account.account_status}; delivery may be unavailable.`],
    };
  }
}
