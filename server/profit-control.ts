import { createHash, randomUUID } from 'node:crypto';
import type {
  MappingCandidate,
  OptimizerRun,
  ProfitBudgetPool,
  ProfitControlView,
  ProfitEconomics,
  ProfitItem,
  ProfitItemView,
  ProfitMapping,
  ProfitTestCandidate,
  ProfitTestPlan,
  ProfitVertical,
} from '../shared/control.js';
import type { Dataset } from '../shared/types.js';
import type { SourceConnection, SourceProvider } from '../shared/connections.js';
import type { Store } from './store.js';
import { AppError } from './validation.js';
import { ConnectionRepository, type SourceObject } from './connections/repository.js';

interface ItemInput {
  dataset: 'workspace';
  clientId: string;
  vertical: ProfitVertical;
  name: string;
  sku?: string;
  isbn?: string;
  asin?: string;
  retailPriceCents: number;
  netReceiptCents: number;
  variableCostCents: number;
  profitReserveCents: number;
  lossLimitCents: number;
  dailyBudgetLimitCents: number;
  verified: boolean;
  note?: string;
}

interface MappingInput {
  dataset: 'workspace';
  clientId: string;
  connectionId: string;
  sourceKind: string;
  externalId: string;
  itemId: string;
}

interface PoolInput {
  dataset: 'workspace';
  clientId: string;
  name: string;
  vertical: ProfitVertical | 'all';
  dailyLimitCents: number;
  learningLimitCents: number;
  reservePercent: number;
}

interface TestInput {
  dataset: 'workspace';
  clientId: string;
  itemId: string;
  hypothesis: string;
  variable: ProfitTestCandidate['kind'];
  seeds: string[];
  count: number;
  lossBudgetCents: number;
  maxConcurrent: number;
  assetEvidenceApproved: boolean;
}

const normalized = (value: string) => value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const cents = (value: unknown) => {
  const number = typeof value === 'number' ? value : Number(value || 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
};
const dollarsToCents = (value: unknown) => {
  const number = typeof value === 'number' ? value : Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
};
const sourceName = (kind: string, value: Record<string, unknown>, fallback: string) =>
  String(
    value.name ||
      value.productTitle ||
      value.title ||
      value.orderName ||
      (kind === 'book' ? value.bk_num : '') ||
      fallback,
  );

export class ProfitControlService {
  constructor(
    readonly store: Store,
    readonly repository: ConnectionRepository,
    readonly clock: () => Date = () => new Date(),
  ) {}

  private itemRows(dataset: Dataset, clientId: string): ProfitItem[] {
    this.repository.client(dataset, clientId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM profit_items WHERE dataset=? AND client_id=? ORDER BY updated_at DESC,id',
        )
        .all(dataset, clientId) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  private item(dataset: Dataset, clientId: string, id: string): ProfitItem {
    const row = this.store.db
      .prepare('SELECT body FROM profit_items WHERE id=? AND dataset=? AND client_id=?')
      .get(id, dataset, clientId) as { body: string } | undefined;
    if (!row) throw new AppError('Profit item not found in this client workspace.', 404);
    return JSON.parse(row.body);
  }

  private mappings(dataset: Dataset, clientId: string): ProfitMapping[] {
    this.repository.client(dataset, clientId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM profit_mappings WHERE dataset=? AND client_id=? ORDER BY created_at,id',
        )
        .all(dataset, clientId) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  private pools(dataset: Dataset, clientId: string): ProfitBudgetPool[] {
    this.repository.client(dataset, clientId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM profit_budget_pools WHERE dataset=? AND client_id=? ORDER BY updated_at DESC,id',
        )
        .all(dataset, clientId) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  private runs(dataset: Dataset, clientId: string): OptimizerRun[] {
    this.repository.client(dataset, clientId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM profit_optimizer_runs WHERE dataset=? AND client_id=? ORDER BY created_at DESC LIMIT 25',
        )
        .all(dataset, clientId) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  private tests(dataset: Dataset, clientId: string): ProfitTestPlan[] {
    this.repository.client(dataset, clientId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM profit_test_plans WHERE dataset=? AND client_id=? ORDER BY updated_at DESC,id',
        )
        .all(dataset, clientId) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  createItem(input: ItemInput): ProfitItem {
    this.repository.client(input.dataset, input.clientId);
    if (this.itemRows(input.dataset, input.clientId).length >= 25_000)
      throw new AppError('A client workspace supports up to 25,000 profit items.');
    const sku = input.sku?.trim() || null;
    const isbn = input.isbn ? normalized(input.isbn) : null;
    const asin = input.asin ? normalized(input.asin) : null;
    if (input.vertical === 'commerce' && !sku)
      throw new AppError('Commerce items require an exact SKU.');
    if (input.vertical === 'books' && !isbn && !asin)
      throw new AppError('Book items require an ISBN or ASIN.');
    if (input.verified && input.netReceiptCents <= input.variableCostCents + input.profitReserveCents)
      throw new AppError('Verified economics must leave positive room for advertising.');
    const identityKey = input.vertical === 'commerce' ? sku! : `${isbn || ''}:${asin || ''}`;
    const now = this.clock().toISOString();
    const economics: ProfitEconomics = {
      versionId: randomUUID(),
      effectiveAt: now,
      retailPriceCents: input.retailPriceCents,
      netReceiptCents: input.netReceiptCents,
      variableCostCents: input.variableCostCents,
      profitReserveCents: input.profitReserveCents,
      lossLimitCents: input.lossLimitCents,
      dailyBudgetLimitCents: input.dailyBudgetLimitCents,
      verified: input.verified,
      note: input.note?.trim() || '',
    };
    const item: ProfitItem = {
      id: randomUUID(),
      dataset: input.dataset,
      clientId: input.clientId,
      vertical: input.vertical,
      identityKey,
      name: input.name.trim(),
      sku,
      isbn,
      asin,
      active: true,
      economics,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.store.transaction(() => {
        this.store.db
          .prepare(
            `INSERT INTO profit_items(id,dataset,client_id,vertical,identity_key,updated_at,body)
             VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            item.id,
            item.dataset,
            item.clientId,
            item.vertical,
            item.identityKey,
            item.updatedAt,
            JSON.stringify(item),
          );
        this.store.db
          .prepare(
            'INSERT INTO profit_economics_versions(id,item_id,client_id,effective_at,body) VALUES(?,?,?,?,?)',
          )
          .run(economics.versionId, item.id, item.clientId, now, JSON.stringify(economics));
        this.repository.event(
          null,
          item.dataset,
          item.clientId,
          'profit.item.created',
          `${item.name}: economics version created for ${item.identityKey}.`,
          this.clock(),
        );
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint/.test(error.message))
        throw new AppError('That SKU or book identity already exists in this client.', 409);
      throw error;
    }
    return item;
  }

  reviseEconomics(
    dataset: 'workspace',
    clientId: string,
    itemId: string,
    economics: Omit<ProfitEconomics, 'versionId' | 'effectiveAt'>,
  ) {
    const old = this.item(dataset, clientId, itemId);
    if (economics.verified && economics.netReceiptCents <= economics.variableCostCents + economics.profitReserveCents)
      throw new AppError('Verified economics must leave positive room for advertising.');
    const now = this.clock().toISOString();
    const version: ProfitEconomics = { ...economics, versionId: randomUUID(), effectiveAt: now };
    const item = { ...old, economics: version, updatedAt: now };
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE profit_items SET updated_at=?,body=? WHERE id=? AND client_id=?')
        .run(now, JSON.stringify(item), item.id, clientId);
      this.store.db
        .prepare(
          'INSERT INTO profit_economics_versions(id,item_id,client_id,effective_at,body) VALUES(?,?,?,?,?)',
        )
        .run(version.versionId, item.id, clientId, now, JSON.stringify(version));
      this.repository.event(
        null,
        dataset,
        clientId,
        'profit.economics.revised',
        `${item.name}: a new immutable economics version was recorded.`,
        this.clock(),
      );
    });
    return item;
  }

  private sourceObject(connectionId: string, kind: string, externalId: string): SourceObject {
    const row = this.store.db
      .prepare(
        'SELECT observed_at,body FROM connection_objects WHERE connection_id=? AND kind=? AND external_id=?',
      )
      .get(connectionId, kind, externalId) as { observed_at: string; body: string } | undefined;
    if (!row) throw new AppError('The selected source identity no longer exists.', 409);
    return { kind, externalId, observedAt: row.observed_at, value: JSON.parse(row.body) };
  }

  map(input: MappingInput): ProfitMapping {
    const item = this.item(input.dataset, input.clientId, input.itemId);
    const connection = this.repository.connection(input.dataset, input.clientId, input.connectionId);
    const object = this.sourceObject(connection.id, input.sourceKind, input.externalId);
    const value = object.value as Record<string, unknown>;
    const mapping: ProfitMapping = {
      id: randomUUID(),
      dataset: input.dataset,
      clientId: input.clientId,
      connectionId: connection.id,
      provider: connection.provider,
      sourceKind: input.sourceKind,
      externalId: input.externalId,
      sourceName: sourceName(input.sourceKind, value, input.externalId),
      itemId: item.id,
      createdAt: this.clock().toISOString(),
    };
    try {
      this.store.transaction(() => {
        this.store.db
          .prepare(
            `INSERT INTO profit_mappings
             (id,dataset,client_id,connection_id,source_kind,external_id,item_id,created_at,body)
             VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            mapping.id,
            mapping.dataset,
            mapping.clientId,
            mapping.connectionId,
            mapping.sourceKind,
            mapping.externalId,
            mapping.itemId,
            mapping.createdAt,
            JSON.stringify(mapping),
          );
        this.repository.event(
          connection,
          input.dataset,
          input.clientId,
          'profit.mapping.created',
          `${mapping.sourceName} mapped to ${item.name}.`,
          this.clock(),
        );
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint/.test(error.message))
        throw new AppError('That source identity is already mapped.', 409);
      throw error;
    }
    return mapping;
  }

  removeMapping(dataset: 'workspace', clientId: string, mappingId: string) {
    this.repository.client(dataset, clientId);
    const row = this.store.db
      .prepare('SELECT body FROM profit_mappings WHERE id=? AND dataset=? AND client_id=?')
      .get(mappingId, dataset, clientId) as { body: string } | undefined;
    if (!row) throw new AppError('Profit mapping not found in this client workspace.', 404);
    const mapping = JSON.parse(row.body) as ProfitMapping;
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM profit_mappings WHERE id=? AND client_id=?').run(mappingId, clientId);
      this.repository.event(
        null,
        dataset,
        clientId,
        'profit.mapping.removed',
        `${mapping.sourceName}: source mapping removed.`,
        this.clock(),
      );
    });
    return { removed: true };
  }

  savePool(input: PoolInput): ProfitBudgetPool {
    this.repository.client(input.dataset, input.clientId);
    const existing = this.pools(input.dataset, input.clientId)[0];
    const now = this.clock().toISOString();
    const pool: ProfitBudgetPool = {
      id: existing?.id || randomUUID(),
      dataset: input.dataset,
      clientId: input.clientId,
      name: input.name.trim(),
      vertical: input.vertical,
      dailyLimitCents: input.dailyLimitCents,
      learningLimitCents: input.learningLimitCents,
      reservePercent: input.reservePercent,
      active: true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.store.db
      .prepare(
        `INSERT INTO profit_budget_pools(id,dataset,client_id,updated_at,body) VALUES(?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,body=excluded.body`,
      )
      .run(pool.id, pool.dataset, pool.clientId, pool.updatedAt, JSON.stringify(pool));
    return pool;
  }

  createTest(input: TestInput): ProfitTestPlan {
    const item = this.item(input.dataset, input.clientId, input.itemId);
    if (!item.economics.verified)
      throw new AppError('Verify this item’s economics before reserving a test budget.');
    const bookKinds = ['keyword', 'product-target'];
    const commerceKinds = ['hook', 'headline', 'audience', 'landing-page'];
    if (
      (item.vertical === 'books' && !bookKinds.includes(input.variable)) ||
      (item.vertical === 'commerce' && !commerceKinds.includes(input.variable))
    )
      throw new AppError('The selected test variable does not match this item type.');
    if (item.vertical === 'commerce' && !input.assetEvidenceApproved)
      throw new AppError('Product tests require approved claims, rights, and source asset evidence.');
    if (input.lossBudgetCents > item.economics.lossLimitCents)
      throw new AppError('The test loss budget cannot exceed the item loss allowance.');
    const seeds = [...new Set(input.seeds.map((seed) => seed.trim()).filter(Boolean))];
    if (!seeds.length) throw new AppError('Provide at least one verified seed.');
    const variants: { label: string; provenance: string }[] = [];
    const frames =
      item.vertical === 'books'
        ? input.variable === 'keyword'
          ? ['exact', 'phrase', 'broad']
          : ['direct ASIN']
        : input.variable === 'hook'
          ? ['problem', 'proof', 'outcome', 'contrast', 'demonstration']
          : input.variable === 'headline'
            ? ['benefit', 'specificity', 'proof', 'objection']
            : input.variable === 'audience'
              ? ['intent', 'interest', 'lookalike']
              : ['control', 'benefit-first', 'proof-first'];
    for (let cycle = 0; variants.length < input.count; cycle++) {
      const seed = seeds[cycle % seeds.length];
      const frame = frames[Math.floor(cycle / seeds.length) % frames.length];
      const suffix = Math.floor(cycle / (seeds.length * frames.length));
      const label = `${seed} · ${frame}${suffix ? ` · ${suffix + 1}` : ''}`;
      if (!variants.some((candidate) => candidate.label.toLowerCase() === label.toLowerCase()))
        variants.push({ label, provenance: `Operator seed “${seed}”; ${frame} frame.` });
    }
    const candidates: ProfitTestCandidate[] = variants.map((candidate) => ({
      id: randomUUID(),
      label: candidate.label,
      kind: input.variable,
      provenance: candidate.provenance,
      status: 'queued',
    }));
    const now = this.clock().toISOString();
    const plan: ProfitTestPlan = {
      id: randomUUID(),
      dataset: input.dataset,
      clientId: input.clientId,
      itemId: item.id,
      itemName: item.name,
      hypothesis: input.hypothesis.trim(),
      variable: input.variable,
      lossBudgetCents: input.lossBudgetCents,
      maxConcurrent: input.maxConcurrent,
      status: 'draft',
      assetEvidenceApproved: input.assetEvidenceApproved,
      candidates,
      createdAt: now,
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'INSERT INTO profit_test_plans(id,dataset,client_id,item_id,status,updated_at,body) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          plan.id,
          plan.dataset,
          plan.clientId,
          plan.itemId,
          plan.status,
          plan.updatedAt,
          JSON.stringify(plan),
        );
      this.repository.event(
        null,
        plan.dataset,
        plan.clientId,
        'profit.test.created',
        `${item.name}: ${candidates.length} candidates queued under a ${input.lossBudgetCents}-cent loss boundary.`,
        this.clock(),
      );
    });
    return plan;
  }

  activateTest(dataset: 'workspace', clientId: string, testId: string): ProfitTestPlan {
    this.repository.client(dataset, clientId);
    const row = this.store.db
      .prepare('SELECT body FROM profit_test_plans WHERE id=? AND dataset=? AND client_id=?')
      .get(testId, dataset, clientId) as { body: string } | undefined;
    if (!row) throw new AppError('Test plan not found in this client workspace.', 404);
    const old = JSON.parse(row.body) as ProfitTestPlan;
    if (old.status !== 'draft') throw new AppError('Only a draft test can start its first wave.');
    const current = this.view(dataset, clientId).items.find((item) => item.id === old.itemId);
    if (!current || current.blockers.length)
      throw new AppError(current?.blockers[0] || 'The test item is no longer available.');
    const activeIds = new Set(old.candidates.slice(0, old.maxConcurrent).map((item) => item.id));
    const now = this.clock().toISOString();
    const plan: ProfitTestPlan = {
      ...old,
      status: 'ready',
      candidates: old.candidates.map((candidate) => ({
        ...candidate,
        status: activeIds.has(candidate.id) ? 'active' : 'held',
      })),
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE profit_test_plans SET status=?,updated_at=?,body=? WHERE id=? AND client_id=?')
        .run(plan.status, now, JSON.stringify(plan), plan.id, clientId);
      this.repository.event(
        null,
        dataset,
        clientId,
        'profit.test.wave.ready',
        `${plan.itemName}: ${activeIds.size} candidates approved for the first bounded wave; no platform action.`,
        this.clock(),
      );
    });
    return plan;
  }

  private candidates(
    dataset: Dataset,
    clientId: string,
    items: ProfitItem[],
    mappings: ProfitMapping[],
    connections: SourceConnection[],
  ): MappingCandidate[] {
    const mapped = new Map(
      mappings.map((mapping) => [
        `${mapping.connectionId}\u0000${mapping.sourceKind}\u0000${mapping.externalId}`,
        mapping.itemId,
      ]),
    );
    const byIdentity = new Map<string, string>();
    for (const item of items)
      for (const identity of [item.sku, item.isbn, item.asin].filter(Boolean) as string[])
        byIdentity.set(normalized(identity), item.id);
    const rows: MappingCandidate[] = [];
    for (const connection of connections) {
      const kinds =
        connection.provider === 'shopify'
          ? ['variant']
          : connection.provider === 'pbs'
            ? ['book']
            : ['campaign'];
      for (const kind of kinds) {
        const objects = (
          this.store.db
            .prepare(
              'SELECT external_id,body FROM connection_objects WHERE connection_id=? AND kind=? ORDER BY external_id',
            )
            .all(connection.id, kind) as { external_id: string; body: string }[]
        ).slice(0, 25_000);
        for (const object of objects) {
          const value = JSON.parse(object.body) as Record<string, unknown>;
          const hintRaw =
            kind === 'variant'
              ? value.sku
              : kind === 'book'
                ? value.isbn13 || value.isbn
                : null;
          const identityHint = hintRaw ? String(hintRaw) : null;
          rows.push({
            connectionId: connection.id,
            connectionName: connection.name,
            provider: connection.provider,
            sourceKind: kind,
            externalId: object.external_id,
            sourceName: sourceName(kind, value, object.external_id),
            identityHint,
            suggestedItemId: identityHint ? byIdentity.get(normalized(identityHint)) || null : null,
            mappedItemId:
              mapped.get(`${connection.id}\u0000${kind}\u0000${object.external_id}`) || null,
          });
        }
      }
    }
    return rows;
  }

  private itemViews(
    items: ProfitItem[],
    mappings: ProfitMapping[],
    connections: SourceConnection[],
  ): ProfitItemView[] {
    const connectionMap = new Map(connections.map((connection) => [connection.id, connection]));
    const now = this.clock().getTime();
    return items.map((item) => {
      const itemMappings = mappings.filter((mapping) => mapping.itemId === item.id);
      let spendCents = 0;
      let attributedRevenueCents = 0;
      let attributedPurchases = 0;
      let independentReceiptsCents = 0;
      let independentUnits = 0;
      let refundsCents = 0;
      const observed: string[] = [];
      let hasAdMapping = false;
      let hasBusinessMapping = false;
      const staleSources = new Set<string>();
      for (const mapping of itemMappings) {
        const connection = connectionMap.get(mapping.connectionId);
        if (!connection) continue;
        if (
          !connection.health.lastSuccessAt ||
          now - Date.parse(connection.health.lastSuccessAt) >
            (connection.provider === 'pbs' ? 72 : 48) * 3_600_000
        )
          staleSources.add(connection.name);
        if (mapping.sourceKind === 'campaign') {
          hasAdMapping = true;
          if (mapping.provider === 'meta-ads' || mapping.provider === 'amazon-ads') {
            const insights = this.repository.objects<Record<string, unknown>>(connection.id, 'insight');
            for (const insight of insights)
              if (String(insight.campaign_id || insight.campaignExternalId) === mapping.externalId) {
                spendCents += cents(insight.spendCents ?? insight.costCents);
                attributedRevenueCents += cents(
                  insight.purchaseValueCents ?? insight.salesCents,
                );
                attributedPurchases += Number(insight.purchases || 0);
                const date = insight.date_stop || insight.date;
                if (typeof date === 'string') observed.push(date);
              }
          }
        }
        if (mapping.sourceKind === 'variant' && item.sku) {
          hasBusinessMapping = true;
          for (const line of this.repository.objects<Record<string, unknown>>(connection.id, 'order-line'))
            if (String(line.sku || '') === item.sku) {
              independentReceiptsCents += cents(line.netReceiptsCents);
              independentUnits += Number(line.units || 0);
              refundsCents += cents(line.refundsCents);
              if (typeof line.observedAt === 'string') observed.push(line.observedAt);
            }
        }
        if (mapping.sourceKind === 'book') {
          hasBusinessMapping = true;
          for (const settlement of this.repository.objects<Record<string, unknown>>(
            connection.id,
            'settlement',
          )) {
            const earnings = Array.isArray(settlement.earnings_by_title)
              ? (settlement.earnings_by_title as Record<string, unknown>[])
              : [];
            for (const row of earnings)
              if (String(row.bk_num || '') === mapping.externalId) {
                independentReceiptsCents += dollarsToCents(row.net_sales);
                independentUnits += Number(row.units_sold_through || 0);
              }
            const period = settlement.period as Record<string, unknown> | undefined;
            if (typeof period?.to === 'string') observed.push(period.to);
          }
        }
      }
      const economics = item.economics;
      const affordable = economics.verified
        ? economics.netReceiptCents - economics.variableCostCents - economics.profitReserveCents
        : null;
      const screeningContribution = economics.verified
        ? attributedPurchases * (economics.netReceiptCents - economics.variableCostCents) - spendCents
        : null;
      const risk = Math.max(0, spendCents - attributedPurchases * Math.max(0, affordable || 0));
      const remainingLoss = economics.verified ? Math.max(0, economics.lossLimitCents - risk) : null;
      const blockers: string[] = [];
      if (!economics.verified) blockers.push('Economics are not verified.');
      if ((affordable || 0) <= 0) blockers.push('Economics leave no acquisition room.');
      if (!hasAdMapping) blockers.push('No ad campaign is mapped.');
      if (!hasBusinessMapping) blockers.push('No independent commerce or publisher source is mapped.');
      if (staleSources.size) blockers.push(`Refresh stale sources: ${[...staleSources].join(', ')}.`);
      let decision: ProfitItemView['decision'] = 'observe';
      let reason = 'Collect mature advertising and independent receipt evidence.';
      if (blockers.length) {
        decision = 'blocked';
        reason = blockers[0];
      } else if (remainingLoss === 0 && spendCents > 0) {
        decision = 'stop';
        reason = 'The learning loss allowance is exhausted.';
      } else if (
        attributedPurchases >= 20 &&
        screeningContribution !== null &&
        screeningContribution > 0 &&
        independentUnits > 0
      ) {
        decision = 'scale';
        reason = 'Mature platform conversions and independent receipts support a bounded increase.';
      } else if (spendCents === 0 || attributedPurchases < 20) {
        decision = 'test';
        reason = 'The item is ready for a bounded learning allocation.';
      }
      const proposedDailyBudgetCents =
        decision === 'scale' || decision === 'test'
          ? Math.min(
              economics.dailyBudgetLimitCents,
              Math.max(0, Math.floor((remainingLoss || 0) / 14)),
            )
          : 0;
      return {
        ...item,
        mappings: itemMappings,
        evidence: {
          spendCents,
          attributedRevenueCents,
          attributedPurchases,
          independentReceiptsCents,
          independentUnits,
          refundsCents,
          sourceAsOf: observed.sort().at(-1) || null,
        },
        affordableAcquisitionCents: affordable,
        screeningContributionCents: screeningContribution,
        remainingLossCents: remainingLoss,
        decision,
        reason,
        proposedDailyBudgetCents,
        blockers,
      };
    });
  }

  view(dataset: Dataset, requestedClientId?: string): ProfitControlView {
    const clients = this.repository.clients(dataset);
    if (!clients.length) throw new AppError('No client workspace is available.', 404);
    const activeClientId = requestedClientId || clients[0].id;
    this.repository.client(dataset, activeClientId);
    const items = this.itemRows(dataset, activeClientId);
    const mappings = this.mappings(dataset, activeClientId);
    const connections = this.repository.connections(dataset, activeClientId);
    const itemViews = this.itemViews(items, mappings, connections);
    const candidates = this.candidates(dataset, activeClientId, items, mappings, connections);
    const jobs = this.repository.jobs(dataset, activeClientId);
    const mappedReady = itemViews.filter(
      (item) => item.economics.verified && item.mappings.length >= 2 && !item.blockers.length,
    ).length;
    const checks = [
      {
        key: 'sources',
        label: 'Advertising and receipt sources',
        ready: connections.some((connection) => ['meta-ads', 'amazon-ads'].includes(connection.provider)) &&
          connections.some((connection) => ['shopify', 'pbs'].includes(connection.provider)),
        detail: `${connections.filter((connection) => connection.health.status === 'healthy').length}/${connections.length} sources healthy`,
      },
      {
        key: 'economics',
        label: 'Verified unit economics',
        ready: itemViews.length > 0 && itemViews.every((item) => item.economics.verified),
        detail: `${itemViews.filter((item) => item.economics.verified).length}/${itemViews.length} items verified`,
      },
      {
        key: 'mapping',
        label: 'Exact identity reconciliation',
        ready: itemViews.length > 0 && mappedReady === itemViews.length,
        detail: `${mappedReady}/${itemViews.length} items have current ad and receipt evidence`,
      },
      {
        key: 'operations',
        label: 'Recovery queue clear',
        ready: !jobs.some((job) => job.status === 'dead-letter' || job.status === 'failed'),
        detail: `${jobs.filter((job) => job.status === 'dead-letter' || job.status === 'failed').length} failed or dead-letter jobs`,
      },
    ];
    return {
      dataset,
      clients,
      activeClientId,
      items: itemViews,
      candidates,
      pools: this.pools(dataset, activeClientId),
      runs: this.runs(dataset, activeClientId),
      tests: this.tests(dataset, activeClientId),
      readiness: { ready: checks.every((check) => check.ready), checks },
      summary: {
        items: itemViews.length,
        verified: itemViews.filter((item) => item.economics.verified).length,
        mapped: itemViews.filter((item) => item.mappings.length > 0).length,
        mappingGaps: candidates.filter((candidate) => !candidate.mappedItemId).length,
        scaleCandidates: itemViews.filter((item) => item.decision === 'scale').length,
        stopCandidates: itemViews.filter((item) => item.decision === 'stop').length,
        spendCents: itemViews.reduce((sum, item) => sum + item.evidence.spendCents, 0),
        independentReceiptsCents: itemViews.reduce(
          (sum, item) => sum + item.evidence.independentReceiptsCents,
          0,
        ),
      },
    };
  }

  optimize(dataset: 'workspace', clientId: string, poolId: string): OptimizerRun {
    const view = this.view(dataset, clientId);
    const pool = view.pools.find((candidate) => candidate.id === poolId && candidate.active);
    if (!pool) throw new AppError('Active budget pool not found in this client workspace.', 404);
    const eligible = view.items
      .filter(
        (item) =>
          item.active &&
          (pool.vertical === 'all' || pool.vertical === item.vertical) &&
          ['scale', 'test'].includes(item.decision) &&
          item.proposedDailyBudgetCents > 0,
      )
      .map((item) => ({
        item,
        score:
          (item.decision === 'scale' ? 100 : 40) +
          (item.screeningContributionCents || 0) / Math.max(1, item.evidence.spendCents || 100),
      }))
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
    let available = Math.floor(pool.dailyLimitCents * (1 - pool.reservePercent / 100));
    const allocations = eligible.map(({ item, score }) => {
      const allocatedDailyCents = Math.min(available, item.proposedDailyBudgetCents);
      available -= allocatedDailyCents;
      return {
        itemId: item.id,
        itemName: item.name,
        decision: item.decision,
        allocatedDailyCents,
        score: Math.round(score * 1000) / 1000,
        reason: item.reason,
      };
    });
    const createdAt = this.clock().toISOString();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ pool, items: view.items.map((item) => [item.id, item.economics.versionId, item.evidence]) }))
      .digest('hex');
    const run: OptimizerRun = {
      id: randomUUID(),
      dataset,
      clientId,
      poolId: pool.id,
      mode: 'shadow',
      totalAllocatedCents: allocations.reduce((sum, row) => sum + row.allocatedDailyCents, 0),
      unallocatedCents: Math.max(0, available),
      allocations,
      evidenceFingerprint: fingerprint,
      createdAt,
    };
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'INSERT INTO profit_optimizer_runs(id,dataset,client_id,created_at,body) VALUES(?,?,?,?,?)',
        )
        .run(run.id, dataset, clientId, createdAt, JSON.stringify(run));
      this.repository.event(
        null,
        dataset,
        clientId,
        'profit.optimizer.shadow',
        `${pool.name}: allocated ${run.totalAllocatedCents} cents/day across ${allocations.filter((row) => row.allocatedDailyCents > 0).length} items; no platform writes.`,
        this.clock(),
      );
    });
    return run;
  }
}
