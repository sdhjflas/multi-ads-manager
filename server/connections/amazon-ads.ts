import type { SourceConnection } from '../../shared/connections.js';
import { AmazonAdsConnector, type AmazonConfig } from '../connectors/amazon.js';
import { ConnectorError, type ReportRow } from '../connectors/connector.js';
import type { AmazonReportJob, ReportCache } from '../connectors/amazon-reports.js';
import type { Store } from '../store.js';
import { dayAt } from '../engine.js';
import type { ProviderObserver, ProviderSyncResult } from './provider.js';

export type AmazonAdsCredential = Pick<
  AmazonConfig,
  'clientId' | 'clientSecret' | 'refreshToken' | 'region'
>;

class ConnectionReportCache implements ReportCache {
  constructor(
    private store: Store,
    private connectionId: string,
    private clock: () => Date,
  ) {}
  get(key: string) {
    const row = this.store.db
      .prepare(
        'SELECT body,payload FROM connection_amazon_report_jobs WHERE key=? AND connection_id=?',
      )
      .get(key, this.connectionId) as { body: string; payload: string | null } | undefined;
    return row
      ? {
          job: JSON.parse(row.body) as AmazonReportJob,
          rows: row.payload ? (JSON.parse(row.payload) as ReportRow[]) : null,
        }
      : null;
  }
  set(job: AmazonReportJob, rows?: ReportRow[]) {
    this.store.db
      .prepare(
        `INSERT INTO connection_amazon_report_jobs(key,connection_id,updated_at,body,payload)
         VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
         updated_at=excluded.updated_at,body=excluded.body,payload=excluded.payload`,
      )
      .run(
        job.key,
        this.connectionId,
        this.clock().toISOString(),
        JSON.stringify(job),
        rows ? JSON.stringify(rows) : null,
      );
  }
}

export class AmazonAdsObserver implements ProviderObserver {
  constructor(
    private credential: AmazonAdsCredential,
    private store: Store,
    private fetcher: typeof fetch = fetch,
    private clock: () => Date = () => new Date(),
  ) {}

  async collect(connection: SourceConnection, _since: string | null): Promise<ProviderSyncResult> {
    const profileId = connection.externalAccountId || '';
    const discovery = new AmazonAdsConnector(
      { ...this.credential, profileId, writesEnabled: false },
      this.fetcher,
    );
    const profiles = await discovery.listProfiles();
    const profile = profileId
      ? profiles.find((item) => item.profileId === profileId)
      : profiles.length === 1
        ? profiles[0]
        : undefined;
    if (!profile && !profileId && profiles.length > 1)
      throw new ConnectorError(
        'invalid',
        'This authorization can see multiple Amazon Ads profiles. Enter the intended profile ID.',
      );
    if (!profile)
      throw new ConnectorError('auth', 'The authorization cannot access the selected Amazon Ads profile.');
    if (profile.currencyCode !== 'USD')
      throw new ConnectorError('invalid', `Amazon Ads profile currency ${profile.currencyCode} is unsupported; Orbit currently requires USD.`);
    const connector = new AmazonAdsConnector(
      {
        ...this.credential,
        profileId: profile.profileId,
        writesEnabled: false,
        timezone: profile.timezone,
      },
      this.fetcher,
      () => this.clock().getTime(),
      undefined,
      new ConnectionReportCache(this.store, connection.id, this.clock),
      connection.id,
    );
    const campaigns = await connector.listCampaigns();
    const ids = campaigns.map((campaign) => campaign.externalId);
    const [adGroups, keywords, negatives, targets, negativeTargets] = await Promise.all([
      connector.listAdGroups(ids),
      connector.listKeywords(ids),
      connector.listNegativeKeywords(ids),
      connector.listProductTargets(ids),
      connector.listNegativeProductTargets(ids),
    ]);
    const current = this.clock();
    const now = current.toISOString();
    const endDate = dayAt(current, -1, profile.timezone);
    const startDate = dayAt(current, -60, profile.timezone);
    let campaignReport: ReportRow[] = [];
    let productReport: ReportRow[] = [];
    let pending = false;
    let retryAfterMs = 60_000;
    try {
      [campaignReport, productReport] = await Promise.all([
        connector.report('campaign', startDate, endDate, 14),
        connector.report('advertisedProduct', startDate, endDate, 14),
      ]);
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.kind !== 'pending') throw error;
      pending = true;
      retryAfterMs = error.retryAfterMs || retryAfterMs;
    }
    const objects = (kind: string, rows: { externalId: string }[]) =>
      rows.map((value) => ({ kind, externalId: value.externalId, observedAt: now, value }));
    return {
      identity: {
        externalAccountId: profile.profileId,
        externalAccountName: profile.accountInfo.name || `Amazon profile ${profile.profileId}`,
        currency: profile.currencyCode,
        timezone: profile.timezone,
        region: this.credential.region,
      },
      objects: {
        campaign: objects('campaign', campaigns),
        'ad-group': objects('ad-group', adGroups),
        keyword: objects('keyword', keywords),
        'negative-keyword': objects('negative-keyword', negatives),
        'product-target': objects('product-target', targets),
        'negative-product-target': objects('negative-product-target', negativeTargets),
        insight: campaignReport.map((value) => ({
          kind: 'insight',
          externalId: `${value.campaignExternalId}:${value.date}`,
          observedAt: value.observedAt || now,
          value,
        })),
        'advertised-product': productReport.map((value) => ({
          kind: 'advertised-product',
          externalId: `${value.campaignExternalId}:${value.adExternalId || value.advertisedAsin || 'unknown'}:${value.date}`,
          observedAt: value.observedAt || now,
          value,
        })),
      },
      counts: {
        accounts: profiles.length,
        campaigns: campaigns.length,
        adGroups: adGroups.length,
        keywords: keywords.length,
        targets: targets.length,
        negatives: negatives.length + negativeTargets.length,
        insights: campaignReport.length + productReport.length,
      },
      watermark: null,
      sourceAsOf: now,
      warnings: pending
        ? ['Amazon is generating restart-safe daily campaign and advertised-product reports.']
        : [],
      pending,
      retryAfterMs,
    };
  }
}
