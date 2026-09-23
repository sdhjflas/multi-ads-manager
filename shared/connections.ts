import type { Dataset } from './types.js';

export const sourceProviders = ['shopify', 'meta-ads', 'amazon-ads', 'pbs'] as const;
export type SourceProvider = (typeof sourceProviders)[number];

export type ConnectionStatus =
  | 'setup'
  | 'authorizing'
  | 'connected'
  | 'syncing'
  | 'healthy'
  | 'partial'
  | 'stale'
  | 'error'
  | 'reauthorize';

export type ConnectionAuthMode = 'oauth' | 'token' | 'environment';
export type ConnectionJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'dead-letter';

export interface ClientWorkspace {
  id: string;
  dataset: Dataset;
  name: string;
  createdAt: string;
}

export interface ConnectionCapability {
  key: string;
  label: string;
  state: 'ready' | 'pending' | 'blocked';
  detail: string;
}

export interface ConnectionCounts {
  accounts: number;
  campaigns: number;
  adSets: number;
  adGroups: number;
  ads: number;
  creatives: number;
  insights: number;
  keywords: number;
  targets: number;
  negatives: number;
  products: number;
  variants: number;
  orders: number;
  refunds: number;
  books: number;
  settlements: number;
  unmapped: number;
}

export interface ConnectionHealth {
  status: ConnectionStatus;
  message: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  watermark: string | null;
  sourceAsOf: string | null;
  nextSyncAt: string | null;
  counts: ConnectionCounts;
}

export interface SourceConnection {
  id: string;
  dataset: Dataset;
  clientId: string;
  provider: SourceProvider;
  name: string;
  authMode: ConnectionAuthMode;
  externalAccountId: string | null;
  externalAccountName: string | null;
  region: string | null;
  currency: string | null;
  timezone: string | null;
  scopes: string[];
  readOnly: true;
  secretConfigured: boolean;
  capabilities: ConnectionCapability[];
  health: ConnectionHealth;
  resourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionJob {
  id: string;
  dataset: Dataset;
  clientId: string;
  connectionId: string;
  provider: SourceProvider;
  kind: 'full-sync' | 'oauth-callback' | 'webhook' | 'reconcile' | 'backfill' | 'retry';
  status: ConnectionJobStatus;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  cursor: string | null;
  counts: Partial<ConnectionCounts>;
  message: string;
  errorKind: 'auth' | 'throttled' | 'timeout' | 'invalid' | 'unavailable' | null;
  nextAttemptAt?: string | null;
  maxAttempts?: number;
}

export interface ConnectionAuditEvent {
  id: string;
  dataset: Dataset;
  clientId: string;
  connectionId: string | null;
  action: string;
  detail: string;
  createdAt: string;
}

export interface ConnectionsView {
  dataset: Dataset;
  clients: ClientWorkspace[];
  activeClientId: string;
  connections: SourceConnection[];
  jobs: ConnectionJob[];
  events: ConnectionAuditEvent[];
  security: {
    mode: 'local-operator';
    vaultConfigured: boolean;
    credentialsReturnedToBrowser: false;
    readOnly: true;
  };
  summary: {
    healthy: number;
    attention: number;
    syncing: number;
    lastSuccessAt: string | null;
  };
}

export const emptyConnectionCounts = (): ConnectionCounts => ({
  accounts: 0,
  campaigns: 0,
  adSets: 0,
  adGroups: 0,
  ads: 0,
  creatives: 0,
  insights: 0,
  keywords: 0,
  targets: 0,
  negatives: 0,
  products: 0,
  variants: 0,
  orders: 0,
  refunds: 0,
  books: 0,
  settlements: 0,
  unmapped: 0,
});
