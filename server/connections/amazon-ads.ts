import type { SourceConnection } from '../../shared/connections.js';
import { AmazonAdsConnector, type AmazonConfig } from '../connectors/amazon.js';
import { ConnectorError } from '../connectors/connector.js';
import type { ProviderObserver, ProviderSyncResult } from './provider.js';

export type AmazonAdsCredential = Pick<
  AmazonConfig,
  'clientId' | 'clientSecret' | 'refreshToken' | 'region'
>;

export class AmazonAdsObserver implements ProviderObserver {
  constructor(
    private credential: AmazonAdsCredential,
    private fetcher: typeof fetch = fetch,
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
    const now = new Date().toISOString();
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
      },
      counts: {
        accounts: profiles.length,
        campaigns: campaigns.length,
        adGroups: adGroups.length,
        keywords: keywords.length,
        targets: targets.length,
        negatives: negatives.length + negativeTargets.length,
      },
      watermark: null,
      sourceAsOf: now,
      warnings: [
        'Entity discovery is healthy. Daily performance reports continue through the restart-safe Amazon reporting jobs after this profile is linked in The brain.',
      ],
    };
  }
}
