import type { ConnectionCounts, SourceConnection } from '../../shared/connections.js';
import type { SourceObject } from './repository.js';

export interface ProviderIdentity {
  externalAccountId: string;
  externalAccountName: string;
  currency: string | null;
  timezone: string | null;
  region: string | null;
  scopes?: string[];
}

export interface ProviderSyncResult {
  identity: ProviderIdentity;
  objects: Record<string, SourceObject[]>;
  counts: Partial<ConnectionCounts>;
  watermark: string | null;
  sourceAsOf: string | null;
  warnings: string[];
  pending?: boolean;
  retryAfterMs?: number;
}

export interface ProviderObserver {
  collect(connection: SourceConnection, since: string | null): Promise<ProviderSyncResult>;
}
