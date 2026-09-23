import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { SourceConnection } from '../shared/connections.js';
import { emptyConnectionCounts } from '../shared/connections.js';
import { createApp } from '../server/app.js';
import { ConnectionRepository } from '../server/connections/repository.js';
import { ConnectionService } from '../server/connections/service.js';
import { MetaAdsObserver } from '../server/connections/meta.js';
import { PbsObserver } from '../server/connections/pbs.js';
import { amazonConfigFor } from '../server/connections/amazon-config.js';
import { verifyShopifyHmac } from '../server/connections/oauth.js';
import { CredentialVault } from '../server/security/vault.js';
import { Store } from '../server/store.js';

const vault = () => new CredentialVault(Buffer.alloc(32, 7).toString('base64'));
const now = new Date('2026-09-22T16:00:00.000Z');
const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

function connection(provider: SourceConnection['provider'], externalAccountId: string | null = null): SourceConnection {
  return {
    id: `connection-${provider}`,
    dataset: 'workspace',
    clientId: 'workspace-default-client',
    provider,
    name: provider,
    authMode: 'token',
    externalAccountId,
    externalAccountName: null,
    region: null,
    currency: null,
    timezone: null,
    scopes: [],
    readOnly: true,
    secretConfigured: true,
    capabilities: [],
    health: {
      status: 'connected',
      message: '',
      lastAttemptAt: null,
      lastSuccessAt: null,
      watermark: null,
      sourceAsOf: null,
      nextSyncAt: null,
      counts: emptyConnectionCounts(),
    },
    resourceId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function shopifyFetch(state: { cancelled?: boolean } = {}) {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: { cursor?: string } };
    if (body.query.includes('OrbitShop'))
      return json({
        data: {
          shop: {
            id: 'gid://shopify/Shop/1',
            name: 'Enthusiast Supply Co',
            currencyCode: 'USD',
            timezoneAbbreviation: 'EDT',
            ianaTimezone: 'America/New_York',
          },
        },
      });
    if (body.query.includes('OrbitVariants')) {
      const second = body.variables.cursor === 'next-products';
      return json({
        data: {
          productVariants: {
            pageInfo: {
              hasNextPage: !second,
              endCursor: second ? 'done-products' : 'next-products',
            },
            nodes: second
              ? [
                  {
                    id: 'gid://shopify/ProductVariant/12',
                    title: 'Blue',
                    sku: null,
                    price: '44.50',
                    inventoryQuantity: 4,
                    updatedAt: '2026-09-22T14:00:00.000Z',
                    product: {
                      id: 'gid://shopify/Product/2',
                      title: 'Unmapped item',
                      handle: 'unmapped',
                      updatedAt: '2026-09-22T14:00:00.000Z',
                    },
                  },
                ]
              : [
                  {
                    id: 'gid://shopify/ProductVariant/11',
                    title: 'Black',
                    sku: 'SHIFT-01',
                    price: '49.995',
                    inventoryQuantity: 18,
                    updatedAt: '2026-09-22T13:00:00.000Z',
                    product: {
                      id: 'gid://shopify/Product/1',
                      title: 'Shift knob',
                      handle: 'shift-knob',
                      updatedAt: '2026-09-22T13:00:00.000Z',
                    },
                  },
                ],
          },
        },
      });
    }
    if (body.query.includes('OrbitOrders'))
      return json({
        data: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'gid://shopify/Order/101',
                name: '#101',
                processedAt: '2026-09-21T10:00:00.000Z',
                updatedAt: state.cancelled
                  ? '2026-09-22T15:30:00.000Z'
                  : '2026-09-22T15:00:00.000Z',
                cancelledAt: state.cancelled ? '2026-09-22T15:30:00.000Z' : null,
                test: false,
                currencyCode: 'USD',
                displayFinancialStatus: state.cancelled ? 'VOIDED' : 'PARTIALLY_REFUNDED',
                currentShippingPriceSet: {
                  shopMoney: { amount: '5.00', currencyCode: 'USD' },
                },
                lineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'gid://shopify/LineItem/201',
                      sku: 'SHIFT-01',
                      quantity: 2,
                      discountedTotalSet: {
                        shopMoney: { amount: '99.99', currencyCode: 'USD' },
                      },
                    },
                  ],
                },
                refunds: [
                  {
                    id: 'gid://shopify/Refund/301',
                    createdAt: '2026-09-22T15:00:00.000Z',
                    refundLineItems: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          quantity: 1,
                          subtotalSet: {
                            shopMoney: { amount: '49.99', currencyCode: 'USD' },
                          },
                          lineItem: { id: 'gid://shopify/LineItem/201' },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      });
    throw new Error('Unexpected Shopify request');
  }) as unknown as typeof fetch;
}

describe('credential vault and scoped repository', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  it('uses randomized authenticated encryption bound to the connection identity', () => {
    const encryptedA = vault().encrypt({ token: 'secret-value' }, 'connection:a');
    const encryptedB = vault().encrypt({ token: 'secret-value' }, 'connection:a');
    expect(encryptedA.ciphertext).not.toBe(encryptedB.ciphertext);
    expect(JSON.stringify(encryptedA)).not.toContain('secret-value');
    expect(vault().decrypt(encryptedA, 'connection:a')).toEqual({ token: 'secret-value' });
    expect(() => vault().decrypt(encryptedA, 'connection:b')).toThrow(/authenticated/);
    expect(() =>
      vault().decrypt({ ...encryptedA, ciphertext: `${encryptedA.ciphertext.slice(0, -2)}AA` }, 'connection:a'),
    ).toThrow(/authenticated/);
  });

  it('keeps connection and secret reads inside the selected client scope', () => {
    const repository = new ConnectionRepository(store, vault());
    const primary = repository.ensureDefaultClient('workspace');
    store.db
      .prepare('INSERT INTO client_workspaces(id,dataset,name,created_at) VALUES(?,?,?,?)')
      .run('other-client', 'workspace', 'Other client', now.toISOString());
    const service = new ConnectionService(store, repository, fetch, () => now);
    const saved = service.create({
      dataset: 'workspace',
      clientId: primary.id,
      provider: 'meta-ads',
      name: 'Private Meta',
      authMode: 'token',
      credentials: { accessToken: 'very-private-access-token' },
    });
    expect(repository.connection('workspace', primary.id, saved.id).secretConfigured).toBe(true);
    expect(() => repository.connection('workspace', 'other-client', saved.id)).toThrow(/not found/);
    const intruder = new ConnectionRepository(store, vault(), 'another-operator');
    expect(intruder.clients('workspace')).toHaveLength(0);
    expect(() => intruder.client('workspace', primary.id)).toThrow(/not found/);
    expect(JSON.stringify(repository.connections('workspace', primary.id))).not.toContain(
      'very-private-access-token',
    );
    const encrypted = store.db
      .prepare('SELECT body FROM connection_secrets WHERE connection_id=?')
      .get(saved.id) as { body: string };
    expect(encrypted.body).not.toContain('very-private-access-token');
  });

  it('consumes OAuth state once and rejects expiry or a provider mismatch', () => {
    const repository = new ConnectionRepository(store, vault());
    const client = repository.ensureDefaultClient('workspace');
    const service = new ConnectionService(store, repository, fetch, () => now);
    const saved = service.create({
      dataset: 'workspace',
      clientId: client.id,
      provider: 'meta-ads',
      name: 'OAuth Meta',
      authMode: 'oauth',
    });
    repository.createOAuthState(saved, 'one-time-state', { redirectUri: 'http://localhost' }, now);
    expect(repository.consumeOAuthState('one-time-state', 'meta-ads', now).connection.id).toBe(saved.id);
    expect(() => repository.consumeOAuthState('one-time-state', 'meta-ads', now)).toThrow(/already used/);
    repository.createOAuthState(saved, 'expired-state', {}, now);
    expect(() =>
      repository.consumeOAuthState(
        'expired-state',
        'meta-ads',
        new Date(now.getTime() + 11 * 60_000),
      ),
    ).toThrow(/expired/);
    repository.createOAuthState(saved, 'provider-state', {}, now);
    expect(() => repository.consumeOAuthState('provider-state', 'shopify', now)).toThrow(/invalid/);
  });

  it('hands an encrypted Amazon authorization to the Brain as read-only', () => {
    const previous = {
      ORBIT_VAULT_KEY: process.env.ORBIT_VAULT_KEY,
      AMAZON_ADS_CLIENT_ID: process.env.AMAZON_ADS_CLIENT_ID,
      AMAZON_ADS_CLIENT_SECRET: process.env.AMAZON_ADS_CLIENT_SECRET,
      AMAZON_ADS_REFRESH_TOKEN: process.env.AMAZON_ADS_REFRESH_TOKEN,
    };
    process.env.ORBIT_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
    delete process.env.AMAZON_ADS_CLIENT_ID;
    delete process.env.AMAZON_ADS_CLIENT_SECRET;
    delete process.env.AMAZON_ADS_REFRESH_TOKEN;
    try {
      const repository = new ConnectionRepository(store, vault());
      const client = repository.ensureDefaultClient('workspace');
      new ConnectionService(store, repository, fetch, () => now).create({
        dataset: 'workspace',
        clientId: client.id,
        provider: 'amazon-ads',
        name: 'Books advertiser',
        authMode: 'token',
        externalAccountId: '123456789',
        credentials: {
          clientId: 'amazon-client',
          clientSecret: 'amazon-secret',
          refreshToken: 'amazon-refresh-token',
          region: 'NA',
        },
      });
      expect(amazonConfigFor(store, 'workspace', '123456789')).toEqual({
        clientId: 'amazon-client',
        clientSecret: 'amazon-secret',
        refreshToken: 'amazon-refresh-token',
        profileId: '123456789',
        region: 'NA',
        writesEnabled: false,
        timezone: undefined,
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('does not expose a secondary client Amazon authorization to the dataset-scoped Brain', () => {
    const previous = {
      ORBIT_VAULT_KEY: process.env.ORBIT_VAULT_KEY,
      AMAZON_ADS_CLIENT_ID: process.env.AMAZON_ADS_CLIENT_ID,
      AMAZON_ADS_CLIENT_SECRET: process.env.AMAZON_ADS_CLIENT_SECRET,
      AMAZON_ADS_REFRESH_TOKEN: process.env.AMAZON_ADS_REFRESH_TOKEN,
    };
    process.env.ORBIT_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
    delete process.env.AMAZON_ADS_CLIENT_ID;
    delete process.env.AMAZON_ADS_CLIENT_SECRET;
    delete process.env.AMAZON_ADS_REFRESH_TOKEN;
    try {
      const repository = new ConnectionRepository(store, vault());
      const secondary = repository.createClient('workspace', 'Separate client', now);
      new ConnectionService(store, repository, fetch, () => now).create({
        dataset: 'workspace',
        clientId: secondary.id,
        provider: 'amazon-ads',
        name: 'Private books advertiser',
        authMode: 'token',
        externalAccountId: '987654321',
        credentials: {
          clientId: 'secondary-amazon-client',
          clientSecret: 'secondary-amazon-secret',
          refreshToken: 'secondary-amazon-refresh-token',
          region: 'NA',
        },
      });
      expect(amazonConfigFor(store, 'workspace', '987654321')).toBeNull();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('authenticates Shopify callback query fields', () => {
    const params = new URLSearchParams({ code: 'code-1', shop: 'demo.myshopify.com', state: 'state-1' });
    const message = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    params.set('hmac', createHmac('sha256', 'app-secret').update(message).digest('hex'));
    expect(verifyShopifyHmac(params, 'app-secret')).toBe(true);
    params.set('shop', 'other.myshopify.com');
    expect(verifyShopifyHmac(params, 'app-secret')).toBe(false);
  });
});

describe('connection API and Shopify reconciliation', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  it('rejects browser credential storage when the server vault is not configured', async () => {
    const app = createApp(store, { vault: null });
    const view = await request(app).get('/api/connections?dataset=workspace').expect(200);
    await request(app)
      .post('/api/connections')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        clientId: view.body.activeClientId,
        provider: 'meta-ads',
        name: 'Meta',
        authMode: 'token',
        credentials: { accessToken: 'a-valid-looking-access-token' },
      })
      .expect(503);
  });

  it('rejects credentials attached to OAuth and unsupported PBS authorization modes', async () => {
    const app = createApp(store, { vault: vault(), clock: () => now });
    const view = await request(app).get('/api/connections?dataset=workspace').expect(200);
    await request(app)
      .post('/api/connections')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        clientId: view.body.activeClientId,
        provider: 'meta-ads',
        name: 'Confused Meta OAuth',
        authMode: 'oauth',
        credentials: { accessToken: 'must-not-be-accepted' },
      })
      .expect(400);
    await request(app)
      .post('/api/connections')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        clientId: view.body.activeClientId,
        provider: 'pbs',
        name: 'Unsupported PBS OAuth',
        authMode: 'oauth',
      })
      .expect(400);
    expect(
      (store.db.prepare('SELECT COUNT(*) AS count FROM source_connections').get() as {
        count: number;
      }).count,
    ).toBe(0);
  });

  it('creates isolated client workspaces and does not project them into legacy portfolio tables', async () => {
    const app = createApp(store, { vault: vault(), fetcher: shopifyFetch(), clock: () => now });
    const initial = await request(app).get('/api/connections?dataset=workspace').expect(200);
    const primaryId = initial.body.activeClientId as string;
    const client = await request(app)
      .post('/api/clients')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', name: 'Northwind Books' })
      .expect(201);

    const created = await request(app)
      .post('/api/connections')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        clientId: client.body.id,
        provider: 'shopify',
        name: 'Northwind Shopify',
        authMode: 'token',
        credentials: {
          accessToken: 'shpat_northwind-token-value',
          shopDomain: 'enthusiast.myshopify.com',
        },
      })
      .expect(201);
    const synced = await request(app)
      .post(`/api/connections/${created.body.id}/sync`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: client.body.id })
      .expect(200);

    expect(synced.body.connection.health.status).toBe('partial');
    expect(synced.body.connection.health.counts.unmapped).toBeGreaterThan(1);
    expect(
      (store.db.prepare('SELECT COUNT(*) AS count FROM commerce_stores').get() as { count: number })
        .count,
    ).toBe(0);
    const primary = await request(app)
      .get(`/api/connections?dataset=workspace&clientId=${encodeURIComponent(primaryId)}`)
      .expect(200);
    const northwind = await request(app)
      .get(`/api/connections?dataset=workspace&clientId=${encodeURIComponent(client.body.id)}`)
      .expect(200);
    expect(primary.body.connections).toHaveLength(0);
    expect(northwind.body.connections).toHaveLength(1);
    expect(northwind.body.clients).toHaveLength(2);
    expect(JSON.stringify(northwind.body)).not.toContain('shpat_northwind-token-value');
  });

  it('completes Meta OAuth with one-time state and never exposes either token', async () => {
    const previous = {
      ORBIT_PUBLIC_URL: process.env.ORBIT_PUBLIC_URL,
      META_APP_ID: process.env.META_APP_ID,
      META_APP_SECRET: process.env.META_APP_SECRET,
    };
    process.env.ORBIT_PUBLIC_URL = 'http://127.0.0.1:4311';
    process.env.META_APP_ID = 'meta-client-id';
    process.env.META_APP_SECRET = 'meta-client-secret';
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.searchParams.get('grant_type') === 'fb_exchange_token'
        ? json({ access_token: 'long-lived-meta-token-value' })
        : json({ access_token: 'short-lived-meta-token-value' });
    }) as unknown as typeof fetch;
    try {
      const app = createApp(store, { vault: vault(), fetcher, clock: () => now });
      const view = await request(app).get('/api/connections?dataset=workspace').expect(200);
      const created = await request(app)
        .post('/api/connections')
        .set('X-Orbit-Request', '1')
        .send({
          dataset: 'workspace',
          clientId: view.body.activeClientId,
          provider: 'meta-ads',
          name: 'Meta OAuth',
          authMode: 'oauth',
        })
        .expect(201);
      const started = await request(app)
        .post(`/api/connections/${created.body.id}/oauth/start`)
        .set('X-Orbit-Request', '1')
        .send({ dataset: 'workspace', clientId: view.body.activeClientId })
        .expect(200);
      const state = new URL(started.body.authorizationUrl).searchParams.get('state');
      expect(state).toHaveLength(43);
      await request(app)
        .get(`/api/oauth/meta-ads/callback?state=${encodeURIComponent(state)}&code=provider-code`)
        .expect(303)
        .expect('Location', '/#connections');
      await request(app)
        .get(`/api/oauth/meta-ads/callback?state=${encodeURIComponent(state)}&code=provider-code`)
        .expect(400);
      const safeView = await request(app).get('/api/connections?dataset=workspace').expect(200);
      expect(safeView.body.connections[0].secretConfigured).toBe(true);
      expect(JSON.stringify(safeView.body)).not.toMatch(/short-lived|long-lived|provider-code/);
      const secretRow = store.db.prepare('SELECT body FROM connection_secrets').get() as { body: string };
      expect(secretRow.body).not.toContain('long-lived-meta-token-value');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('paginates Shopify, imports aggregate money without PII, and stays idempotent', async () => {
    const fetcher = shopifyFetch();
    const app = createApp(store, { vault: vault(), fetcher, clock: () => now });
    const view = await request(app).get('/api/connections?dataset=workspace').expect(200);
    const created = await request(app)
      .post('/api/connections')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        clientId: view.body.activeClientId,
        provider: 'shopify',
        name: 'Enthusiast Shopify',
        authMode: 'token',
        credentials: {
          accessToken: 'shpat_test-token-value',
          shopDomain: 'enthusiast.myshopify.com',
        },
      })
      .expect(201);
    const first = await request(app)
      .post(`/api/connections/${created.body.id}/sync`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: view.body.activeClientId })
      .expect(200);
    expect(first.body.connection.health.status).toBe('partial');
    expect(first.body.connection.health.counts.products).toBe(2);
    expect(first.body.connection.health.counts.unmapped).toBe(1);
    const product = JSON.parse(
      (store.db.prepare('SELECT body FROM commerce_products').get() as { body: string }).body,
    );
    expect(product.sku).toBe('SHIFT-01');
    expect(product.retailPriceCents).toBe(5000);
    expect(product.economicsVerified).toBe(false);
    const line = JSON.parse(
      (store.db.prepare('SELECT body FROM commerce_order_lines').get() as { body: string }).body,
    );
    expect(line).toMatchObject({
      sku: 'SHIFT-01',
      units: 2,
      netReceiptsCents: 5500,
      refundsCents: 4999,
    });
    expect(JSON.stringify(line)).not.toMatch(/email|address|customer/i);
    await request(app)
      .post(`/api/connections/${created.body.id}/sync`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: view.body.activeClientId })
      .expect(200);
    expect((store.db.prepare('SELECT COUNT(*) AS count FROM commerce_order_lines').get() as { count: number }).count).toBe(1);
    expect((store.db.prepare('SELECT COUNT(*) AS count FROM commerce_ledger_batches').get() as { count: number }).count).toBe(1);
    const safeView = await request(app).get('/api/connections?dataset=workspace').expect(200);
    expect(JSON.stringify(safeView.body)).not.toContain('shpat_test-token-value');
  });

  it('rejects a second connection that resolves to the same provider account', async () => {
    const app = createApp(store, { vault: vault(), fetcher: shopifyFetch(), clock: () => now });
    const view = await request(app).get('/api/connections?dataset=workspace').expect(200);
    const create = (name: string, token: string) =>
      request(app)
        .post('/api/connections')
        .set('X-Orbit-Request', '1')
        .send({
          dataset: 'workspace',
          clientId: view.body.activeClientId,
          provider: 'shopify',
          name,
          authMode: 'token',
          credentials: {
            accessToken: token,
            shopDomain: 'enthusiast.myshopify.com',
          },
        });
    const first = await create('Primary Shopify', 'shpat_primary-token-value').expect(201);
    await request(app)
      .post(`/api/connections/${first.body.id}/sync`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: view.body.activeClientId })
      .expect(200);
    const duplicate = await create('Duplicate Shopify', 'shpat_duplicate-token-value').expect(201);
    const failed = await request(app)
      .post(`/api/connections/${duplicate.body.id}/sync`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: view.body.activeClientId })
      .expect(409);
    expect(failed.body.error).toMatch(/already connected as Primary Shopify/);
    expect(
      (store.db.prepare('SELECT COUNT(*) AS count FROM commerce_stores').get() as { count: number })
        .count,
    ).toBe(1);
  });

  it('revises a previously paid Shopify line to zero when the source order is cancelled', async () => {
    const source = { cancelled: false };
    const app = createApp(store, { vault: vault(), fetcher: shopifyFetch(source), clock: () => now });
    const view = await request(app).get('/api/connections?dataset=workspace').expect(200);
    const created = await request(app)
      .post('/api/connections')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        clientId: view.body.activeClientId,
        provider: 'shopify',
        name: 'Cancellation-safe Shopify',
        authMode: 'token',
        credentials: {
          accessToken: 'shpat_cancellation-token-value',
          shopDomain: 'enthusiast.myshopify.com',
        },
      })
      .expect(201);
    const sync = () =>
      request(app)
        .post(`/api/connections/${created.body.id}/sync`)
        .set('X-Orbit-Request', '1')
        .send({ dataset: 'workspace', clientId: view.body.activeClientId });
    await sync().expect(200);
    source.cancelled = true;
    await sync().expect(200);
    const line = JSON.parse(
      (store.db.prepare('SELECT body FROM commerce_order_lines').get() as { body: string }).body,
    );
    expect(line).toMatchObject({ units: 0, netReceiptsCents: 0 });
    expect(
      (store.db.prepare('SELECT COUNT(*) AS count FROM commerce_ledger_revisions').get() as {
        count: number;
      }).count,
    ).toBe(2);
  });

  it('marks an interrupted running job failed while preserving queued triggers', () => {
    const repository = new ConnectionRepository(store, vault());
    const client = repository.ensureDefaultClient('workspace');
    const service = new ConnectionService(store, repository, fetch, () => now);
    const saved = service.create({
      dataset: 'workspace',
      clientId: client.id,
      provider: 'meta-ads',
      name: 'Meta',
      authMode: 'token',
      credentials: { accessToken: 'valid-meta-access-token' },
    });
    for (const [id, status] of [
      ['running-job', 'running'],
      ['queued-job', 'queued'],
    ] as const)
      repository.saveJob({
        id,
        dataset: 'workspace',
        clientId: client.id,
        connectionId: saved.id,
        provider: 'meta-ads',
        kind: status === 'queued' ? 'webhook' : 'full-sync',
        status,
        attempt: 1,
        startedAt: now.toISOString(),
        finishedAt: null,
        cursor: null,
        counts: {},
        message: '',
        errorKind: null,
      });
    service.recoverInterruptedJobs();
    const jobs = repository.jobs('workspace', client.id);
    expect(jobs.find((job) => job.id === 'running-job')?.status).toBe('failed');
    expect(jobs.find((job) => job.id === 'queued-job')?.status).toBe('queued');
  });

  it('verifies, deduplicates, and queues Shopify webhooks without retaining the payload', async () => {
    const previous = process.env.SHOPIFY_CLIENT_SECRET;
    process.env.SHOPIFY_CLIENT_SECRET = 'shopify-webhook-secret';
    try {
      const app = createApp(store, { vault: vault(), clock: () => now });
      const view = await request(app).get('/api/connections?dataset=workspace').expect(200);
      const created = await request(app)
        .post('/api/connections')
        .set('X-Orbit-Request', '1')
        .send({
          dataset: 'workspace',
          clientId: view.body.activeClientId,
          provider: 'shopify',
          name: 'Webhook shop',
          authMode: 'token',
          credentials: {
            accessToken: 'shpat_webhook-token',
            shopDomain: 'enthusiast.myshopify.com',
          },
        })
        .expect(201);
      const payload = Buffer.from(JSON.stringify({ id: 44, email: 'must-not-be-saved@example.test' }));
      const signature = createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET)
        .update(payload)
        .digest('base64');
      const send = () =>
        request(app)
          .post(`/api/webhooks/shopify/${created.body.id}`)
          .set('Content-Type', 'application/json')
          .set('X-Shopify-Hmac-Sha256', signature)
          .set('X-Shopify-Shop-Domain', 'enthusiast.myshopify.com')
          .set('X-Shopify-Topic', 'orders/paid')
          .set('X-Shopify-Webhook-Id', 'delivery-44')
          .send(payload.toString('utf8'));
      const accepted = await send().expect(202);
      expect(accepted.body.duplicate).toBeUndefined();
      const duplicate = await send().expect(202);
      expect(duplicate.body.duplicate).toBe(true);
      expect(
        (store.db.prepare('SELECT COUNT(*) AS count FROM connection_webhook_receipts').get() as { count: number }).count,
      ).toBe(1);
      expect(
        (store.db.prepare("SELECT COUNT(*) AS count FROM connection_jobs WHERE status='queued'").get() as { count: number }).count,
      ).toBe(1);
      const databaseText = JSON.stringify(
        store.db.prepare('SELECT body FROM connection_events').all(),
      );
      expect(databaseText).not.toContain('must-not-be-saved@example.test');
      await request(app)
        .post(`/api/webhooks/shopify/${created.body.id}`)
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Hmac-Sha256', Buffer.alloc(32).toString('base64'))
        .set('X-Shopify-Shop-Domain', 'enthusiast.myshopify.com')
        .set('X-Shopify-Topic', 'orders/paid')
        .set('X-Shopify-Webhook-Id', 'delivery-45')
        .send(payload.toString('utf8'))
        .expect(401);
    } finally {
      if (previous === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
      else process.env.SHOPIFY_CLIENT_SECRET = previous;
    }
  });
});

describe('Meta and PBS observation contracts', () => {
  it('collects every Meta entity page and chooses one non-duplicated purchase action basis', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/me/adaccounts'))
        return json({
          data: [
            {
              id: 'act_123',
              name: 'Product Ads',
              currency: 'USD',
              timezone_name: 'America/New_York',
              account_status: 1,
            },
          ],
        });
      if (url.pathname.endsWith('/act_123/campaigns'))
        return json({ data: [{ id: 'c1', name: 'Campaign', updated_time: now.toISOString() }] });
      if (url.pathname.endsWith('/act_123/adsets')) return json({ data: [{ id: 's1', name: 'Set' }] });
      if (url.pathname.endsWith('/act_123/ads')) return json({ data: [{ id: 'a1', name: 'Ad' }] });
      if (url.pathname.endsWith('/act_123/adcreatives'))
        return json({ data: [{ id: 'x1', name: 'Creative' }] });
      if (url.pathname.endsWith('/act_123/insights'))
        return json({
          data: [
            {
              account_id: '123',
              campaign_id: 'c1',
              adset_id: 's1',
              ad_id: 'a1',
              date_start: '2026-09-21',
              date_stop: '2026-09-21',
              impressions: '1000',
              clicks: '30',
              spend: '12.345',
              actions: [
                { action_type: 'omni_purchase', value: '2' },
                { action_type: 'purchase', value: '2' },
              ],
              action_values: [
                { action_type: 'omni_purchase', value: '75.50' },
                { action_type: 'purchase', value: '75.50' },
              ],
            },
          ],
        });
      throw new Error(`Unexpected Meta URL ${url}`);
    }) as unknown as typeof fetch;
    const result = await new MetaAdsObserver({ accessToken: 'meta-access-token' }, fetcher).collect(
      connection('meta-ads', 'act_123'),
      null,
    );
    expect(result.counts).toMatchObject({ campaigns: 1, adSets: 1, ads: 1, creatives: 1, insights: 1 });
    expect(result.objects.insight[0].value).toMatchObject({
      spendCents: 1235,
      purchases: 2,
      purchaseValueCents: 7550,
    });
  });

  it('uses PBS publisher-scoped title, availability, and settlement contracts', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/titles'))
        return json({
          pub_code: 'HB',
          period: { label: 'Last 90 days', from: '2026-06-25', to: '2026-09-22' },
          filter: { format: 'all', search: '', sort: 'title' },
          titles: [
            {
              bk_num: 'HB001',
              isbn: '9780000000001',
              isbn13: '9780000000001',
              title: 'A Real Book',
              author: 'Author',
              format: 'PB',
              ebook_ind: false,
              price: 18.95,
              units_sold_through: 20,
              units_returned: 2,
              net_sales: 190,
              net_sales_earned: 210,
              units_on_hand: 100,
              units_consigned_out: 20,
              amazon_at_vendor: 15,
              ingram_at_vendor: 5,
              months_of_stock: 4,
              has_companion_format: false,
            },
          ],
          count: 1,
        });
      if (url.pathname.endsWith('/statements'))
        return json({
          pub_code: 'HB',
          publisher_name: 'Harbor Books',
          statements: [
            { period: '2026-08', label: 'August 2026', net_sales: 190, payments: 100, entry_count: 2, in_progress: false },
          ],
        });
      if (url.pathname.endsWith('/statements/2026-08'))
        return json({
          pub_code: 'HB',
          period: { month: '2026-08', label: 'August 2026', from: '2026-08-01', to: '2026-08-31', in_progress: false },
          earnings_by_title: [{ bk_num: 'HB001', isbn: '9780000000001', title: 'A Real Book', net_sales: 190, units_sold_through: 20 }],
          period_payments: [{ keyfield: 1, amount: 100 }],
          payment_total: 100,
          reserve_held: 0,
          inventory_snapshot: { as_of: '2026-09-22' },
          account_summary: {},
          billing: {},
        });
      throw new Error(`Unexpected PBS URL ${url}`);
    }) as unknown as typeof fetch;
    const result = await new PbsObserver(
      { baseUrl: 'https://pbs.test/', accessToken: 'pbs-scoped-token', publisherCode: 'hb' },
      fetcher,
    ).collect(connection('pbs'), null);
    expect(result.identity).toMatchObject({ externalAccountId: 'HB', externalAccountName: 'Harbor Books' });
    expect(result.counts).toMatchObject({ books: 1, settlements: 1 });
    expect(result.sourceAsOf).toBe('2026-09-22');
    expect(result.objects.book[0].value).toMatchObject({ units_on_hand: 100, units_returned: 2 });
  });
});
