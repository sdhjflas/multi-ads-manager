import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ConnectionCapability,
  ConnectionCounts,
  ConnectionJob,
  ConnectionsView,
  ConnectionStatus,
  SourceConnection,
  SourceProvider,
} from '../../shared/connections.js';
import { emptyConnectionCounts } from '../../shared/connections.js';
import type { CommerceOrderLine, CommerceStore } from '../../shared/commerce.js';
import type { Dataset } from '../../shared/types.js';
import {
  commerceOrderLines,
  commerceProducts,
  commerceStoreById,
  createCommerceStore,
  importCommerceLedger,
  saveCommerceProducts,
  type CommerceProductInput,
} from '../commerce.js';
import { amazonConfigFromEnv } from '../connectors/amazon.js';
import { ConnectorError } from '../connectors/connector.js';
import { books } from '../books.js';
import type { Store } from '../store.js';
import { AppError } from '../validation.js';
import { AmazonAdsObserver, type AmazonAdsCredential } from './amazon-ads.js';
import { MetaAdsObserver, type MetaCredential } from './meta.js';
import { PbsObserver, type PbsCredential } from './pbs.js';
import type { ProviderObserver, ProviderSyncResult } from './provider.js';
import { ConnectionRepository } from './repository.js';
import { ShopifyObserver, type ShopifyCredential } from './shopify.js';

export type ConnectionCredential =
  | ShopifyCredential
  | MetaCredential
  | AmazonAdsCredential
  | PbsCredential;

export interface CreateConnectionInput {
  dataset: 'workspace';
  clientId: string;
  provider: SourceProvider;
  name: string;
  authMode: 'oauth' | 'token' | 'environment';
  externalAccountId?: string;
  credentials?: ConnectionCredential;
}

const capabilityMap: Record<SourceProvider, Omit<ConnectionCapability, 'state' | 'detail'>[]> = {
  shopify: [
    { key: 'catalog', label: 'Products and variants' },
    { key: 'inventory', label: 'Inventory readiness' },
    { key: 'orders', label: 'Paid orders and refunds' },
    { key: 'reconcile', label: 'SKU profit reconciliation' },
  ],
  'meta-ads': [
    { key: 'accounts', label: 'Ad account discovery' },
    { key: 'entities', label: 'Campaign, ad set, ad, creative' },
    { key: 'insights', label: 'Daily ad Insights' },
    { key: 'reconcile', label: 'Campaign mapping coverage' },
  ],
  'amazon-ads': [
    { key: 'profiles', label: 'Advertiser profiles' },
    { key: 'entities', label: 'Sponsored Products entities' },
    { key: 'reports', label: 'Reporting v3 handoff' },
    { key: 'reconcile', label: 'ASIN and campaign mapping' },
  ],
  pbs: [
    { key: 'catalog', label: 'Books, ISBNs, and formats' },
    { key: 'availability', label: 'Warehouse and vendor stock' },
    { key: 'settlements', label: 'Returns and settlements' },
    { key: 'reconcile', label: 'ISBN to ASIN coverage' },
  ],
};

function capabilities(provider: SourceProvider, ready = false): ConnectionCapability[] {
  return capabilityMap[provider].map((item) => ({
    ...item,
    state: ready ? 'ready' : 'pending',
    detail: ready ? 'Last collection completed.' : 'Complete authorization and run a sync.',
  }));
}

const retryKind = (error: unknown): ConnectionJob['errorKind'] => {
  if (!(error instanceof ConnectorError)) return 'unavailable';
  return ['auth', 'throttled', 'timeout', 'invalid', 'unavailable'].includes(error.kind)
    ? (error.kind as ConnectionJob['errorKind'])
    : 'unavailable';
};

export class ConnectionService {
  constructor(
    readonly store: Store,
    readonly repository: ConnectionRepository,
    readonly fetcher: typeof fetch = fetch,
    readonly clock: () => Date = () => new Date(),
  ) {}

  view(dataset: Dataset, requestedClientId?: string): ConnectionsView {
    const clients = this.repository.clients(dataset);
    const activeClientId = requestedClientId || clients[0].id;
    this.repository.client(dataset, activeClientId);
    const now = this.clock().getTime();
    const connections = this.repository.connections(dataset, activeClientId).map((connection) => {
      const maxAge = connection.provider === 'pbs' ? 48 : 26;
      if (
        connection.health.status === 'healthy' &&
        connection.health.lastSuccessAt &&
        now - Date.parse(connection.health.lastSuccessAt) > maxAge * 3_600_000
      )
        return {
          ...connection,
          health: {
            ...connection.health,
            status: 'stale' as const,
            message: `No successful refresh within ${maxAge} hours.`,
          },
        };
      return connection;
    });
    const successes = connections
      .map((item) => item.health.lastSuccessAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      dataset,
      clients,
      activeClientId,
      connections,
      jobs: this.repository.jobs(dataset, activeClientId),
      events: this.repository.events(dataset, activeClientId),
      security: {
        mode: 'local-operator',
        vaultConfigured: this.repository.vault !== null,
        credentialsReturnedToBrowser: false,
        readOnly: true,
      },
      summary: {
        healthy: connections.filter((item) => item.health.status === 'healthy').length,
        attention: connections.filter((item) =>
          ['partial', 'stale', 'error', 'reauthorize'].includes(item.health.status),
        ).length,
        syncing: connections.filter((item) => item.health.status === 'syncing').length,
        lastSuccessAt: successes.at(-1) || null,
      },
    };
  }

  create(input: CreateConnectionInput): SourceConnection {
    this.repository.client(input.dataset, input.clientId);
    if (this.repository.connections(input.dataset, input.clientId).length >= 40)
      throw new AppError('A client workspace supports up to 40 source connections.');
    if (input.authMode === 'environment' && input.provider !== 'amazon-ads')
      throw new AppError('Environment credentials are supported only for Amazon Ads.');
    if (input.provider === 'pbs' && input.authMode !== 'token')
      throw new AppError('PBS HQ requires a scoped server-token connection.');
    if (input.authMode === 'token' && !input.credentials)
      throw new AppError('Token connections require server-side credentials.');
    if (input.authMode !== 'token' && input.credentials)
      throw new AppError('Credentials may be supplied only for a server-token connection.');
    if (input.authMode === 'environment' && !amazonConfigFromEnv(input.externalAccountId || ''))
      throw new AppError('Amazon Ads environment credentials are not configured.', 503);
    const duplicate = this.repository
      .connections(input.dataset, input.clientId)
      .find(
        (item) =>
          item.provider === input.provider &&
          input.externalAccountId &&
          item.externalAccountId === input.externalAccountId,
      );
    if (duplicate) throw new AppError('That external account is already connected.', 409);
    const now = this.clock().toISOString();
    const connection: SourceConnection = {
      id: randomUUID(),
      dataset: input.dataset,
      clientId: input.clientId,
      provider: input.provider,
      name: input.name.trim(),
      authMode: input.authMode,
      externalAccountId: input.externalAccountId?.trim() || null,
      externalAccountName: null,
      region: null,
      currency: null,
      timezone: null,
      scopes: [],
      readOnly: true,
      secretConfigured: input.authMode === 'environment',
      capabilities: capabilities(input.provider),
      health: {
        status: input.authMode === 'oauth' ? 'setup' : 'connected',
        message:
          input.authMode === 'oauth'
            ? 'Authorization has not started.'
            : 'Authorized. Run the first read-only sync.',
        lastAttemptAt: null,
        lastSuccessAt: null,
        watermark: null,
        sourceAsOf: null,
        nextSyncAt: null,
        counts: emptyConnectionCounts(),
      },
      resourceId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.repository.saveConnection(connection);
      if (input.credentials) {
        this.validateCredential(input.provider, input.credentials);
        this.repository.saveSecret(connection, input.credentials, this.clock());
        connection.secretConfigured = true;
        this.repository.saveConnection(connection);
      }
      this.repository.event(
        connection,
        connection.dataset,
        connection.clientId,
        'connection.created',
        `${connection.name} created in read-only mode.`,
        this.clock(),
      );
    });
    return connection;
  }

  createClient(name: string) {
    const now = this.clock();
    return this.store.transaction(() => {
      const client = this.repository.createClient('workspace', name, now);
      this.repository.event(
        null,
        'workspace',
        client.id,
        'client.created',
        `${client.name} client workspace created.`,
        now,
      );
      return client;
    });
  }

  private validateCredential(provider: SourceProvider, credential: ConnectionCredential) {
    const required: Record<SourceProvider, string[]> = {
      shopify: ['accessToken', 'shopDomain'],
      'meta-ads': ['accessToken'],
      'amazon-ads': ['clientId', 'clientSecret', 'refreshToken', 'region'],
      pbs: ['baseUrl', 'accessToken', 'publisherCode'],
    };
    for (const key of required[provider])
      if (!(key in credential) || typeof (credential as Record<string, unknown>)[key] !== 'string' || !(credential as Record<string, string>)[key].trim())
        throw new AppError(`${provider} credential field ${key} is required.`);
  }

  private observer(connection: SourceConnection): ProviderObserver {
    if (connection.provider === 'amazon-ads' && connection.authMode === 'environment') {
      const config = amazonConfigFromEnv(connection.externalAccountId || '');
      if (!config) throw new AppError('Amazon Ads environment credentials are unavailable.', 503);
      return new AmazonAdsObserver(config, this.fetcher);
    }
    if (connection.provider === 'shopify')
      return new ShopifyObserver(this.repository.secret<ShopifyCredential>(connection), this.fetcher);
    if (connection.provider === 'meta-ads')
      return new MetaAdsObserver(this.repository.secret<MetaCredential>(connection), this.fetcher);
    if (connection.provider === 'amazon-ads')
      return new AmazonAdsObserver(
        this.repository.secret<AmazonAdsCredential>(connection),
        this.fetcher,
      );
    return new PbsObserver(this.repository.secret<PbsCredential>(connection), this.fetcher);
  }

  async sync(dataset: Dataset, clientId: string, connectionId: string) {
    let connection = this.repository.connection(dataset, clientId, connectionId);
    if (dataset !== 'workspace') throw new AppError('Live source sync is disabled in the demo.');
    if (connection.health.status === 'syncing')
      throw new AppError('This connection already has a sync in progress.', 409);
    const started = this.clock();
    const job: ConnectionJob = {
      id: randomUUID(),
      dataset,
      clientId,
      connectionId,
      provider: connection.provider,
      kind: 'full-sync',
      status: 'running',
      attempt: 1,
      startedAt: started.toISOString(),
      finishedAt: null,
      cursor: connection.health.watermark,
      counts: {},
      message: 'Collecting read-only source facts.',
      errorKind: null,
    };
    connection = {
      ...connection,
      health: {
        ...connection.health,
        status: 'syncing',
        message: 'Read-only synchronization is running.',
        lastAttemptAt: started.toISOString(),
      },
      updatedAt: started.toISOString(),
    };
    this.store.transaction(() => {
      this.repository.saveJob(job);
      this.repository.saveConnection(connection);
    });
    try {
      const result = await this.observer(connection).collect(
        connection,
        connection.health.watermark,
      );
      const identityOwner = this.repository
        .connections(dataset, clientId)
        .find(
          (candidate) =>
            candidate.id !== connection.id &&
            candidate.provider === connection.provider &&
            candidate.externalAccountId === result.identity.externalAccountId,
        );
      if (identityOwner)
        throw new AppError(
          `${result.identity.externalAccountName} is already connected as ${identityOwner.name}.`,
          409,
        );
      const finished = this.clock();
      const projected = this.store.transaction(() => {
        for (const [kind, items] of Object.entries(result.objects)) {
          const incremental =
            (connection.provider === 'shopify' && kind === 'order-line') ||
            (connection.provider === 'meta-ads' && kind === 'insight') ||
            (connection.provider === 'pbs' && kind === 'settlement');
          this.repository.replaceObjects(connection.id, kind, items, finished, !incremental);
        }
        return this.project(connection, result, finished);
      });
      const counts: ConnectionCounts = {
        ...emptyConnectionCounts(),
        ...result.counts,
        unmapped: Math.max(result.counts.unmapped || 0, projected.unmapped),
      };
      const partial = counts.unmapped > 0;
      const status: ConnectionStatus = partial ? 'partial' : 'healthy';
      const next = new Date(finished.getTime() + 24 * 3_600_000).toISOString();
      const sourceCapabilities = capabilities(connection.provider, true).map((capability) =>
        capability.key === 'reconcile' && partial
          ? {
              ...capability,
              state: 'blocked' as const,
              detail: `${counts.unmapped} source identities need mapping.`,
            }
          : capability,
      );
      const brainProfileLinked =
        connection.provider !== 'amazon-ads' ||
        (connection.clientId === `${connection.dataset}-default-client` &&
          this.store
            .accounts(connection.dataset)
            .some(
              (account) =>
                account.connector === 'amazon-ads' &&
                account.profileId === result.identity.externalAccountId,
            ));
      connection = {
        ...connection,
        externalAccountId: result.identity.externalAccountId,
        externalAccountName: result.identity.externalAccountName,
        currency: result.identity.currency,
        timezone: result.identity.timezone,
        region: result.identity.region,
        scopes: result.identity.scopes || connection.scopes,
        secretConfigured:
          connection.authMode === 'environment' || this.repository.secretExists(connection.id),
        capabilities: sourceCapabilities.map((capability) =>
          capability.key === 'reports' && !brainProfileLinked
            ? {
                ...capability,
                state: 'pending' as const,
                detail: 'Link this verified profile in The brain to start Reporting v3 jobs.',
              }
            : capability,
        ),
        health: {
          status,
          message: partial
            ? `Source collection completed; ${counts.unmapped} identities still need mapping.`
            : result.warnings[0] || 'Source collection and reconciliation completed.',
          lastAttemptAt: started.toISOString(),
          lastSuccessAt: finished.toISOString(),
          watermark: result.watermark,
          sourceAsOf: result.sourceAsOf,
          nextSyncAt: next,
          counts,
        },
        resourceId: projected.resourceId || connection.resourceId,
        updatedAt: finished.toISOString(),
      };
      job.status = partial ? 'partial' : 'succeeded';
      job.finishedAt = finished.toISOString();
      job.counts = counts;
      job.message = connection.health.message;
      this.store.transaction(() => {
        this.repository.saveConnection(connection);
        this.repository.saveJob(job);
        this.repository.event(
          connection,
          dataset,
          clientId,
          'connection.sync.completed',
          `${connection.name}: ${job.message}`,
          finished,
        );
      });
      return { connection, job };
    } catch (error) {
      const finished = this.clock();
      const kind = retryKind(error);
      const message = error instanceof Error ? error.message : 'Source synchronization failed.';
      connection = {
        ...connection,
        health: {
          ...connection.health,
          status: kind === 'auth' ? 'reauthorize' : 'error',
          message,
          lastAttemptAt: started.toISOString(),
        },
        updatedAt: finished.toISOString(),
      };
      job.status = 'failed';
      job.finishedAt = finished.toISOString();
      job.message = message;
      job.errorKind = kind;
      this.store.transaction(() => {
        this.repository.saveConnection(connection);
        this.repository.saveJob(job);
        this.repository.event(
          connection,
          dataset,
          clientId,
          'connection.sync.failed',
          `${connection.name}: ${message}`,
          finished,
        );
      });
      throw error;
    }
  }

  private project(
    connection: SourceConnection,
    result: ProviderSyncResult,
    now: Date,
  ): { resourceId: string | null; unmapped: number } {
    // Legacy portfolio tables are dataset-scoped. Only the bootstrap workspace may
    // project into them until their schemas carry client_id end to end.
    if (connection.clientId !== `${connection.dataset}-default-client`)
      return {
        resourceId: null,
        unmapped: Object.values(result.objects).reduce((total, rows) => total + rows.length, 0),
      };
    if (connection.provider === 'shopify') return this.projectShopify(connection, result, now);
    if (connection.provider === 'pbs') return this.projectPbs(connection, result, now);
    if (connection.provider === 'meta-ads') {
      const linked = new Set(
        (
          this.store.db
            .prepare(
              `SELECT b.external_id,s.body FROM report_bindings b
               JOIN report_sources s ON s.id=b.source_id WHERE s.dataset=?`,
            )
            .all(connection.dataset) as { external_id: string; body: string }[]
        )
          .filter((row) => JSON.parse(row.body).provider === 'meta')
          .map((row) => row.external_id),
      );
      const campaigns = (result.objects.campaign || []).map((item) => item.externalId);
      return { resourceId: null, unmapped: campaigns.filter((id) => !linked.has(id)).length };
    }
    const accountIds = new Set(this.store.accounts(connection.dataset).map((account) => account.id));
    const linked = new Set(
      this.store
        .links()
        .filter((link) => accountIds.has(link.accountId))
        .map((link) => link.externalCampaignId),
    );
    const campaigns = (result.objects.campaign || []).map((item) => item.externalId);
    return { resourceId: null, unmapped: campaigns.filter((id) => !linked.has(id)).length };
  }

  private projectShopify(
    connection: SourceConnection,
    result: ProviderSyncResult,
    now: Date,
  ) {
    let commerceStore: CommerceStore;
    if (connection.resourceId) {
      commerceStore = commerceStoreById(this.store, connection.dataset, connection.resourceId);
    } else {
      commerceStore = createCommerceStore(
        this.store,
        connection.dataset,
        {
          name: result.identity.externalAccountName,
          provider: 'manual',
          timezone: result.identity.timezone || 'UTC',
          maxDataAgeHours: 72,
        },
        now,
      );
      commerceStore = {
        ...commerceStore,
        provider: 'shopify',
        shopDomain: (this.repository.secret<ShopifyCredential>(connection)).shopDomain,
        updatedAt: now.toISOString(),
      };
      this.store.db
        .prepare('UPDATE commerce_stores SET body=? WHERE id=?')
        .run(JSON.stringify(commerceStore), commerceStore.id);
    }
    const prior = new Map(
      commerceProducts(this.store, connection.dataset)
        .filter((item) => item.storeId === commerceStore.id)
        .map((item) => [item.sku, item]),
    );
    const seenSkus = new Set<string>();
    const inputs: CommerceProductInput[] = [];
    let unmapped = 0;
    for (const object of result.objects.variant || []) {
      const variant = object.value as {
        id: string;
        productId: string;
        productTitle: string;
        variantTitle: string;
        sku: string | null;
        priceCents: number;
        inventoryQuantity: number | null;
        updatedAt: string;
      };
      if (!variant.sku || seenSkus.has(variant.sku)) {
        unmapped++;
        continue;
      }
      seenSkus.add(variant.sku);
      const old = prior.get(variant.sku);
      const defaults: CommerceProductInput = {
        productRef: variant.productId,
        sku: variant.sku,
        name: variant.productTitle,
        variantName: variant.variantTitle,
        externalVariantId: variant.id,
        inventoryMode: 'stocked',
        retailPriceCents: variant.priceCents,
        plannedNetReceiptCents: null,
        unitCostCents: null,
        inboundFreightCents: null,
        dutiesAndFeesCents: null,
        packagingCostCents: null,
        paymentFeeAllowanceCents: null,
        outboundFulfillmentCents: null,
        returnAllowanceCents: null,
        warrantyAllowanceCents: null,
        supportAllowanceCents: null,
        profitReserveCents: null,
        lossLimitCents: null,
        dailyBudgetLimitCents: null,
        economicsVerified: false,
        commercialRightsApproved: false,
        productEvidenceApproved: false,
        claimsApproved: false,
        trackingVerified: false,
        fulfillmentReady: false,
        releaseApproved: false,
        routeVerified: false,
        preorderTermsApproved: false,
        availableUnits: variant.inventoryQuantity,
        committedUnits: null,
        quarantinedUnits: null,
        supplierCapacityUnits: null,
        preorderCapacityUnits: null,
        safetyStockUnits: null,
        reorderPointUnits: null,
        inventoryVerifiedAt: variant.updatedAt,
        inventoryMaxAgeHours: 168,
      };
      inputs.push(
        old
          ? {
              ...old,
              productRef: old.productRef,
              externalVariantId: old.externalVariantId || variant.id,
              name: variant.productTitle,
              variantName: variant.variantTitle,
              retailPriceCents: variant.priceCents,
              availableUnits: variant.inventoryQuantity,
              inventoryVerifiedAt: variant.updatedAt,
            }
          : defaults,
      );
    }
    if (inputs.length) saveCommerceProducts(this.store, commerceStore, inputs, now);
    const catalog = new Set([...prior.keys(), ...inputs.map((item) => item.sku)]);
    const existingLines = new Map(
      commerceOrderLines(this.store, commerceStore.id).map((line) => [
        `${line.orderRef}\u0000${line.lineRef}`,
        line,
      ]),
    );
    const changed: CommerceOrderLine[] = [];
    for (const object of result.objects['order-line'] || []) {
      const value = object.value as Omit<CommerceOrderLine, 'storeId'>;
      if (!value.sku || !catalog.has(value.sku)) {
        unmapped++;
        continue;
      }
      const next = { ...value, storeId: commerceStore.id };
      const old = existingLines.get(`${next.orderRef}\u0000${next.lineRef}`);
      if (!old || JSON.stringify(old) !== JSON.stringify(next)) changed.push(next);
    }
    if (changed.length)
      importCommerceLedger(
        this.store,
        commerceStore,
        changed,
        `Shopify API ${now.toISOString()}`,
        now,
      );
    return { resourceId: commerceStore.id, unmapped };
  }

  private projectPbs(connection: SourceConnection, result: ProviderSyncResult, now: Date) {
    const catalog = books(this.store, connection.dataset);
    const byIsbn = new Map<string, typeof catalog>();
    for (const book of catalog) {
      if (!book.isbn) continue;
      const isbn = book.isbn.replace(/[^0-9X]/gi, '').toUpperCase();
      byIsbn.set(isbn, [...(byIsbn.get(isbn) || []), book]);
    }
    let unmapped = 0;
    const put = this.store.db.prepare('UPDATE book_catalog SET body=? WHERE id=?');
    for (const object of result.objects.book || []) {
      const source = object.value as {
        isbn: string;
        isbn13?: string;
        ebook_ind: boolean;
        units_on_hand: number;
        units_consigned_out: number;
        amazon_at_vendor: number;
        ingram_at_vendor: number;
      };
      const isbn = (source.isbn13 || source.isbn).replace(/[^0-9X]/gi, '').toUpperCase();
      const locals = byIsbn.get(isbn);
      if (!locals?.length) {
        unmapped++;
        continue;
      }
      for (const local of locals) {
        const next = {
          ...local,
          supplyReady:
            source.ebook_ind ||
            source.units_on_hand +
              source.units_consigned_out +
              source.amazon_at_vendor +
              source.ingram_at_vendor >
              0,
          supplySource: 'pbs' as const,
          supplyVerifiedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        put.run(JSON.stringify(next), local.id);
      }
    }
    return { resourceId: null, unmapped };
  }

  revoke(dataset: Dataset, clientId: string, connectionId: string) {
    const connection = this.repository.connection(dataset, clientId, connectionId);
    const now = this.clock().toISOString();
    const next: SourceConnection = {
      ...connection,
      secretConfigured: false,
      capabilities: capabilities(connection.provider),
      health: {
        ...connection.health,
        status: 'reauthorize',
        message: 'Local credentials were removed. Reauthorize before syncing.',
        nextSyncAt: null,
      },
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.repository.clearSecret(connection);
      this.repository.saveConnection(next);
      this.repository.event(
        next,
        dataset,
        clientId,
        'connection.credentials.revoked',
        `${next.name}: encrypted credentials removed locally.`,
        this.clock(),
      );
    });
    return next;
  }

  recoverInterruptedJobs() {
    const now = this.clock();
    for (const job of this.repository.unfinishedJobs()) {
      if (job.status === 'queued') continue;
      const connection = this.repository.connectionById(job.connectionId);
      job.status = 'failed';
      job.finishedAt = now.toISOString();
      job.errorKind = 'unavailable';
      job.message = 'The server stopped before this read-only sync completed. It is safe to retry.';
      const next: SourceConnection = {
        ...connection,
        health: { ...connection.health, status: 'error', message: job.message },
        updatedAt: now.toISOString(),
      };
      this.store.transaction(() => {
        this.repository.saveJob(job);
        this.repository.saveConnection(next);
      });
    }
  }

  async processQueuedJobs(limit = 10) {
    const jobs = this.repository.queuedJobs(limit);
    for (const trigger of jobs) {
      trigger.status = 'running';
      trigger.attempt += 1;
      trigger.message = 'Processing the durable refresh trigger.';
      this.repository.saveJob(trigger);
      try {
        await this.sync(trigger.dataset, trigger.clientId, trigger.connectionId);
        trigger.status = 'succeeded';
        trigger.finishedAt = this.clock().toISOString();
        trigger.message = 'Verified trigger completed through a read-only source refresh.';
      } catch (error) {
        trigger.status = 'failed';
        trigger.finishedAt = this.clock().toISOString();
        trigger.errorKind = retryKind(error);
        trigger.message = error instanceof Error ? error.message : 'Queued refresh failed.';
      }
      this.repository.saveJob(trigger);
    }
    return jobs.length;
  }

  async syncDueConnections(limit = 5) {
    const due = this.repository
      .allConnections()
      .filter(
        (connection) =>
          connection.dataset === 'workspace' &&
          connection.secretConfigured &&
          ['healthy', 'partial', 'stale'].includes(connection.health.status) &&
          connection.health.nextSyncAt !== null &&
          Date.parse(connection.health.nextSyncAt) <= this.clock().getTime(),
      )
      .slice(0, limit);
    let succeeded = 0;
    for (const connection of due)
      try {
        await this.sync(connection.dataset, connection.clientId, connection.id);
        succeeded++;
      } catch {
        // sync() records the classified failure and audit event; one source never stops the rest.
      }
    return { attempted: due.length, succeeded };
  }
}

export const oauthState = () => randomBytes(32).toString('base64url');
