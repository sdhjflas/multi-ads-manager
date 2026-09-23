import type { ClientWorkspace, SourceProvider } from './connections.js';
import type { Dataset } from './types.js';

export type ProfitVertical = 'commerce' | 'books';

export interface ProfitEconomics {
  versionId: string;
  effectiveAt: string;
  retailPriceCents: number;
  netReceiptCents: number;
  variableCostCents: number;
  profitReserveCents: number;
  lossLimitCents: number;
  dailyBudgetLimitCents: number;
  verified: boolean;
  note: string;
}

export interface ProfitItem {
  id: string;
  dataset: Dataset;
  clientId: string;
  vertical: ProfitVertical;
  identityKey: string;
  name: string;
  sku: string | null;
  isbn: string | null;
  asin: string | null;
  active: boolean;
  economics: ProfitEconomics;
  createdAt: string;
  updatedAt: string;
}

export interface ProfitMapping {
  id: string;
  dataset: Dataset;
  clientId: string;
  connectionId: string;
  provider: SourceProvider;
  sourceKind: string;
  externalId: string;
  sourceName: string;
  itemId: string;
  createdAt: string;
}

export interface MappingCandidate {
  connectionId: string;
  connectionName: string;
  provider: SourceProvider;
  sourceKind: string;
  externalId: string;
  sourceName: string;
  identityHint: string | null;
  suggestedItemId: string | null;
  mappedItemId: string | null;
}

export type ProfitDecision = 'blocked' | 'observe' | 'test' | 'scale' | 'stop';

export interface ProfitItemView extends ProfitItem {
  mappings: ProfitMapping[];
  evidence: {
    spendCents: number;
    attributedRevenueCents: number;
    attributedPurchases: number;
    independentReceiptsCents: number;
    independentUnits: number;
    refundsCents: number;
    sourceAsOf: string | null;
  };
  affordableAcquisitionCents: number | null;
  screeningContributionCents: number | null;
  remainingLossCents: number | null;
  decision: ProfitDecision;
  reason: string;
  proposedDailyBudgetCents: number;
  blockers: string[];
}

export interface ProfitBudgetPool {
  id: string;
  dataset: Dataset;
  clientId: string;
  name: string;
  vertical: ProfitVertical | 'all';
  dailyLimitCents: number;
  learningLimitCents: number;
  reservePercent: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OptimizerAllocation {
  itemId: string;
  itemName: string;
  decision: ProfitDecision;
  allocatedDailyCents: number;
  score: number;
  reason: string;
}

export interface OptimizerRun {
  id: string;
  dataset: Dataset;
  clientId: string;
  poolId: string;
  mode: 'shadow';
  totalAllocatedCents: number;
  unallocatedCents: number;
  allocations: OptimizerAllocation[];
  evidenceFingerprint: string;
  createdAt: string;
}

export interface ProfitTestCandidate {
  id: string;
  label: string;
  kind: 'keyword' | 'product-target' | 'hook' | 'headline' | 'audience' | 'landing-page';
  provenance: string;
  status: 'queued' | 'active' | 'held' | 'rejected';
}

export interface ProfitTestPlan {
  id: string;
  dataset: Dataset;
  clientId: string;
  itemId: string;
  itemName: string;
  hypothesis: string;
  variable: ProfitTestCandidate['kind'];
  lossBudgetCents: number;
  maxConcurrent: number;
  status: 'draft' | 'ready' | 'running' | 'completed' | 'cancelled';
  assetEvidenceApproved: boolean;
  candidates: ProfitTestCandidate[];
  createdAt: string;
  updatedAt: string;
}

export interface ProfitControlView {
  dataset: Dataset;
  clients: ClientWorkspace[];
  activeClientId: string;
  items: ProfitItemView[];
  candidates: MappingCandidate[];
  pools: ProfitBudgetPool[];
  runs: OptimizerRun[];
  tests: ProfitTestPlan[];
  readiness: {
    ready: boolean;
    checks: Array<{ key: string; label: string; ready: boolean; detail: string }>;
  };
  summary: {
    items: number;
    verified: number;
    mapped: number;
    mappingGaps: number;
    scaleCandidates: number;
    stopCandidates: number;
    spendCents: number;
    independentReceiptsCents: number;
  };
}
