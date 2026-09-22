export type Vertical = 'commerce' | 'books';
export type Dataset = 'demo' | 'workspace';
export type Channel = 'meta' | 'amazon' | 'tiktok';

export interface ReportSource {
  id: string;
  dataset: Dataset;
  name: string;
  provider: Channel;
  accountRef: string;
  profile: 'orbit-campaigns' | 'orbit-targets' | 'amazon-campaigns';
  attributionDays: number;
  currency: 'USD';
  timezone: 'UTC';
  mappings: { externalCampaignId: string; campaignId: string }[];
  contractId: string;
  createdAt: string;
}

export interface ReportChangeCounts {
  inserted: number;
  corrected: number;
  refreshed: number;
  unchanged: number;
}

export interface ReportPreview {
  fingerprint: string;
  counts: ReportChangeCounts;
  rows: number;
  campaignCount: number;
  targetCount: number;
  spendCents: number;
  campaignSpendDeltaCents: number | null;
  startDate: string;
  endDate: string;
  errors: string[];
  warnings: string[];
  affectedLearningIds: string[];
  campaigns: {
    campaignId: string;
    name: string;
    rowCount: number;
    targetCount: number;
    counts: ReportChangeCounts;
    missingDays: number;
    spendCents: number;
  }[];
}

export interface ReportReceipt {
  id: string;
  dataset: Dataset;
  sourceId: string;
  sourceName: string;
  fileName: string;
  exportedAt: string;
  createdAt: string;
  committedAt?: string;
  status: 'staged' | 'committed' | 'discarded';
  contentHash: string;
  sourceContractId: string;
  preview: ReportPreview;
}

export interface ReportRevision {
  campaignId: string;
  targetId: string | null;
  label: string;
  date: string;
  before: Observation | null;
  after: Observation;
}
export type DecisionKind = 'scale' | 'reduce' | 'explore' | 'hold' | 'repair';

export interface Campaign {
  id: string;
  dataset: Dataset;
  name: string;
  vertical: Vertical;
  channel: Channel;
  entityName: string;
  accountName: string;
  status: 'draft' | 'observing' | 'paused';
  currency: 'USD';
  retailPriceCents: number;
  netReceiptCents: number;
  variableCostCents: number;
  targetProfitCents: number;
  dailyBudgetCents: number;
  totalLearningBudgetCents: number;
  attributionDays: number;
  economicsVerified: boolean;
  trackingVerified: boolean;
  supplyReady: boolean;
  /** Operator-written description of the item, used as untrusted AI context. */
  brief?: string;
  createdAt: string;
}

export interface Observation {
  campaignId: string;
  date: string;
  impressions: number;
  clicks: number;
  orders: number;
  spendCents: number;
  salesCents: number;
  refundsCents: number;
  observedAt: string;
}

export interface Metrics {
  impressions: number;
  clicks: number;
  orders: number;
  spendCents: number;
  salesCents: number;
  refundsCents: number;
  contributionCents: number | null;
  roas: number | null;
  acos: number | null;
  cpcCents: number | null;
  cpaCents: number | null;
}

export interface Decision {
  kind: DecisionKind;
  title: string;
  reason: string;
  blockers: string[];
  probabilityProfitable: number | null;
  suggestedDailyBudgetCents: number | null;
  maxAffordableCpcCents: number | null;
  matureClicks: number;
  matureOrders: number;
  matureThrough: string;
  evidenceId: string;
}

export interface CampaignView extends Campaign {
  metrics: Metrics;
  decision: Decision;
  breakEvenAcos: number | null;
  breakEvenRoas: number | null;
  unitContributionCents: number | null;
  sparkline: number[];
}

export interface Variant {
  id: string;
  label: string;
  hypothesis: string;
  variable: string;
  value: string;
  state: 'queued' | 'shortlisted';
}

export interface Experiment {
  id: string;
  dataset: Dataset;
  campaignId: string;
  name: string;
  hypothesis: string;
  variable: string;
  budgetCents: number;
  maxConcurrent: number;
  status: 'draft' | 'review';
  provider: 'structured-planner' | 'ai';
  variants: Variant[];
  createdAt: string;
  sourceTargetId?: string;
  sourceLearningId?: string;
}

export interface WaveArm {
  role: 'baseline' | 'challenger';
  target: Target;
  candidate: Variant | null;
}

export interface TestWave {
  id: string;
  dataset: Dataset;
  campaignId: string;
  experimentId: string;
  name: string;
  hypothesis: string;
  registration: 'prospective' | 'retrospective';
  mappingVerified: true;
  startDate: string;
  endDate: string;
  budgetCents: number;
  lossLimitCents: number;
  minClicksPerArm: number;
  minLiftCentsPer100Clicks: number;
  arms: WaveArm[];
  campaignSnapshot: Campaign;
  planId: string;
  status: 'measuring' | 'closed' | 'cancelled';
  latestLearningId?: string;
  createdAt: string;
  closedAt?: string;
}

export type WaveOutcome =
  | 'scheduled'
  | 'collecting'
  | 'repair'
  | 'limit-reached'
  | 'promising'
  | 'baseline-leading'
  | 'unprofitable'
  | 'inconclusive';

export interface ArmResult {
  targetId: string;
  label: string;
  role: WaveArm['role'];
  observed: Metrics;
  mature: Metrics;
  coveredDays: number;
  expectedDays: number;
  matureDays: number;
  probabilityProfitable: number | null;
  // Conditional on fixed observed CPC, refund rate, and snapshotted unit economics.
  contributionPer100Clicks: { mean: number; lower: number; upper: number } | null;
}

export interface WaveEvaluation {
  evidenceId: string;
  dataId: string;
  evaluatedAt: string;
  matureThrough: string;
  outcome: WaveOutcome;
  title: string;
  reason: string;
  blockers: string[];
  arms: ArmResult[];
  spentCents: number;
  matureLossCents: number;
  remainingPlanCents: number;
  promisingTargetId: string | null;
  canRecord: boolean;
}

export interface WaveView extends TestWave {
  evaluation: WaveEvaluation;
}

export interface Learning {
  id: string;
  dataset: Dataset;
  campaignId: string;
  experimentId: string;
  waveId: string;
  waveName: string;
  entityName: string;
  vertical: Vertical;
  hypothesis: string;
  notes: string;
  result: WaveEvaluation;
  promisingCandidate: Variant | null;
  supersedesId?: string;
  createdAt: string;
}

export interface LearningView extends Learning {
  evidenceChanged: boolean;
  superseded: boolean;
}

export interface Activity {
  id: string;
  dataset: Dataset;
  kind: 'experiment' | 'import' | 'decision' | 'system' | 'campaign' | 'ai';
  title: string;
  detail: string;
  createdAt: string;
}

export interface Review {
  id: string;
  campaignId: string;
  dataset: Dataset;
  evidenceId: string;
  action: 'accepted' | 'dismissed';
  createdAt: string;
}

export interface Target {
  id: string;
  campaignId: string;
  sourceId: string;
  label: string;
  kind: 'keyword' | 'product-target' | 'creative';
  matchType: 'exact' | 'phrase' | 'broad' | 'auto' | 'product' | 'creative';
}

export interface TargetView extends Target {
  campaignName: string;
  channel: Channel;
  metrics: Metrics;
  signal: {
    kind: 'harvest' | 'confirm' | 'review-waste' | 'hold' | 'repair';
    title: string;
    reason: string;
    probabilityProfitable: number | null;
    matureClicks: number;
    matureOrders: number;
    matureThrough: string;
    maxAffordableCpcCents: number | null;
  };
}

export interface Dashboard {
  dataset: Dataset;
  generatedAt: string;
  reportingAt: string;
  days: number;
  campaigns: CampaignView[];
  experiments: Experiment[];
  activity: Activity[];
  reviews: Review[];
  targets: TargetView[];
  waves: WaveView[];
  learnings: LearningView[];
  summary: Metrics;
  previous: Metrics;
  comparisonComplete: boolean;
  series: {
    date: string;
    spendCents: number;
    contributionCents: number | null;
    salesCents: number;
  }[];
  ai: { configured: boolean; dailyLimit: number; requestsToday: number };
  integrations: {
    amazonAds: { configured: boolean; writesEnabled: boolean };
    anthropic: boolean;
    openai: boolean;
  };
}

// ---------------------------------------------------------------------------
// The brain: connected accounts, platform state, search terms, proposals,
// execution, and the business ledger.
// ---------------------------------------------------------------------------

export type ConnectorKind = 'sandbox' | 'amazon-ads';
export type OperatingMode = 'observe' | 'recommend' | 'supervised' | 'bounded';
export type ActionClass =
  'harvest' | 'negative' | 'bid-up' | 'bid-down' | 'pause' | 'budget-up' | 'budget-down';
export const actionClasses: ActionClass[] = [
  'harvest',
  'negative',
  'bid-up',
  'bid-down',
  'pause',
  'budget-up',
  'budget-down',
];

export interface Policy {
  version: string;
  mode: OperatingMode;
  killSwitch: boolean;
  autoSync: boolean;
  aiReview: boolean;
  /** Action classes a bounded policy may authorize without an operator. */
  allowedClasses: ActionClass[];
  maxBidCents: number;
  maxBidStepPct: number;
  maxDailyBudgetCents: number;
  maxBudgetStepPct: number;
  /** Additional daily exposure that reserved and applied actions may add per UTC day. */
  maxDailyCommitmentCents: number;
  cooldownHours: number;
  maxActionsPerRun: number;
  maxEvidenceAgeHours: number;
  harvestMinClicks: number;
  harvestMinOrders: number;
  negativeMinClicks: number;
  negativeMaxProbability: number;
  bidMinClicks: number;
}

export type SyncStatus = 'never' | 'ok' | 'partial' | 'stale' | 'throttled' | 'error';
export interface SyncHealth {
  status: SyncStatus;
  message: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  watermarkDate: string | null;
  coverage: { campaigns: number; keywords: number; negatives: number; searchTerms: number };
}

export interface AdAccount {
  id: string;
  dataset: Dataset;
  provider: Channel;
  connector: ConnectorKind;
  name: string;
  profileId: string;
  marketplace: string;
  currency: 'USD';
  timezone: 'UTC';
  attributionDays: number;
  policy: Policy;
  health: SyncHealth;
  createdAt: string;
}

export interface AccountLink {
  campaignId: string;
  accountId: string;
  externalCampaignId: string;
  adGroupExternalId: string;
}

export type PlatformState = 'enabled' | 'paused' | 'archived';
export interface PlatformCampaign {
  externalId: string;
  name: string;
  state: PlatformState;
  dailyBudgetCents: number;
  targetingType: 'auto' | 'manual';
}
export interface PlatformAdGroup {
  externalId: string;
  campaignExternalId: string;
  name: string;
  state: PlatformState;
  defaultBidCents: number;
}
export type KeywordMatch = 'exact' | 'phrase' | 'broad';
export interface PlatformKeyword {
  externalId: string;
  campaignExternalId: string;
  adGroupExternalId: string;
  text: string;
  matchType: KeywordMatch;
  state: PlatformState;
  bidCents: number;
}
export type NegativeMatch = 'negative-exact' | 'negative-phrase';
export interface PlatformNegativeKeyword {
  externalId: string;
  campaignExternalId: string;
  adGroupExternalId: string | null;
  text: string;
  matchType: NegativeMatch;
  state: PlatformState;
}
export interface PlatformSnapshot {
  observedAt: string;
  campaigns: PlatformCampaign[];
  adGroups: PlatformAdGroup[];
  keywords: PlatformKeyword[];
  negatives: PlatformNegativeKeyword[];
}

export interface SearchTerm {
  id: string;
  campaignId: string;
  term: string;
  keywordExternalId: string;
  keywordText: string;
  matchType: KeywordMatch | 'auto';
  adGroupExternalId: string;
}
export type TermSignal = 'harvest' | 'negative' | 'hold' | 'blocked' | 'already-exact';
export type Relevance = 'high' | 'medium' | 'low' | 'irrelevant';
export interface SearchTermView extends SearchTerm {
  campaignName: string;
  metrics: Metrics;
  mature: { clicks: number; orders: number; spendCents: number; salesCents: number };
  probabilityProfitable: number | null;
  affordableCpcCents: number | null;
  signal: TermSignal;
  reason: string;
  relevance: { level: Relevance; reason: string } | null;
}

export type ProposalAction =
  | {
      type: 'create-keyword';
      adGroupExternalId: string;
      keywordText: string;
      matchType: 'exact';
      bidCents: number;
    }
  | {
      type: 'create-negative-keyword';
      adGroupExternalId: string;
      keywordText: string;
      matchType: 'negative-exact';
    }
  | { type: 'update-keyword-bid'; keywordExternalId: string; fromCents: number; toCents: number }
  | { type: 'update-keyword-state'; keywordExternalId: string; from: PlatformState; to: 'paused' }
  | {
      type: 'update-campaign-budget';
      externalCampaignId: string;
      fromCents: number;
      toCents: number;
    };

export type ProposalStatus =
  | 'proposed'
  | 'authorized'
  | 'rejected'
  | 'reserved'
  | 'sending'
  | 'uncertain'
  | 'applied'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface ProposalEvidence {
  evidenceId: string;
  sourceLabel: string;
  matureThrough: string;
  matureClicks: number;
  matureOrders: number;
  spendCents: number;
  salesCents: number;
  cpcCents: number | null;
  probabilityProfitable: number | null;
  affordableCpcCents: number | null;
  observedAt: string;
}

export interface Proposal {
  id: string;
  dataset: Dataset;
  accountId: string;
  campaignId: string;
  campaignName: string;
  actionClass: ActionClass;
  action: ProposalAction;
  targetRef: string;
  title: string;
  reason: string;
  evidence: ProposalEvidence;
  expectedPriorState: Record<string, string | number | null>;
  maxCommitmentCents: number;
  status: ProposalStatus;
  needsReview: boolean;
  relevance: { level: Relevance; reason: string } | null;
  policyVersion: string;
  idempotencyKey: string;
  authorization: { by: 'operator' | 'policy'; at: string; policyVersion: string } | null;
  readBack: Record<string, string | number | null> | null;
  history: { at: string; status: ProposalStatus; note: string }[];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAttempt {
  id: string;
  proposalId: string;
  accountId: string;
  dataset: Dataset;
  idempotencyKey: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'applied' | 'uncertain' | 'failed' | 'reconciled' | null;
  note: string;
}

export interface SyncRun {
  id: string;
  accountId: string;
  dataset: Dataset;
  startedAt: string;
  finishedAt: string;
  status: SyncStatus;
  message: string;
  startDate: string;
  endDate: string;
  rows: { campaigns: number; keywords: number; searchTerms: number };
}

export interface LedgerEntry {
  campaignId: string;
  date: string;
  units: number;
  netReceiptsCents: number;
  refundsCents: number;
  observedAt: string;
}

export interface Scorecard {
  campaignId: string;
  campaignName: string;
  entityName: string;
  linked: boolean;
  platformState: PlatformState | null;
  platformDailyBudgetCents: number | null;
  metrics: Metrics;
  breakEvenAcos: number | null;
  targetAcos: number | null;
  keywords: number;
  searchTerms: number;
  ledger: { units: number; netReceiptsCents: number; refundsCents: number; days: number } | null;
  /** Ledger receipts minus variable costs, refunds, and ad spend over the selected days. */
  ledgerContributionCents: number | null;
  decision: Decision;
  openProposals: number;
}

export interface BrainView {
  dataset: Dataset;
  generatedAt: string;
  days: number;
  accounts: AdAccount[];
  links: AccountLink[];
  platform: Record<string, PlatformSnapshot>;
  scorecards: Scorecard[];
  proposals: Proposal[];
  searchTerms: SearchTermView[];
  executions: ExecutionAttempt[];
  syncRuns: SyncRun[];
  ai: {
    provider: 'anthropic' | 'openai' | null;
    model: string | null;
    requestsToday: number;
    dailyLimit: number;
  };
  integrations: {
    amazonAds: { configured: boolean; writesEnabled: boolean };
    anthropic: boolean;
    openai: boolean;
  };
}
