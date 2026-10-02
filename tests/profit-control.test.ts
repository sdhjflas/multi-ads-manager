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
        timezone: connection.id === meta.id ? 'America/New_York' : connection.timezone,
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
      {
        kind: 'campaign',
        externalId: 'campaign-2',
        observedAt: now.toISOString(),
        value: { id: 'campaign-2', name: 'Shift knob alternate campaign' },
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
      { connectionId: meta.id, sourceKind: 'campaign', externalId: 'campaign-2' },
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
    await request(app)
      .post('/api/profit-control/assets')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id, itemId: item.body.id,
        kind: 'image', name: 'Missing approval record', contentHash: 'c'.repeat(64),
        sourceRef: 'dam://enthusiast/shift-knob/unrecorded',
        rightsApproved: true, claimsApproved: true, evidenceApproved: true, approvalNote: '',
      })
      .expect(400);
    const asset = await request(app)
      .post('/api/profit-control/assets')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id, itemId: item.body.id,
        kind: 'video', name: 'Installation proof', contentHash: 'a'.repeat(64),
        sourceRef: 'dam://enthusiast/shift-knob/install-proof-v1',
        rightsApproved: true, claimsApproved: true, evidenceApproved: true,
        approvalNote: 'Rights, fitment demonstration, and product claims reviewed.',
      })
      .expect(201);
    expect(asset.body).toMatchObject({ status: 'approved', version: 1 });
    const draftAsset = await request(app)
      .post('/api/profit-control/assets')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id, itemId: item.body.id,
        kind: 'copy', name: 'Unreviewed claim', contentHash: 'b'.repeat(64),
        sourceRef: 'draft://claim', rightsApproved: true, claimsApproved: false,
        evidenceApproved: false, approvalNote: 'Awaiting evidence review.',
      })
      .expect(201);
    await request(app)
      .post('/api/profit-control/tests')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id, itemId: item.body.id,
        hypothesis: 'An unreviewed claim should never enter a live test.', variable: 'headline',
        seeds: ['unreviewed'], count: 2, lossBudgetCents: 1000, maxConcurrent: 2,
        assetIds: [draftAsset.body.id],
      })
      .expect(400);
    const testPlan = await request(app)
      .post('/api/profit-control/tests')
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id, itemId: item.body.id,
        hypothesis: 'Proof-led hooks should improve qualified purchase response.',
        variable: 'hook', seeds: ['machined fit', 'installation proof'], count: 120,
        lossBudgetCents: 20_000, maxConcurrent: 4, assetIds: [asset.body.id],
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
    expect(activated.body.waves).toHaveLength(1);
    repository.replaceObjects(meta.id, 'ad', Array.from({ length: 4 }, (_, index) => ({
      kind: 'ad', externalId: `ad-${index + 1}`, observedAt: now.toISOString(),
      value: { id: `ad-${index + 1}`, name: `Proof ad ${index + 1}`, campaign_id: index === 3 ? 'campaign-2' : 'campaign-1', creative: { id: `creative-${index + 1}` } },
    })));
    repository.replaceObjects(meta.id, 'insight', [
      { kind: 'insight', externalId: 'ad-1:2026-09-01', observedAt: now.toISOString(), value: { campaign_id: 'campaign-1', ad_id: 'ad-1', date_stop: '2026-09-01', impressions: 2000, clicks: 100, spendCents: 10_000, purchaseValueCents: 50_000, purchases: 25 } },
      { kind: 'insight', externalId: 'ad-2:2026-09-01', observedAt: now.toISOString(), value: { campaign_id: 'campaign-1', ad_id: 'ad-2', date_stop: '2026-09-01', impressions: 1500, clicks: 60, spendCents: 8_000, purchaseValueCents: 20_000, purchases: 10 } },
      { kind: 'insight', externalId: 'ad-3:2026-09-01', observedAt: now.toISOString(), value: { campaign_id: 'campaign-1', ad_id: 'ad-3', date_stop: '2026-09-01', impressions: 900, clicks: 40, spendCents: 3_000, purchaseValueCents: 0, purchases: 0 } },
      { kind: 'insight', externalId: 'ad-4:2026-09-01', observedAt: now.toISOString(), value: { campaign_id: 'campaign-1', ad_id: 'ad-4', date_stop: '2026-09-01', impressions: 500, clicks: 15, spendCents: 1_500, purchaseValueCents: 2_500, purchases: 1 } },
    ]);
    const sources = await request(app)
      .get(`/api/profit-control/tests/${testPlan.body.id}/sources?dataset=workspace&clientId=${client.id}`)
      .expect(200);
    expect(sources.body).toHaveLength(4);
    const activeCandidates = activated.body.candidates.filter(
      (candidate: { status: string }) => candidate.status === 'active',
    );
    await request(app)
      .post(`/api/profit-control/tests/${testPlan.body.id}/waves/${activated.body.waves[0].id}/setup`)
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id,
        bindings: activeCandidates.map((candidate: { id: string }) => ({
          candidateId: candidate.id, connectionId: meta.id, sourceKind: 'ad', externalId: 'ad-1',
        })),
        startDate: '2026-09-01', endDate: '2026-09-01', attributionDays: 7,
        lossBudgetCents: 20_000,
      })
      .expect(400);
    await request(app)
      .post(`/api/profit-control/tests/${testPlan.body.id}/waves/${activated.body.waves[0].id}/setup`)
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id,
        bindings: activeCandidates.map((candidate: { id: string }, index: number) => ({
          candidateId: candidate.id, connectionId: meta.id, sourceKind: 'ad', externalId: `ad-${index + 1}`,
        })),
        startDate: '2026-09-01', endDate: '2026-09-01', attributionDays: 7,
        lossBudgetCents: 20_000,
      })
      .expect(400);
    repository.replaceObjects(meta.id, 'ad', Array.from({ length: 4 }, (_, index) => ({
      kind: 'ad', externalId: `ad-${index + 1}`, observedAt: now.toISOString(),
      value: { id: `ad-${index + 1}`, name: `Proof ad ${index + 1}`, campaign_id: 'campaign-1', creative: { id: `creative-${index + 1}` } },
    })));
    const setup = await request(app)
      .post(`/api/profit-control/tests/${testPlan.body.id}/waves/${activated.body.waves[0].id}/setup`)
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id,
        bindings: activeCandidates.map((candidate: { id: string }, index: number) => ({
          candidateId: candidate.id, connectionId: meta.id, sourceKind: 'ad', externalId: `ad-${index + 1}`,
        })),
        startDate: '2026-09-01', endDate: '2026-09-01', attributionDays: 7,
        lossBudgetCents: 20_000,
      })
      .expect(200);
    expect(setup.body).toMatchObject({ status: 'running' });
    expect(setup.body.waves[0]).toMatchObject({
      registration: 'historical',
      reportingTimezone: 'America/New_York',
      expectedMatureAt: '2026-09-09T04:00:00.000Z',
      assetVersions: [{ id: asset.body.id, contentHash: 'a'.repeat(64), version: 1 }],
    });
    const frozenEconomics = setup.body.waves[0].economics;
    const revised = await request(app)
      .post(`/api/profit-control/items/${item.body.id}/economics`)
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id,
        retailPriceCents: 2500, netReceiptCents: 1100, variableCostCents: 700,
        profitReserveCents: 300, lossLimitCents: 50_000, dailyBudgetLimitCents: 5000,
        verified: true, note: 'A later cost-sheet revision must not reprice the frozen wave.',
      })
      .expect(200);
    expect(frozenEconomics).toMatchObject({ netReceiptCents: 2000, variableCostCents: 700 });
    expect(revised.body.economics.versionId).not.toBe(frozenEconomics.versionId);
    const refreshedMeta = repository
      .connections('workspace', client.id)
      .find((connection) => connection.id === meta.id)!;
    repository.saveConnection({
      ...refreshedMeta,
      health: { ...refreshedMeta.health, status: 'partial' },
    });
    await request(app)
      .post(`/api/profit-control/tests/${testPlan.body.id}/waves/${activated.body.waves[0].id}/evaluate`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: client.id })
      .expect(409);
    repository.saveConnection({
      ...refreshedMeta,
      health: { ...refreshedMeta.health, status: 'healthy' },
    });
    repository.replaceObjects(meta.id, 'ad', Array.from({ length: 4 }, (_, index) => ({
      kind: 'ad', externalId: `ad-${index + 1}`, observedAt: now.toISOString(),
      value: { id: `ad-${index + 1}`, name: `Proof ad ${index + 1}`, campaign_id: 'campaign-1', creative: { id: index === 0 ? 'changed-creative' : `creative-${index + 1}` } },
    })));
    await request(app)
      .post(`/api/profit-control/tests/${testPlan.body.id}/waves/${activated.body.waves[0].id}/evaluate`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: client.id })
      .expect(409);
    repository.replaceObjects(meta.id, 'ad', Array.from({ length: 4 }, (_, index) => ({
      kind: 'ad', externalId: `ad-${index + 1}`, observedAt: now.toISOString(),
      value: { id: `ad-${index + 1}`, name: `Proof ad ${index + 1}`, campaign_id: 'campaign-1', creative: { id: `creative-${index + 1}` } },
    })));
    const evaluated = await request(app)
      .post(`/api/profit-control/tests/${testPlan.body.id}/waves/${activated.body.waves[0].id}/evaluate`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: client.id })
      .expect(200);
    expect(evaluated.body).toMatchObject({ status: 'decided', recommendation: 'next-wave' });
    expect(evaluated.body.results.filter((result: { verdict: string }) => result.verdict === 'winner')).toHaveLength(1);
    expect(evaluated.body.results[0].screeningContributionCents).toBe(22_500);
    expect(evaluated.body.results[0].sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(evaluated.body.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await request(app)
      .post(`/api/profit-control/items/${item.body.id}/economics`)
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id,
        retailPriceCents: 2500, netReceiptCents: 2000, variableCostCents: 700,
        profitReserveCents: 300, lossLimitCents: 50_000, dailyBudgetLimitCents: 5000,
        verified: true, note: 'Restored current verified economics for allocator coverage.',
      })
      .expect(200);
    const advanced = await request(app)
      .post(`/api/profit-control/tests/${testPlan.body.id}/waves/${activated.body.waves[0].id}/decision`)
      .set('X-Orbit-Request', '1')
      .send({ dataset: 'workspace', clientId: client.id, action: 'next-wave' })
      .expect(200);
    expect(advanced.body.waves).toHaveLength(2);
    expect(advanced.body.waves[1]).toMatchObject({ sequence: 2, status: 'setup' });
    expect(advanced.body.waves[1].candidateIds).toHaveLength(4);
    repository.replaceObjects(meta.id, 'ad', Array.from({ length: 7 }, (_, index) => ({
      kind: 'ad', externalId: `ad-${index + 1}`, observedAt: now.toISOString(),
      value: { id: `ad-${index + 1}`, name: `Proof ad ${index + 1}`, campaign_id: 'campaign-1', creative: { id: `creative-${index + 1}` } },
    })));
    const nextCandidates = advanced.body.candidates.filter(
      (candidate: { id: string; binding: unknown }) =>
        advanced.body.waves[1].candidateIds.includes(candidate.id) && !candidate.binding,
    );
    const prospective = await request(app)
      .post(`/api/profit-control/tests/${testPlan.body.id}/waves/${advanced.body.waves[1].id}/setup`)
      .set('X-Orbit-Request', '1')
      .send({
        dataset: 'workspace', clientId: client.id,
        bindings: nextCandidates.map((candidate: { id: string }, index: number) => ({
          candidateId: candidate.id, connectionId: meta.id, sourceKind: 'ad', externalId: `ad-${index + 5}`,
        })),
        startDate: '2026-09-25', endDate: '2026-10-01', attributionDays: 7,
        lossBudgetCents: 10_000,
      })
      .expect(200);
    expect(prospective.body.waves[1]).toMatchObject({
      status: 'running', registration: 'prospective',
      reportingTimezone: 'America/New_York', expectedMatureAt: '2026-10-09T04:00:00.000Z',
    });
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

  it('measures an Amazon keyword wave against book economics and PBS receipts', async () => {
    const app = createApp(store, { vault: vault(), clock: () => now });
    const service = app.locals.connectionService as ConnectionService;
    const repository = service.repository;
    const client = repository.ensureDefaultClient('workspace');
    const amazon = service.create({
      dataset: 'workspace', clientId: client.id, provider: 'amazon-ads',
      name: 'Book advertiser', authMode: 'token', externalAccountId: 'profile-42',
      credentials: { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token', region: 'NA' },
    });
    const pbs = service.create({
      dataset: 'workspace', clientId: client.id, provider: 'pbs',
      name: 'Publisher receipts', authMode: 'token',
      credentials: { baseUrl: 'https://pbs.example/', accessToken: 'pbs-token', publisherCode: 'HB' },
    });
    for (const connection of [amazon, pbs])
      repository.saveConnection({
        ...connection,
        health: { ...connection.health, status: 'healthy', lastSuccessAt: now.toISOString(), sourceAsOf: now.toISOString() },
      });
    repository.replaceObjects(amazon.id, 'campaign', [{
      kind: 'campaign', externalId: 'book-campaign', observedAt: now.toISOString(),
      value: { externalId: 'book-campaign', name: 'Book exact discovery' },
    }]);
    repository.replaceObjects(amazon.id, 'keyword', [
      { kind: 'keyword', externalId: 'kw-1', observedAt: now.toISOString(), value: { externalId: 'kw-1', campaignExternalId: 'book-campaign', text: 'nature essays', matchType: 'exact' } },
      { kind: 'keyword', externalId: 'kw-2', observedAt: now.toISOString(), value: { externalId: 'kw-2', campaignExternalId: 'book-campaign', text: 'outdoor writing', matchType: 'phrase' } },
    ]);
    repository.replaceObjects(amazon.id, 'keyword-insight', [
      { kind: 'keyword-insight', externalId: 'kw-1:2026-09-01', observedAt: now.toISOString(), value: { date: '2026-09-01', campaignExternalId: 'book-campaign', keywordExternalId: 'kw-1', impressions: 1200, clicks: 40, costCents: 3000, purchases: 10, salesCents: 12_000 } },
      { kind: 'keyword-insight', externalId: 'kw-2:2026-09-01', observedAt: now.toISOString(), value: { date: '2026-09-01', campaignExternalId: 'book-campaign', keywordExternalId: 'kw-2', impressions: 900, clicks: 30, costCents: 1200, purchases: 0, salesCents: 0 } },
    ]);
    repository.replaceObjects(pbs.id, 'book', [{
      kind: 'book', externalId: 'HB001', observedAt: now.toISOString(),
      value: { bk_num: 'HB001', isbn13: '9780000000001', title: 'A Real Book' },
    }]);
    repository.replaceObjects(pbs.id, 'settlement', [{
      kind: 'settlement', externalId: '2026-09', observedAt: now.toISOString(),
      value: { period: { to: '2026-09-01' }, earnings_by_title: [{ bk_num: 'HB001', net_sales: 120, units_sold_through: 15 }] },
    }]);
    const item = await request(app).post('/api/profit-control/items').set('X-Orbit-Request', '1').send({
      dataset: 'workspace', clientId: client.id, vertical: 'books', name: 'A Real Book · paperback',
      isbn: '9780000000001', asin: 'B000BOOK01', retailPriceCents: 1800, netReceiptCents: 800,
      variableCostCents: 300, profitReserveCents: 100, lossLimitCents: 10_000,
      dailyBudgetLimitCents: 1000, verified: true, note: 'Publisher contract verified.',
    }).expect(201);
    for (const mapping of [
      { connectionId: amazon.id, sourceKind: 'campaign', externalId: 'book-campaign' },
      { connectionId: pbs.id, sourceKind: 'book', externalId: 'HB001' },
    ])
      await request(app).post('/api/profit-control/mappings').set('X-Orbit-Request', '1').send({
        dataset: 'workspace', clientId: client.id, itemId: item.body.id, ...mapping,
      }).expect(201);
    const plan = await request(app).post('/api/profit-control/tests').set('X-Orbit-Request', '1').send({
      dataset: 'workspace', clientId: client.id, itemId: item.body.id,
      hypothesis: 'Exact reader-intent keywords should clear the format acquisition hurdle.',
      variable: 'keyword', seeds: ['nature essays', 'outdoor writing'], count: 4,
      lossBudgetCents: 4000, maxConcurrent: 2, assetIds: [],
    }).expect(201);
    const activated = await request(app).post(`/api/profit-control/tests/${plan.body.id}/activate`).set('X-Orbit-Request', '1').send({ dataset: 'workspace', clientId: client.id }).expect(200);
    const active = activated.body.candidates.filter((candidate: { status: string }) => candidate.status === 'active');
    await request(app).post(`/api/profit-control/tests/${plan.body.id}/waves/${activated.body.waves[0].id}/setup`).set('X-Orbit-Request', '1').send({
      dataset: 'workspace', clientId: client.id,
      bindings: active.map((candidate: { id: string }, index: number) => ({ candidateId: candidate.id, connectionId: amazon.id, sourceKind: 'keyword', externalId: `kw-${index + 1}` })),
      startDate: '2026-09-01', endDate: '2026-09-01', attributionDays: 14,
      lossBudgetCents: 3000,
    }).expect(400);
    repository.replaceObjects(amazon.id, 'keyword', [
      { kind: 'keyword', externalId: 'kw-1', observedAt: now.toISOString(), value: { externalId: 'kw-1', campaignExternalId: 'book-campaign', text: 'nature essays', matchType: 'exact' } },
      { kind: 'keyword', externalId: 'kw-2', observedAt: now.toISOString(), value: { externalId: 'kw-2', campaignExternalId: 'book-campaign', text: 'outdoor writing', matchType: 'exact' } },
    ]);
    await request(app).post(`/api/profit-control/tests/${plan.body.id}/waves/${activated.body.waves[0].id}/setup`).set('X-Orbit-Request', '1').send({
      dataset: 'workspace', clientId: client.id,
      bindings: active.map((candidate: { id: string }, index: number) => ({ candidateId: candidate.id, connectionId: amazon.id, sourceKind: 'keyword', externalId: `kw-${index + 1}` })),
      startDate: '2026-09-01', endDate: '2026-09-01', attributionDays: 14,
      lossBudgetCents: 3000,
    }).expect(200);
    const result = await request(app).post(`/api/profit-control/tests/${plan.body.id}/waves/${activated.body.waves[0].id}/evaluate`).set('X-Orbit-Request', '1').send({ dataset: 'workspace', clientId: client.id }).expect(200);
    expect(result.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ verdict: 'winner', costPerPurchaseCents: 300 }),
      expect.objectContaining({ verdict: 'below-hurdle', attributedPurchases: 0 }),
    ]));
    const completed = await request(app).post(`/api/profit-control/tests/${plan.body.id}/waves/${activated.body.waves[0].id}/decision`).set('X-Orbit-Request', '1').send({ dataset: 'workspace', clientId: client.id, action: 'complete' }).expect(200);
    expect(completed.body).toMatchObject({ status: 'completed', outcome: 'winner' });
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
