import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SourceConnection, SourceProvider } from '../../shared/connections.js';
import { ConnectorError } from '../connectors/connector.js';
import { AppError } from '../validation.js';
import type { AmazonAdsCredential } from './amazon-ads.js';
import { boundedJson, safeFetch } from './http.js';
import type { MetaCredential } from './meta.js';
import { oauthState } from './service.js';
import type { ConnectionRepository } from './repository.js';
import type { ShopifyCredential } from './shopify.js';

const shopPattern = /^[a-z0-9][a-z0-9-]{1,60}\.myshopify\.com$/;

function publicBaseUrl() {
  const raw = process.env.ORBIT_PUBLIC_URL?.trim() || `http://127.0.0.1:${process.env.PORT || 4311}`;
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!loopback && url.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(url.protocol)))
    throw new AppError('ORBIT_PUBLIC_URL must use HTTPS outside loopback.', 503);
  if (url.username || url.password || url.search || url.hash)
    throw new AppError('ORBIT_PUBLIC_URL cannot include credentials, a query, or a fragment.', 503);
  return url.toString().replace(/\/$/, '');
}

const redirectUri = (provider: SourceProvider) =>
  `${publicBaseUrl()}/api/oauth/${encodeURIComponent(provider)}/callback`;

export function verifyShopifyHmac(params: URLSearchParams, secret: string) {
  const supplied = params.get('hmac') || '';
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const entries: [string, string][] = [];
  for (const [key, value] of params.entries())
    if (key !== 'hmac' && key !== 'signature') entries.push([key, value]);
  entries.sort(([a], [b]) => a.localeCompare(b));
  const message = entries.map(([key, value]) => `${key}=${value}`).join('&');
  const expected = createHmac('sha256', secret).update(message).digest();
  return timingSafeEqual(expected, Buffer.from(supplied, 'hex'));
}

export class ConnectionOAuth {
  constructor(
    private repository: ConnectionRepository,
    private fetcher: typeof fetch = fetch,
    private clock: () => Date = () => new Date(),
  ) {}

  start(connection: SourceConnection, input: { shopDomain?: string }) {
    if (connection.authMode !== 'oauth')
      throw new AppError('This connection does not use OAuth authorization.');
    if (connection.provider === 'pbs')
      throw new AppError('PBS HQ currently uses a scoped server token connection.');
    const state = oauthState();
    const redirect = redirectUri(connection.provider);
    let url: URL;
    let metadata: Record<string, unknown> = { redirectUri: redirect };
    if (connection.provider === 'shopify') {
      const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
      if (!clientId || !process.env.SHOPIFY_CLIENT_SECRET?.trim())
        throw new AppError('Configure SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET first.', 503);
      const shop = input.shopDomain?.trim().toLowerCase() || '';
      if (!shopPattern.test(shop)) throw new AppError('Use the permanent *.myshopify.com domain.');
      metadata = { ...metadata, shopDomain: shop };
      url = new URL(`https://${shop}/admin/oauth/authorize`);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set(
        'scope',
        process.env.SHOPIFY_SCOPES?.trim() || 'read_products,read_inventory,read_orders',
      );
      url.searchParams.set('redirect_uri', redirect);
      url.searchParams.set('state', state);
    } else if (connection.provider === 'meta-ads') {
      const clientId = process.env.META_APP_ID?.trim();
      if (!clientId || !process.env.META_APP_SECRET?.trim())
        throw new AppError('Configure META_APP_ID and META_APP_SECRET first.', 503);
      url = new URL('https://www.facebook.com/dialog/oauth');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirect);
      url.searchParams.set('state', state);
      url.searchParams.set('scope', 'ads_read,business_management');
      url.searchParams.set('response_type', 'code');
    } else {
      const clientId = process.env.AMAZON_ADS_CLIENT_ID?.trim();
      if (!clientId || !process.env.AMAZON_ADS_CLIENT_SECRET?.trim())
        throw new AppError('Configure the approved Amazon Ads Login with Amazon app first.', 503);
      url = new URL('https://www.amazon.com/ap/oa');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('scope', 'advertising::campaign_management');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirect);
      url.searchParams.set('state', state);
    }
    const now = this.clock();
    this.repository.createOAuthState(connection, state, metadata, now);
    const next: SourceConnection = {
      ...connection,
      health: {
        ...connection.health,
        status: 'authorizing',
        message: 'Waiting for provider authorization.',
      },
      updatedAt: now.toISOString(),
    };
    this.repository.saveConnection(next);
    this.repository.event(
      next,
      next.dataset,
      next.clientId,
      'connection.oauth.started',
      `${next.name}: authorization state issued with a 10-minute expiry.`,
      now,
    );
    return { authorizationUrl: url.toString(), expiresInSeconds: 600 };
  }

  async callback(provider: SourceProvider, params: URLSearchParams) {
    const state = params.get('state') || '';
    const code = params.get('code') || '';
    if (!state || !code) throw new AppError('Authorization callback is missing code or state.');
    if (params.get('error')) throw new AppError('The provider declined authorization.');
    if (provider === 'shopify') {
      const secret = process.env.SHOPIFY_CLIENT_SECRET?.trim() || '';
      if (!secret || !verifyShopifyHmac(params, secret))
        throw new AppError('Shopify callback signature is invalid.');
    }
    const consumed = this.repository.consumeOAuthState(state, provider, this.clock());
    const connection = consumed.connection;
    let credential: ShopifyCredential | MetaCredential | AmazonAdsCredential;
    let scopes: string[] = [];
    if (provider === 'shopify') {
      const expectedShop = String(consumed.metadata.shopDomain || '');
      const returnedShop = (params.get('shop') || '').toLowerCase();
      if (!shopPattern.test(returnedShop) || returnedShop !== expectedShop)
        throw new AppError('Shopify returned a different store identity.');
      const response = await safeFetch(
        this.fetcher,
        new URL(`https://${returnedShop}/admin/oauth/access_token`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: process.env.SHOPIFY_CLIENT_ID,
            client_secret: process.env.SHOPIFY_CLIENT_SECRET,
            code,
          }),
        },
        'Shopify',
        (host) => host === returnedShop,
      );
      const token = z
        .object({ access_token: z.string().min(10), scope: z.string() })
        .parse(await boundedJson(response, 'Shopify'));
      credential = { accessToken: token.access_token, shopDomain: returnedShop };
      scopes = token.scope.split(',').map((item) => item.trim()).filter(Boolean);
    } else if (provider === 'meta-ads') {
      const version = process.env.META_GRAPH_API_VERSION || 'v24.0';
      const redirect = String(consumed.metadata.redirectUri);
      const firstUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
      firstUrl.searchParams.set('client_id', process.env.META_APP_ID || '');
      firstUrl.searchParams.set('client_secret', process.env.META_APP_SECRET || '');
      firstUrl.searchParams.set('redirect_uri', redirect);
      firstUrl.searchParams.set('code', code);
      const first = await safeFetch(
        this.fetcher,
        firstUrl,
        {},
        'Meta',
        (host) => host === 'graph.facebook.com',
      );
      const short = z
        .object({ access_token: z.string().min(10) })
        .parse(await boundedJson(first, 'Meta'));
      const longUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
      longUrl.searchParams.set('grant_type', 'fb_exchange_token');
      longUrl.searchParams.set('client_id', process.env.META_APP_ID || '');
      longUrl.searchParams.set('client_secret', process.env.META_APP_SECRET || '');
      longUrl.searchParams.set('fb_exchange_token', short.access_token);
      const long = await safeFetch(
        this.fetcher,
        longUrl,
        {},
        'Meta',
        (host) => host === 'graph.facebook.com',
      );
      const token = z
        .object({ access_token: z.string().min(10) })
        .parse(await boundedJson(long, 'Meta'));
      credential = { accessToken: token.access_token };
      scopes = ['ads_read', 'business_management'];
    } else {
      const response = await safeFetch(
        this.fetcher,
        new URL('https://api.amazon.com/auth/o2/token'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: process.env.AMAZON_ADS_CLIENT_ID || '',
            client_secret: process.env.AMAZON_ADS_CLIENT_SECRET || '',
            redirect_uri: String(consumed.metadata.redirectUri),
          }).toString(),
        },
        'Amazon Login with Amazon',
        (host) => host === 'api.amazon.com',
      );
      const token = z
        .object({ refresh_token: z.string().min(10) })
        .parse(await boundedJson(response, 'Amazon Login with Amazon'));
      const region = (process.env.AMAZON_ADS_REGION || 'NA').toUpperCase();
      if (!['NA', 'EU', 'FE'].includes(region))
        throw new ConnectorError('invalid', 'AMAZON_ADS_REGION must be NA, EU, or FE.');
      credential = {
        clientId: process.env.AMAZON_ADS_CLIENT_ID || '',
        clientSecret: process.env.AMAZON_ADS_CLIENT_SECRET || '',
        refreshToken: token.refresh_token,
        region: region as AmazonAdsCredential['region'],
      };
      scopes = ['advertising::campaign_management'];
    }
    const now = this.clock();
    const next: SourceConnection = {
      ...connection,
      scopes,
      secretConfigured: true,
      health: {
        ...connection.health,
        status: 'connected',
        message: 'Authorization completed. Run the first read-only sync.',
      },
      updatedAt: now.toISOString(),
    };
    this.repository.store.transaction(() => {
      this.repository.saveSecret(connection, credential, now);
      this.repository.saveConnection(next);
      this.repository.event(
        next,
        next.dataset,
        next.clientId,
        'connection.oauth.completed',
        `${next.name}: encrypted credentials saved; no platform write was made.`,
        now,
      );
    });
    return next;
  }
}
