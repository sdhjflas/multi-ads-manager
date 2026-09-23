import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { ConnectionRepository } from '../server/connections/repository.js';
import { ConnectionService } from '../server/connections/service.js';
import { ProfitControlService } from '../server/profit-control.js';
import { CredentialVault } from '../server/security/vault.js';
import { Store } from '../server/store.js';

const now = new Date('2026-09-23T14:00:00.000Z');
const vault = () => new CredentialVault(Buffer.alloc(32, 9).toString('base64'));

describe('client profit control', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  it('reconciles mapped ad and business evidence and creates a bounded shadow allocation', async () => {
    const app = createApp(store, { vault: vault(), clock: () => now });
    const service = app.locals.connectionService as ConnectionService;
    const repository = service.repository;
    const client = repository.ensureDefaultClient('workspace');
    const meta = service.create({
      dataset: 'workspace',
      clientId: client.id,
      provider: 'meta-ads',
      name: 'Product ads',
      authMode: 'token',
      credentials: { accessToken: 'meta-profit-control-token' },
    });
    const shopify = service.create({
      dataset: 'workspace',
      clientId: client.id,
      provider: 'shopify',
      name: 'Product receipts',
      authMode: 'token',
      credentials: {
        accessToken: 'shopify-profit-control-token',
        shopDomain: 'example.myshopify.com',
      },
    });
    for (const connection of [meta, shopify])
      repository.saveConnection({
        ...connection,
        health: {
          ...connection.health,
          status: 'healthy',
          lastSuccessAt: now.toISOString(),
          sourceAsOf: now.toISOString(),
        },
      });
    repository.replaceObjects(meta.id, 'campaign', [
      {
        kind: 'campaign',
        externalId: 'campaign-1',
        observedAt: now.toISOString(),
        value: { id: 'campaign-1', name: 'Shift knob sales' },
      },
    ]);
    repository.replaceObjects(meta.id, 'insight', [
      {
        kind: 'insight',
        externalId: 'ad-1:2026-09-22',
        observedAt: now.toISOString(),
        value: {
          campaign_id: 'campaign-1',
          date_stop: '2026-09-22',
          spendCents: 10_000,
          purchaseValueCents: 50_000,
          purchases: 25,
        },
      },
    ]);
    repository.replaceObjects(shopify.id, 'variant', [
      {
        kind: 'variant',
        externalId: 'variant-1',
        observedAt: now.toISOString(),
        value: { id: 'variant-1', sku: 'SHIFT-01', productTitle: 'Shift knob' },
      },
    ]);
    repository.replaceObjects(shopify.id, 'order-line', [
      {
        kind: 'order-line',
        externalId: 'order-1:line-1',
        observedAt: now.toISOString(),
        value: {
          sku: 'SHIFT-01',
          units: 25,
          netReceiptsCents: 40_000,
          refundsCents: 2_000,
          observedAt: now.toISOString(),
        },
      },
    ]);

    const item = await request(app)
      .post('/api/profit-control/items')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        clientId: client.id,
        vertical: 'commerce',
        name: 'Shift knob',
        sku: 'SHIFT-01',
        retailPriceCents: 2500,
        netReceiptCents: 2000,
        variableCostCents: 700,
        profitReserveCents: 300,
        lossLimitCents: 50_000,
        dailyBudgetLimitCents: 5000,
        verified: true,
        note: 'Verified from current cost sheet.',
      })
      .expect(201);
    for (const mapping of [
      { connectionId: meta.id, sourceKind: 'campaign', externalId: 'campaign-1' },
      { connectionId: shopify.id, sourceKind: 'variant', externalId: 'variant-1' },
    ])
      await request(app)
        .post('/api/profit-control/mappings')
        .set('X-Orbit-Request', '1')
        .send({ dataset: 'workspace', clientId: client.id, itemId: item.body.id, ...mapping })
        .expect(201);

    const view = await request(app)
      .get(`/api/profit-control?dataset=workspace&clientId=${client.id}`)
      .expect(200);
    expect(view.body.items[0]).toMatchObject({
      decision: 'scale',
      affordableAcquisitionCents: 1000,
      screeningContributionCents: 22_500,
      evidence: {
        spendCents: 10_000,
        attributedRevenueCents: 50_000,
        attributedPurchases: 25,
        independentReceiptsCents: 40_000,
        independentUnits: 25,
        refundsCents: 2_000,
      },
    });
    expect(view.body.readiness).toMatchObject({ ready: true });
    const testPlan = await request(app)
      .post('/api/profit-control/tests')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id, itemId: item.body.id,
        hypothesis: 'Proof-led hooks should improve qualified purchase response.',
        variable: 'hook', seeds: ['machined fit', 'installation proof'], count: 120,
        lossBudgetCents: 20_000, maxConcurrent: 4, assetEvidenceApproved: true,
      })
      .expect(201);
    expect(testPlan.body.candidates).toHaveLength(120);
    expect(new Set(testPlan.body.candidates.map((candidate: { label: string }) => candidate.label)).size).toBe(120);
    const activated = await request(app)
      .post(`/api/profit-control/tests/${testPlan.body.id}/activate`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: client.id })
      .expect(200);
    expect(activated.body.candidates.filter((candidate: { status: string }) => candidate.status === 'active')).toHaveLength(4);
    expect(activated.body.candidates.filter((candidate: { status: string }) => candidate.status === 'held')).toHaveLength(116);
    expect(activated.body.status).toBe('ready');
    const pool = await request(app)
      .post('/api/profit-control/pools')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        clientId: client.id,
        name: 'Pilot pool',
        vertical: 'all',
        dailyLimitCents: 10_000,
        learningLimitCents: 100_000,
        reservePercent: 20,
      })
      .expect(201);
    const run = await request(app)
      .post('/api/profit-control/optimize')
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: client.id, poolId: pool.body.id })
      .expect(201);
    expect(run.body).toMatchObject({ mode: 'shadow', totalAllocatedCents: 3571 });
    expect(run.body.allocations[0]).toMatchObject({ itemId: item.body.id, decision: 'scale' });
    expect(run.body.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps profit items, mappings, and optimizer runs inside one client membership scope', async () => {
    const app = createApp(store, { vault: vault(), clock: () => now });
    const repository = (app.locals.connectionService as ConnectionService).repository;
    const primary = repository.ensureDefaultClient('workspace');
    const secondary = repository.createClient('workspace', 'Second client', now);
    await request(app)
      .post('/api/profit-control/items')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace',
        clientId: secondary.id,
        vertical: 'books',
        name: 'Second client book',
        isbn: '9780000000002',
        asin: 'B000000002',
        retailPriceCents: 2000,
        netReceiptCents: 800,
        variableCostCents: 300,
        profitReserveCents: 100,
        lossLimitCents: 3000,
        dailyBudgetLimitCents: 500,
        verified: true,
        note: '',
      })
      .expect(201);
    const primaryView = await request(app)
      .get(`/api/profit-control?dataset=workspace&clientId=${primary.id}`)
      .expect(200);
    const secondaryView = await request(app)
      .get(`/api/profit-control?dataset=workspace&clientId=${secondary.id}`)
      .expect(200);
    expect(primaryView.body.items).toHaveLength(0);
    expect(secondaryView.body.items).toHaveLength(1);
    const intruder = new ConnectionRepository(store, vault(), 'outside-operator');
    expect(() =>
      new ProfitControlService(store, intruder, () => now).view('workspace', secondary.id),
    ).toThrow(/No client workspace|not found/);
  });
});

describe('connection job recovery controls', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  it('backs off transient failures, dead-letters exhausted work, and allows an operator retry', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const repository = new ConnectionRepository(store, vault());
    const service = new ConnectionService(store, repository, fetcher, () => now);
    const client = repository.ensureDefaultClient('workspace');
    const connection = service.create({
      dataset: 'workspace',
      clientId: client.id,
      provider: 'meta-ads',
      name: 'Transient Meta',
      authMode: 'token',
      credentials: { accessToken: 'meta-transient-token' },
    });
    const queued = service.queueBackfill('workspace', client.id, connection.id, '2026-08-01');
    await service.processQueuedJobs();
    const backedOff = repository.jobs('workspace', client.id).find((job) => job.id === queued.id)!;
    expect(backedOff).toMatchObject({ status: 'queued', attempt: 1, errorKind: 'unavailable' });
    expect(Date.parse(backedOff.nextAttemptAt!)).toBeGreaterThan(now.getTime());

    repository.saveJob({ ...backedOff, attempt: 4, maxAttempts: 5, nextAttemptAt: now.toISOString() });
    await service.processQueuedJobs();
    const dead = repository.jobs('workspace', client.id).find((job) => job.id === queued.id)!;
    expect(dead).toMatchObject({ status: 'dead-letter', attempt: 5, errorKind: 'unavailable' });
    const retry = service.retryJob('workspace', client.id, dead.id);
    expect(retry).toMatchObject({ status: 'queued', attempt: 0, maxAttempts: 5 });
    expect(retry.id).not.toBe(dead.id);
  });
});
