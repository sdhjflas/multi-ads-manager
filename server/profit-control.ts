import { createHash, randomUUID } from 'node:crypto';
import type {
  MappingCandidate,
  OptimizerRun,
  ProfitAsset,
  ProfitAssetKind,
  ProfitBudgetPool,
  ProfitCandidateBinding,
  ProfitCandidateResult,
  ProfitCandidateVerdict,
  ProfitControlView,
  ProfitEconomics,
  ProfitItem,
  ProfitItemView,
  ProfitMapping,
  ProfitExperimentSource,
  ProfitTestCandidate,
  ProfitTestPlan,
  ProfitTestWave,
  ProfitVertical,
} from '../shared/control.js';
import type { Dataset } from '../shared/types.js';
import type { SourceConnection, SourceProvider } from '../shared/connections.js';
import type { Store } from './store.js';
import { AppError } from './validation.js';
import { ConnectionRepository, type SourceObject } from './connections/repository.js';
import { dayAt } from './engine.js';

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
  assetIds: string[];
}

interface AssetInput {
  dataset: 'workspace';
  clientId: string;
  itemId: string;
  kind: ProfitAssetKind;
  name: string;
  contentHash: string;
  sourceRef: string;
  rightsApproved: boolean;
  claimsApproved: boolean;
  evidenceApproved: boolean;
  approvalNote: string;
  supersedesId?: string;
}

interface WaveSetupInput {
  dataset: 'workspace';
  clientId: string;
  testId: string;
  waveId: string;
  bindings: Array<{
    candidateId: string;
    connectionId: string;
    sourceKind: ProfitCandidateBinding['sourceKind'];
    externalId: string;
  }>;
  startDate: string;
  endDate: string;
  attributionDays: number;
  lossBudgetCents: number;
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
      value.keywordText ||
      value.text ||
      value.label ||
      value.asin ||
      value.orderName ||
      (kind === 'book' ? value.bk_num : '') ||
      fallback,
  );
const sourceExternalId = (value: Record<string, unknown>) => String(value.id || value.externalId || '');
const sourceParentId = (value: Record<string, unknown>) =>
  String(value.campaign_id || value.campaignId || value.campaignExternalId || '');
const sourceVariant = (
  kind: ProfitCandidateBinding['sourceKind'],
  value: Record<string, unknown>,
) => {
  if (kind === 'keyword') return String(value.matchType || '').toLowerCase() || null;
  if (kind === 'product-target') return String(value.asin || '').toUpperCase() || null;
  const creative = value.creative as Record<string, unknown> | undefined;
  return String(creative?.id || value.creative_id || '') || null;
};
const DAY = 86_400_000;
const dateOnly = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const addDays = (value: string, days: number) =>
  new Date(Date.parse(`${value}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
const startOfLocalDate = (value: string, timezone: string) => {
  const [year, month, day] = value.split('-').map(Number);
  const intended = Date.UTC(year, month - 1, day);
  if (timezone === 'UTC') return new Date(intended);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let guess = intended;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = formatter.formatToParts(new Date(guess));
    const number = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value || 0);
    const represented = Date.UTC(
      number('year'),
      number('month') - 1,
      number('day'),
      number('hour'),
      number('minute'),
      number('second'),
    );
    const correction = intended - represented;
    guess += correction;
    if (!correction) break;
  }
  return new Date(guess);
};

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

  private assets(dataset: Dataset, clientId: string): ProfitAsset[] {
    this.repository.client(dataset, clientId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM profit_assets WHERE dataset=? AND client_id=? ORDER BY created_at DESC,id',
        )
        .all(dataset, clientId) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  private waves(dataset: Dataset, clientId: string, testId?: string): ProfitTestWave[] {
    this.repository.client(dataset, clientId);
    const rows = testId
      ? (this.store.db
          .prepare(
            'SELECT body FROM profit_test_waves WHERE dataset=? AND client_id=? AND test_id=? ORDER BY sequence',
          )
          .all(dataset, clientId, testId) as { body: string }[])
      : (this.store.db
          .prepare(
            'SELECT body FROM profit_test_waves WHERE dataset=? AND client_id=? ORDER BY test_id,sequence',
          )
          .all(dataset, clientId) as { body: string }[]);
    return rows.map((row) => {
      const wave = JSON.parse(row.body) as ProfitTestWave;
      return {
        ...wave,
        registration: wave.registration || null,
        assetVersions: wave.assetVersions || [],
        economics: wave.economics || null,
        reportingTimezone: wave.reportingTimezone || null,
      };
    });
  }

  private bindings(dataset: Dataset, clientId: string, testId?: string): ProfitCandidateBinding[] {
    this.repository.client(dataset, clientId);
    const rows = testId
      ? (this.store.db
          .prepare(
            'SELECT body FROM profit_candidate_bindings WHERE dataset=? AND client_id=? AND test_id=? ORDER BY candidate_id',
          )
          .all(dataset, clientId, testId) as { body: string }[])
      : (this.store.db
          .prepare(
            'SELECT body FROM profit_candidate_bindings WHERE dataset=? AND client_id=? ORDER BY test_id,candidate_id',
          )
          .all(dataset, clientId) as { body: string }[]);
    return rows.map((row) => {
      const binding = JSON.parse(row.body) as ProfitCandidateBinding;
      return { ...binding, variant: binding.variant || null };
    });
  }

  private tests(dataset: Dataset, clientId: string): ProfitTestPlan[] {
    this.repository.client(dataset, clientId);
    const waves = this.waves(dataset, clientId);
    const bindings = this.bindings(dataset, clientId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM profit_test_plans WHERE dataset=? AND client_id=? ORDER BY updated_at DESC,id',
        )
        .all(dataset, clientId) as { body: string }[]
    ).map((row) => {
      const stored = JSON.parse(row.body) as Partial<ProfitTestPlan> &
        Pick<ProfitTestPlan, 'id' | 'candidates'>;
      const testWaves = waves.filter((wave) => wave.testId === stored.id);
      const legacyReady = stored.status === 'ready' && !testWaves.length;
      return {
        ...stored,
        status: legacyReady ? 'draft' : stored.status,
        assetIds: stored.assetIds || [],
        outcome: stored.outcome || null,
        candidates: stored.candidates.map((candidate) => ({
          ...candidate,
          binding:
            bindings.find(
              (binding) => binding.testId === stored.id && binding.candidateId === candidate.id,
            ) || null,
        })),
        waves: testWaves,
      } as ProfitTestPlan;
    });
  }

  private test(dataset: Dataset, clientId: string, testId: string): ProfitTestPlan {
    const test = this.tests(dataset, clientId).find((candidate) => candidate.id === testId);
    if (!test) throw new AppError('Test plan not found in this client workspace.', 404);
    return test;
  }

  private saveTest(plan: ProfitTestPlan) {
    this.store.db
      .prepare('UPDATE profit_test_plans SET status=?,updated_at=?,body=? WHERE id=? AND client_id=?')
      .run(plan.status, plan.updatedAt, JSON.stringify(plan), plan.id, plan.clientId);
  }

  private saveWave(wave: ProfitTestWave) {
    this.store.db
      .prepare(
        `INSERT INTO profit_test_waves(id,dataset,client_id,test_id,sequence,status,updated_at,body)
         VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
         status=excluded.status,updated_at=excluded.updated_at,body=excluded.body`,
      )
      .run(
        wave.id,
        wave.dataset,
        wave.clientId,
        wave.testId,
        wave.sequence,
        wave.status,
        wave.updatedAt,
        JSON.stringify(wave),
      );
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

  createAsset(input: AssetInput): ProfitAsset {
    const item = this.item(input.dataset, input.clientId, input.itemId);
    if (item.vertical !== 'commerce')
      throw new AppError('Creative asset provenance belongs to a commerce SKU.');
    const contentHash = input.contentHash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(contentHash))
      throw new AppError('Asset content hash must be a 64-character SHA-256 value.');
    const previous = input.supersedesId
      ? this.assets(input.dataset, input.clientId).find((asset) => asset.id === input.supersedesId)
      : undefined;
    if (input.supersedesId && (!previous || previous.itemId !== item.id))
      throw new AppError('The superseded asset is not part of this item.', 404);
    if (previous?.status === 'superseded')
      throw new AppError('Create the next version from the current asset version.');
    if (previous && previous.kind !== input.kind)
      throw new AppError('A replacement asset must keep the same asset type.');
    const approved = input.rightsApproved && input.claimsApproved && input.evidenceApproved;
    if (approved && !input.approvalNote.trim())
      throw new AppError('Approved assets require an approval record.');
    const now = this.clock().toISOString();
    const asset: ProfitAsset = {
      id: randomUUID(),
      dataset: input.dataset,
      clientId: input.clientId,
      itemId: item.id,
      itemName: item.name,
      kind: input.kind,
      name: input.name.trim(),
      version: (previous?.version || 0) + 1,
      contentHash,
      sourceRef: input.sourceRef.trim(),
      status: approved ? 'approved' : 'draft',
      rightsApproved: input.rightsApproved,
      claimsApproved: input.claimsApproved,
      evidenceApproved: input.evidenceApproved,
      approvalNote: input.approvalNote.trim(),
      supersedesId: previous?.id || null,
      approvedAt: approved ? now : null,
      createdAt: now,
    };
    try {
      this.store.transaction(() => {
        if (previous) {
          const superseded = { ...previous, status: 'superseded' as const };
          this.store.db
            .prepare('UPDATE profit_assets SET status=?,body=? WHERE id=? AND client_id=?')
            .run('superseded', JSON.stringify(superseded), previous.id, input.clientId);
        }
        this.store.db
          .prepare(
            `INSERT INTO profit_assets
             (id,dataset,client_id,item_id,content_hash,status,created_at,body)
             VALUES(?,?,?,?,?,?,?,?)`,
          )
          .run(
            asset.id,
            asset.dataset,
            asset.clientId,
            asset.itemId,
            asset.contentHash,
            asset.status,
            asset.createdAt,
            JSON.stringify(asset),
          );
        this.repository.event(
          null,
          asset.dataset,
          asset.clientId,
          'profit.asset.versioned',
          `${item.name}: ${asset.name} v${asset.version} recorded as ${asset.status}.`,
          this.clock(),
        );
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint/.test(error.message))
        throw new AppError('That exact asset content is already registered for this item.', 409);
      throw error;
    }
    return asset;
  }

  experimentSources(
    dataset: Dataset,
    clientId: string,
    testId: string,
  ): ProfitExperimentSource[] {
    const test = this.test(dataset, clientId, testId);
    const itemMappings = this.mappings(dataset, clientId).filter(
      (mapping) => mapping.itemId === test.itemId && mapping.sourceKind === 'campaign',
    );
    const expectedProvider: SourceProvider =
      test.variable === 'keyword' || test.variable === 'product-target' ? 'amazon-ads' : 'meta-ads';
    const expectedKind: ProfitCandidateBinding['sourceKind'] =
      test.variable === 'keyword'
        ? 'keyword'
        : test.variable === 'product-target'
          ? 'product-target'
          : 'ad';
    const mappedParents = new Set(
      itemMappings
        .filter((mapping) => mapping.provider === expectedProvider)
        .map((mapping) => `${mapping.connectionId}\u0000${mapping.externalId}`),
    );
    const rows: ProfitExperimentSource[] = [];
    for (const connection of this.repository
      .connections(dataset, clientId)
      .filter((candidate) => candidate.provider === expectedProvider)) {
      const objects = this.repository.objects<Record<string, unknown>>(connection.id, expectedKind);
      for (const value of objects) {
        const externalId = sourceExternalId(value);
        const parentCampaignId = sourceParentId(value);
        if (
          !externalId ||
          !parentCampaignId ||
          !mappedParents.has(`${connection.id}\u0000${parentCampaignId}`)
        )
          continue;
        const variant = sourceVariant(expectedKind, value);
        if (expectedKind === 'product-target' && !/^[A-Z0-9]{10}$/.test(variant || '')) continue;
        rows.push({
          connectionId: connection.id,
          connectionName: connection.name,
          provider: connection.provider,
          sourceKind: expectedKind,
          externalId,
          sourceName: sourceName(expectedKind, value, externalId),
          parentCampaignId,
          variant,
        });
      }
    }
    return rows.slice(0, 25_000);
  }

  createTest(input: TestInput): ProfitTestPlan {
    const item = this.item(input.dataset, input.clientId, input.itemId);
    if (input.count < 2 || input.count > 300)
      throw new AppError('A test queue must contain between 2 and 300 candidates.');
    if (input.maxConcurrent < 2 || input.maxConcurrent > 20 || input.maxConcurrent > input.count)
      throw new AppError('Concurrent arms must be between 2 and 20 and cannot exceed the queue.');
    if (input.lossBudgetCents <= 0)
      throw new AppError('The test loss boundary must be positive.');
    if (!item.economics.verified)
      throw new AppError('Verify this item’s economics before reserving a test budget.');
    const bookKinds = ['keyword', 'product-target'];
    const commerceKinds = ['hook', 'headline', 'audience', 'landing-page'];
    if (
      (item.vertical === 'books' && !bookKinds.includes(input.variable)) ||
      (item.vertical === 'commerce' && !commerceKinds.includes(input.variable))
    )
      throw new AppError('The selected test variable does not match this item type.');
    const assetIds = [...new Set(input.assetIds)];
    const assets = this.assets(input.dataset, input.clientId).filter((asset) =>
      assetIds.includes(asset.id),
    );
    if (item.vertical === 'commerce') {
      if (!assets.length || assets.length !== assetIds.length)
        throw new AppError('Product tests require a registered asset version.');
      if (assets.some((asset) => asset.itemId !== item.id || asset.status !== 'approved'))
        throw new AppError('Every product asset must be current, approved, and owned by this item.');
      const relevant =
        input.variable === 'landing-page'
          ? assets.some((asset) => asset.kind === 'landing-page')
          : input.variable === 'headline'
            ? assets.some((asset) => asset.kind === 'copy')
            : input.variable === 'hook'
              ? assets.some((asset) => ['image', 'video', 'copy'].includes(asset.kind))
              : true;
      if (!relevant)
        throw new AppError('Choose an approved asset version that matches the test variable.');
    } else if (assetIds.length) {
      throw new AppError('Book keyword and product-target tests do not use commerce assets.');
    }
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
      binding: null,
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
      assetEvidenceApproved: item.vertical === 'books' || assets.every((asset) => asset.status === 'approved'),
      assetIds,
      candidates,
      waves: [],
      outcome: null,
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
    const old = this.test(dataset, clientId, testId);
    if (old.status !== 'draft') throw new AppError('Only a draft test can start its first wave.');
    const current = this.view(dataset, clientId).items.find((item) => item.id === old.itemId);
    if (!current || current.blockers.length)
      throw new AppError(current?.blockers[0] || 'The test item is no longer available.');
    if (current.vertical === 'commerce') {
      const currentAssets = this.assets(dataset, clientId).filter((asset) =>
        old.assetIds.includes(asset.id),
      );
      if (
        !old.assetIds.length ||
        currentAssets.length !== old.assetIds.length ||
        currentAssets.some((asset) => asset.status !== 'approved')
      )
        throw new AppError('A referenced asset version is no longer the current approved version.');
    }
    const activeIds = new Set(old.candidates.slice(0, old.maxConcurrent).map((item) => item.id));
    if (activeIds.size < 2)
      throw new AppError('Rebuild this legacy plan with at least two concurrent arms.');
    const now = this.clock().toISOString();
    const wave: ProfitTestWave = {
      id: randomUUID(),
      dataset,
      clientId,
      testId: old.id,
      sequence: 1,
      status: 'setup',
      registration: null,
      candidateIds: [...activeIds],
      assetVersions: [],
      economics: null,
      reportingTimezone: null,
      lossBudgetCents: 0,
      startDate: null,
      endDate: null,
      attributionDays: null,
      expectedMatureAt: null,
      launchedAt: null,
      evaluatedAt: null,
      results: [],
      totalSpendCents: 0,
      totalRiskCents: 0,
      recommendation: null,
      reason: 'Bind each candidate to its exact platform identity before registering the measurement window.',
      evidenceFingerprint: null,
      createdAt: now,
      updatedAt: now,
    };
    const plan: ProfitTestPlan = {
      ...old,
      status: 'ready',
      candidates: old.candidates.map((candidate) => ({
        ...candidate,
          status: activeIds.has(candidate.id) ? 'active' : 'held',
      })),
      waves: [wave],
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.saveTest(plan);
      this.saveWave(wave);
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

  setupWave(input: WaveSetupInput): ProfitTestPlan {
    const plan = this.test(input.dataset, input.clientId, input.testId);
    const wave = plan.waves.find((candidate) => candidate.id === input.waveId);
    if (!wave || wave.status !== 'setup')
      throw new AppError('The selected wave is not waiting for platform setup.', 409);
    if (!dateOnly(input.startDate) || !dateOnly(input.endDate) || input.startDate > input.endDate)
      throw new AppError('Use an ordered measurement window with real calendar dates.');
    const start = Date.parse(`${input.startDate}T00:00:00.000Z`);
    const end = Date.parse(`${input.endDate}T23:59:59.999Z`);
    if (end - start > 60 * DAY)
      throw new AppError('A measured wave can cover at most 61 calendar days.');
    if (!Number.isInteger(input.attributionDays) || input.attributionDays < 1 || input.attributionDays > 30)
      throw new AppError('Attribution maturity must be between 1 and 30 days.');
    const current = this.view(input.dataset, input.clientId).items.find(
      (item) => item.id === plan.itemId,
    );
    if (!current || current.blockers.length)
      throw new AppError(current?.blockers[0] || 'The test item is unavailable.');
    let currentAssets: ProfitAsset[] = [];
    if (current.vertical === 'commerce') {
      currentAssets = this.assets(input.dataset, input.clientId).filter((asset) =>
        plan.assetIds.includes(asset.id),
      );
      if (
        !plan.assetIds.length ||
        currentAssets.length !== plan.assetIds.length ||
        currentAssets.some((asset) => asset.status !== 'approved')
      )
        throw new AppError('A referenced asset version is no longer the current approved version.');
    }
    const usedLoss = plan.waves
      .filter((candidate) => candidate.status === 'decided')
      .reduce((sum, candidate) => sum + candidate.totalRiskCents, 0);
    const remainingLoss = Math.max(0, plan.lossBudgetCents - usedLoss);
    if (
      input.lossBudgetCents <= 0 ||
      input.lossBudgetCents > remainingLoss ||
      input.lossBudgetCents > (current.remainingLossCents || 0)
    )
      throw new AppError('The wave loss boundary exceeds the remaining item or test allowance.');
    const activeCandidates = plan.candidates.filter((candidate) =>
      wave.candidateIds.includes(candidate.id),
    );
    if (activeCandidates.length < 2)
      throw new AppError('A measured wave requires at least two active arms.');
    const supplied = new Map(input.bindings.map((binding) => [binding.candidateId, binding]));
    if (supplied.size !== input.bindings.length)
      throw new AppError('Each candidate can have only one platform binding.');
    if (input.bindings.some((binding) => !wave.candidateIds.includes(binding.candidateId)))
      throw new AppError('A binding targets a candidate outside this wave.');
    const sources = new Map(
      this.experimentSources(input.dataset, input.clientId, plan.id).map((source) => [
        `${source.connectionId}\u0000${source.sourceKind}\u0000${source.externalId}`,
        source,
      ]),
    );
    const created: ProfitCandidateBinding[] = [];
    for (const candidate of activeCandidates) {
      if (candidate.binding) continue;
      const bindingInput = supplied.get(candidate.id);
      if (!bindingInput) throw new AppError(`Bind ${candidate.label} to an exact platform entity.`);
      const source = sources.get(
        `${bindingInput.connectionId}\u0000${bindingInput.sourceKind}\u0000${bindingInput.externalId}`,
      );
      if (!source)
        throw new AppError('A selected platform identity is not eligible for this item and campaign.');
      if (plan.variable === 'keyword') {
        const expectedMatch = candidate.provenance.match(/; (exact|phrase|broad) frame\.$/i)?.[1].toLowerCase();
        if (expectedMatch && source.variant !== expectedMatch)
          throw new AppError(`${candidate.label} requires an Amazon ${expectedMatch}-match keyword.`);
      }
      created.push({
        id: randomUUID(),
        dataset: input.dataset,
        clientId: input.clientId,
        testId: plan.id,
        candidateId: candidate.id,
        connectionId: source.connectionId,
        provider: source.provider,
        sourceKind: source.sourceKind,
        externalId: source.externalId,
        sourceName: source.sourceName,
        parentCampaignId: source.parentCampaignId,
        variant: source.variant,
        createdAt: this.clock().toISOString(),
      });
    }
    const bindingByCandidate = new Map<string, ProfitCandidateBinding>();
    for (const candidate of plan.candidates)
      if (candidate.binding) bindingByCandidate.set(candidate.id, candidate.binding);
    for (const binding of created) bindingByCandidate.set(binding.candidateId, binding);
    if (activeCandidates.some((candidate) => !bindingByCandidate.has(candidate.id)))
      throw new AppError('Every active candidate requires one exact platform binding.');
    const sourceIdentities = activeCandidates.map((candidate) => {
      const binding = bindingByCandidate.get(candidate.id)!;
      return `${binding.connectionId}\u0000${binding.sourceKind}\u0000${binding.externalId}`;
    });
    if (new Set(sourceIdentities).size !== sourceIdentities.length)
      throw new AppError('Each active candidate requires a different platform identity.');
    const comparisonScopes = activeCandidates.map((candidate) => {
      const binding = bindingByCandidate.get(candidate.id)!;
      return `${binding.connectionId}\u0000${binding.parentCampaignId}`;
    });
    if (new Set(comparisonScopes).size !== 1)
      throw new AppError('Every arm in a wave must belong to the same advertiser and parent campaign.');
    const connectionId = bindingByCandidate.get(activeCandidates[0].id)!.connectionId;
    const sourceConnection = this.repository
      .connections(input.dataset, input.clientId)
      .find((connection) => connection.id === connectionId);
    if (!sourceConnection) throw new AppError('The bound source connection is unavailable.', 409);
    const reportingTimezone = sourceConnection.timezone || 'UTC';
    let expectedMatureAt: string;
    let registration: 'prospective' | 'historical';
    try {
      const accountDate = dayAt(this.clock(), 0, reportingTimezone);
      if (input.endDate < accountDate) registration = 'historical';
      else if (input.startDate > accountDate) registration = 'prospective';
      else
        throw new AppError(
          'Register a fully historical window or a prospective window that starts after the current account date.',
        );
      if (registration === 'prospective' && input.startDate > addDays(accountDate, 90))
        throw new AppError('A prospective wave must start within the next 90 account-calendar days.');
      expectedMatureAt = startOfLocalDate(
        addDays(input.endDate, input.attributionDays + 1),
        reportingTimezone,
      ).toISOString();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('The source connection has an invalid reporting timezone.', 409);
    }
    const now = this.clock().toISOString();
    const runningWave: ProfitTestWave = {
      ...wave,
      status: 'running',
      registration,
      assetVersions: currentAssets.map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        name: asset.name,
        version: asset.version,
        contentHash: asset.contentHash,
      })),
      economics: { ...current.economics },
      reportingTimezone,
      lossBudgetCents: input.lossBudgetCents,
      startDate: input.startDate,
      endDate: input.endDate,
      attributionDays: input.attributionDays,
      expectedMatureAt,
      launchedAt: now,
      reason:
        registration === 'prospective'
          ? `Prospective window registered before delivery; it starts ${input.startDate}.`
          : `Historical window registered; waiting for the ${input.attributionDays}-day attribution window to mature.`,
      updatedAt: now,
    };
    const runningPlan: ProfitTestPlan = {
      ...plan,
      status: 'running',
      candidates: plan.candidates.map((candidate) => ({
        ...candidate,
        binding: bindingByCandidate.get(candidate.id) || candidate.binding,
      })),
      waves: plan.waves.map((candidate) =>
        candidate.id === wave.id ? runningWave : candidate,
      ),
      updatedAt: now,
    };
    try {
      this.store.transaction(() => {
        for (const binding of created)
          this.store.db
            .prepare(
              `INSERT INTO profit_candidate_bindings
               (id,dataset,client_id,test_id,candidate_id,connection_id,source_kind,external_id,created_at,body)
               VALUES(?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              binding.id,
              binding.dataset,
              binding.clientId,
              binding.testId,
              binding.candidateId,
              binding.connectionId,
              binding.sourceKind,
              binding.externalId,
              binding.createdAt,
              JSON.stringify(binding),
            );
        this.saveWave(runningWave);
        this.saveTest(runningPlan);
        this.repository.event(
          null,
          input.dataset,
          input.clientId,
          'profit.test.wave.launched',
          `${plan.itemName}: wave ${wave.sequence} registered with ${activeCandidates.length} exact platform identities; no platform action.`,
          this.clock(),
        );
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint/.test(error.message))
        throw new AppError('A platform identity is already bound to another candidate.', 409);
      throw error;
    }
    return runningPlan;
  }

  evaluateWave(
    dataset: 'workspace',
    clientId: string,
    testId: string,
    waveId: string,
  ): ProfitTestWave {
    const plan = this.test(dataset, clientId, testId);
    const wave = plan.waves.find((candidate) => candidate.id === waveId);
    if (!wave || wave.status !== 'running' || !wave.startDate || !wave.endDate || !wave.expectedMatureAt)
      throw new AppError('The selected wave is not running.', 409);
    if (this.clock().getTime() < Date.parse(wave.expectedMatureAt))
      throw new AppError(`Attribution evidence matures after ${wave.expectedMatureAt}.`, 409);
    if (!wave.economics)
      throw new AppError('This wave has no frozen economics snapshot and cannot be evaluated.', 409);
    const economics = wave.economics;
    const connections = new Map(
      this.repository.connections(dataset, clientId).map((connection) => [connection.id, connection]),
    );
    const candidates = plan.candidates.filter((candidate) => wave.candidateIds.includes(candidate.id));
    const perCandidateLoss = Math.max(1, Math.floor(wave.lossBudgetCents / candidates.length));
    const affordable =
      economics.netReceiptCents - economics.variableCostCents - economics.profitReserveCents;
    const results: ProfitCandidateResult[] = candidates.map((candidate) => {
      const binding = candidate.binding;
      if (!binding) throw new AppError(`${candidate.label} has no platform binding.`, 409);
      const connection = connections.get(binding.connectionId);
      if (!connection || !connection.health.lastSuccessAt)
        throw new AppError(`${binding.sourceName} has no successful source refresh.`, 409);
      if (connection.health.status !== 'healthy')
        throw new AppError(`${connection.name} must complete a healthy source refresh before evaluation.`, 409);
      if ((connection.timezone || 'UTC') !== wave.reportingTimezone)
        throw new AppError(`${connection.name} reporting timezone changed after wave setup.`, 409);
      const currentSource = this.repository
        .objects<Record<string, unknown>>(connection.id, binding.sourceKind)
        .find((source) => sourceExternalId(source) === binding.externalId);
      if (
        currentSource &&
        (sourceParentId(currentSource) !== binding.parentCampaignId ||
          sourceVariant(binding.sourceKind, currentSource) !== binding.variant)
      )
        throw new AppError(`${binding.sourceName} changed identity after wave setup.`, 409);
      if (Date.parse(connection.health.lastSuccessAt) < Date.parse(wave.expectedMatureAt!))
        throw new AppError(`Refresh ${connection.name} after the attribution window matures.`, 409);
      if (this.clock().getTime() - Date.parse(connection.health.lastSuccessAt) > 48 * 3_600_000)
        throw new AppError(`Refresh ${connection.name}; its latest successful source evidence is stale.`, 409);
      const kind =
        binding.provider === 'meta-ads'
          ? 'insight'
          : binding.sourceKind === 'keyword'
            ? 'keyword-insight'
            : 'product-target-insight';
      const facts = this.repository
        .objects<Record<string, unknown>>(connection.id, kind)
        .filter((fact) => {
          const identity = String(
            binding.provider === 'meta-ads'
              ? fact.ad_id || ''
              : fact.keywordExternalId || fact.keywordId || '',
          );
          const date = String(fact.date_stop || fact.date || '');
          return identity === binding.externalId && date >= wave.startDate! && date <= wave.endDate!;
        });
      const evidence = facts.reduce<{
        impressions: number;
        clicks: number;
        spendCents: number;
        attributedPurchases: number;
        attributedRevenueCents: number;
      }>(
        (total, fact) => ({
          impressions: total.impressions + Number(fact.impressions || 0),
          clicks: total.clicks + Number(fact.clicks || 0),
          spendCents: total.spendCents + cents(fact.spendCents ?? fact.costCents),
          attributedPurchases:
            total.attributedPurchases + Number(fact.purchases || 0),
          attributedRevenueCents:
            total.attributedRevenueCents + cents(fact.purchaseValueCents ?? fact.salesCents),
        }),
        {
          impressions: 0,
          clicks: 0,
          spendCents: 0,
          attributedPurchases: 0,
          attributedRevenueCents: 0,
        },
      );
      const contribution =
        evidence.attributedPurchases * (economics.netReceiptCents - economics.variableCostCents) -
        evidence.spendCents;
      const risk = Math.max(0, evidence.spendCents - evidence.attributedPurchases * affordable);
      const cpa = evidence.attributedPurchases
        ? Math.round(evidence.spendCents / evidence.attributedPurchases)
        : null;
      let verdict: ProfitCandidateVerdict = 'inconclusive';
      let reason = 'Evidence does not yet support a directional decision.';
      if (risk >= perCandidateLoss) {
        verdict = 'loss-limit';
        reason = 'This arm exhausted its equal share of the wave loss boundary.';
      } else if (
        evidence.attributedPurchases >= 10 &&
        cpa !== null &&
        cpa <= affordable * 0.9 &&
        contribution > 0
      ) {
        verdict = 'promising';
        reason = 'Mature purchases clear the affordable-acquisition hurdle with headroom.';
      } else if (
        evidence.attributedPurchases >= 5 &&
        cpa !== null &&
        cpa <= affordable &&
        contribution > 0
      ) {
        verdict = 'viable';
        reason = 'The arm clears the hurdle but needs confirmation before promotion.';
      } else if (
        (evidence.attributedPurchases === 0 && evidence.spendCents >= affordable * 3) ||
        contribution <= -perCandidateLoss
      ) {
        verdict = 'below-hurdle';
        reason = 'Mature spend is below the item economics hurdle.';
      } else if (!facts.length || (evidence.clicks < 10 && evidence.attributedPurchases < 3)) {
        reason = 'The complete window contains too little response for a reliable screen.';
      }
      return {
        candidateId: candidate.id,
        label: candidate.label,
        ...evidence,
        costPerPurchaseCents: cpa,
        screeningContributionCents: contribution,
        riskCents: risk,
        evidenceRows: facts.length,
        sourceFingerprint: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
        verdict,
        reason,
      };
    });
    const leading = results
      .filter((result) => result.verdict === 'promising')
      .sort(
        (a, b) =>
          b.screeningContributionCents - a.screeningContributionCents ||
          (a.costPerPurchaseCents || Number.MAX_SAFE_INTEGER) -
            (b.costPerPurchaseCents || Number.MAX_SAFE_INTEGER),
      )[0];
    if (leading) {
      leading.verdict = 'winner';
      leading.reason = 'This is the strongest mature screening arm; confirmation is still required.';
    }
    const totalSpendCents = results.reduce((sum, result) => sum + result.spendCents, 0);
    const totalRiskCents = results.reduce((sum, result) => sum + result.riskCents, 0);
    const held = plan.candidates.some((candidate) => candidate.status === 'held');
    const recommendation =
      totalRiskCents >= wave.lossBudgetCents
        ? 'stop'
        : leading
          ? held
            ? 'next-wave'
            : 'complete'
          : held
            ? 'next-wave'
            : 'inconclusive';
    const reason =
      recommendation === 'stop'
        ? 'The registered wave loss boundary is exhausted.'
        : leading
          ? held
            ? 'Keep the screening leader as a control and introduce the next held candidates.'
            : 'The library is exhausted; complete or stop after operator review.'
          : held
            ? 'No winner emerged; a fresh bounded wave can test the remaining library.'
            : 'The library ended without enough evidence for a winner.';
    const evaluatedAt = this.clock().toISOString();
    const decided: ProfitTestWave = {
      ...wave,
      status: 'decided',
      results,
      totalSpendCents,
      totalRiskCents,
      recommendation,
      reason,
      evaluatedAt,
      evidenceFingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            economics,
            assetVersions: wave.assetVersions,
            window: [wave.startDate, wave.endDate, wave.attributionDays, wave.reportingTimezone],
            bindings: candidates.map((candidate) => candidate.binding),
            results,
          }),
        )
        .digest('hex'),
      updatedAt: evaluatedAt,
    };
    const verdicts = new Map(results.map((result) => [result.candidateId, result.verdict]));
    const updatedPlan: ProfitTestPlan = {
      ...plan,
      candidates: plan.candidates.map((candidate) => {
        const verdict = verdicts.get(candidate.id);
        if (!verdict) return candidate;
        return {
          ...candidate,
          status:
            verdict === 'winner'
              ? 'winner'
              : verdict === 'loss-limit' || verdict === 'below-hurdle'
                ? 'rejected'
                : 'completed',
        };
      }),
      waves: plan.waves.map((candidate) => (candidate.id === wave.id ? decided : candidate)),
      updatedAt: evaluatedAt,
    };
    this.store.transaction(() => {
      this.saveWave(decided);
      this.saveTest(updatedPlan);
      this.repository.event(
        null,
        dataset,
        clientId,
        'profit.test.wave.evaluated',
        `${plan.itemName}: wave ${wave.sequence} produced ${leading ? 'a screening leader' : 'no winner'} with ${totalRiskCents} cents of modeled risk.`,
        this.clock(),
      );
    });
    return decided;
  }

  advanceTest(
    dataset: 'workspace',
    clientId: string,
    testId: string,
    waveId: string,
    action: 'next-wave' | 'complete' | 'stop',
  ): ProfitTestPlan {
    const plan = this.test(dataset, clientId, testId);
    if (plan.status === 'completed') return plan;
    const wave = plan.waves.find((candidate) => candidate.id === waveId);
    if (!wave || wave.status !== 'decided')
      throw new AppError('Evaluate the current wave before recording a next decision.', 409);
    if (plan.waves.at(-1)?.id !== wave.id)
      throw new AppError('A later wave already exists for this test.', 409);
    const now = this.clock().toISOString();
    if (action !== 'next-wave') {
      const winner = wave.results.find((result) => result.verdict === 'winner');
      const completed: ProfitTestPlan = {
        ...plan,
        status: 'completed',
        outcome:
          wave.recommendation === 'stop'
            ? 'loss-limit'
            : action === 'stop'
              ? 'stopped'
              : winner
                ? 'winner'
                : 'inconclusive',
        candidates: plan.candidates.map((candidate) => ({
          ...candidate,
          status:
            candidate.status === 'winner'
              ? 'winner'
              : candidate.status === 'rejected'
                ? 'rejected'
                : 'completed',
        })),
        updatedAt: now,
      };
      this.store.transaction(() => {
        this.saveTest(completed);
        this.repository.event(
          null,
          dataset,
          clientId,
          'profit.test.completed',
          `${plan.itemName}: test completed with outcome ${completed.outcome}.`,
          this.clock(),
        );
      });
      return completed;
    }
    if (wave.recommendation === 'stop')
      throw new AppError('The wave loss boundary is exhausted; another wave cannot be staged.');
    const totalRisk = plan.waves.reduce((sum, candidate) => sum + candidate.totalRiskCents, 0);
    if (totalRisk >= plan.lossBudgetCents)
      throw new AppError('The test loss boundary is exhausted; another wave cannot be reserved.');
    const leader = wave.results.find((result) => result.verdict === 'winner')?.candidateId;
    const held = plan.candidates.filter((candidate) => candidate.status === 'held');
    const nextIds = [
      ...(leader ? [leader] : []),
      ...held.slice(0, plan.maxConcurrent - (leader ? 1 : 0)).map((candidate) => candidate.id),
    ];
    if (nextIds.length < 2)
      throw new AppError('Fewer than two eligible arms remain; complete this test instead.');
    const nextWave: ProfitTestWave = {
      id: randomUUID(),
      dataset,
      clientId,
      testId: plan.id,
      sequence: wave.sequence + 1,
      status: 'setup',
      registration: null,
      candidateIds: nextIds,
      assetVersions: [],
      economics: null,
      reportingTimezone: null,
      lossBudgetCents: 0,
      startDate: null,
      endDate: null,
      attributionDays: null,
      expectedMatureAt: null,
      launchedAt: null,
      evaluatedAt: null,
      results: [],
      totalSpendCents: 0,
      totalRiskCents: 0,
      recommendation: null,
      reason: leader
        ? 'The prior screening leader remains as the control against new challengers.'
        : 'A fresh bounded set was selected after an inconclusive wave.',
      evidenceFingerprint: null,
      createdAt: now,
      updatedAt: now,
    };
    const nextPlan: ProfitTestPlan = {
      ...plan,
      status: 'ready',
      candidates: plan.candidates.map((candidate) => ({
        ...candidate,
        status: nextIds.includes(candidate.id)
          ? 'active'
          : candidate.status === 'held'
            ? 'held'
            : candidate.status === 'rejected'
              ? 'rejected'
              : 'completed',
      })),
      waves: [...plan.waves, nextWave],
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.saveWave(nextWave);
      this.saveTest(nextPlan);
      this.repository.event(
        null,
        dataset,
        clientId,
        'profit.test.wave.advanced',
        `${plan.itemName}: wave ${nextWave.sequence} staged with ${nextIds.length} arms; no platform action.`,
        this.clock(),
      );
    });
    return nextPlan;
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
          connection.health.status !== 'healthy' ||
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
      assets: this.assets(dataset, activeClientId),
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
