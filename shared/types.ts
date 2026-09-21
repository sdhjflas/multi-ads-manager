export type Vertical = 'commerce' | 'books';
export type Dataset = 'demo' | 'workspace';
export type Channel = 'meta' | 'amazon' | 'tiktok';
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
  provider: 'structured-planner' | 'openai';
  variants: Variant[];
  createdAt: string;
  sourceTargetId?: string;
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
}
