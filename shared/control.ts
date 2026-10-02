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

export type ProfitAssetKind = 'image' | 'video' | 'copy' | 'landing-page';

export interface ProfitAsset {
  id: string;
  dataset: Dataset;
  clientId: string;
  itemId: string;
  itemName: string;
  kind: ProfitAssetKind;
  name: string;
  version: number;
  contentHash: string;
  sourceRef: string;
  status: 'draft' | 'approved' | 'superseded';
  rightsApproved: boolean;
  claimsApproved: boolean;
  evidenceApproved: boolean;
  approvalNote: string;
  supersedesId: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface ProfitCandidateBinding {
  id: string;
  dataset: Dataset;
  clientId: string;
  testId: string;
  candidateId: string;
  connectionId: string;
  provider: SourceProvider;
  sourceKind: 'ad' | 'keyword' | 'product-target';
  externalId: string;
  sourceName: string;
  parentCampaignId: string;
  variant: string | null;
  createdAt: string;
}

export interface ProfitExperimentSource {
  connectionId: string;
  connectionName: string;
  provider: SourceProvider;
  sourceKind: ProfitCandidateBinding['sourceKind'];
  externalId: string;
  sourceName: string;
  parentCampaignId: string;
  variant: string | null;
}

export type ProfitCandidateVerdict =
  | 'winner'
  | 'promising'
  | 'viable'
  | 'inconclusive'
  | 'below-hurdle'
  | 'loss-limit';

export interface ProfitCandidateResult {
  candidateId: string;
  label: string;
  impressions: number;
  clicks: number;
  spendCents: number;
  attributedPurchases: number;
  attributedRevenueCents: number;
  costPerPurchaseCents: number | null;
  screeningContributionCents: number;
  riskCents: number;
  evidenceRows: number;
  sourceFingerprint: string;
  verdict: ProfitCandidateVerdict;
  reason: string;
}

export interface ProfitWaveAsset {
  id: string;
  kind: ProfitAssetKind;
  name: string;
  version: number;
  contentHash: string;
}

export interface ProfitTestWave {
  id: string;
  dataset: Dataset;
  clientId: string;
  testId: string;
  sequence: number;
  status: 'setup' | 'running' | 'decided' | 'cancelled';
  registration: 'prospective' | 'historical' | null;
  candidateIds: string[];
  assetVersions: ProfitWaveAsset[];
  economics: ProfitEconomics | null;
  reportingTimezone: string | null;
  lossBudgetCents: number;
  startDate: string | null;
  endDate: string | null;
  attributionDays: number | null;
  expectedMatureAt: string | null;
  launchedAt: string | null;
  evaluatedAt: string | null;
  results: ProfitCandidateResult[];
  totalSpendCents: number;
  totalRiskCents: number;
  recommendation: 'next-wave' | 'complete' | 'stop' | 'inconclusive' | null;
  reason: string;
  evidenceFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfitTestCandidate {
  id: string;
  label: string;
  kind: 'keyword' | 'product-target' | 'hook' | 'headline' | 'audience' | 'landing-page';
  provenance: string;
  status: 'queued' | 'active' | 'held' | 'rejected' | 'winner' | 'completed';
  binding: ProfitCandidateBinding | null;
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
  assetIds: string[];
  candidates: ProfitTestCandidate[];
  waves: ProfitTestWave[];
  outcome: 'winner' | 'inconclusive' | 'loss-limit' | 'stopped' | null;
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
  assets: ProfitAsset[];
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
