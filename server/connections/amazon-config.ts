import type { Dataset } from '../../shared/types.js';
import { AmazonAdsConnector, amazonConfigFromEnv, type AmazonConfig } from '../connectors/amazon.js';
import type { Store } from '../store.js';
import { vaultFromEnv } from '../security/vault.js';
import type { AmazonAdsCredential } from './amazon-ads.js';
import { ConnectionRepository } from './repository.js';

export interface AmazonCredentialSource {
  config: AmazonConfig;
  source: 'environment' | 'connection';
  connectionId: string | null;
}

export function amazonCredentialSources(
  store: Store,
  dataset: Dataset,
  profileId = '',
): AmazonCredentialSource[] {
  const result: AmazonCredentialSource[] = [];
  const environment = amazonConfigFromEnv(profileId);
  if (environment)
    result.push({ config: environment, source: 'environment', connectionId: null });
  const vault = vaultFromEnv();
  if (!vault) return result;
  const repository = new ConnectionRepository(store, vault);
  // The existing Brain tables are dataset-scoped. Until they carry client_id, only
  // the bootstrap client's authorization may feed that legacy execution path.
  const client = repository.ensureDefaultClient(dataset);
  for (const connection of repository.connections(dataset, client.id)) {
    if (
      connection.provider !== 'amazon-ads' ||
      connection.authMode === 'environment' ||
      !connection.secretConfigured ||
      (profileId && connection.externalAccountId !== profileId)
    )
      continue;
    try {
      const credential = repository.secret<AmazonAdsCredential>(connection);
      result.push({
        source: 'connection',
        connectionId: connection.id,
        config: {
          ...credential,
          profileId: profileId || connection.externalAccountId || '',
          writesEnabled: false,
          timezone: connection.timezone || undefined,
        },
      });
    } catch {
      // A key rotation or locally revoked secret is surfaced on the connection card.
    }
  }
  return result;
}

export function amazonConfigFor(
  store: Store,
  dataset: Dataset,
  profileId: string,
): AmazonConfig | null {
  return amazonCredentialSources(store, dataset, profileId)[0]?.config || null;
}

export async function discoverAmazonProfiles(store: Store, fetcher: typeof fetch = fetch) {
  const all = [] as Awaited<ReturnType<AmazonAdsConnector['listProfiles']>>;
  const regions = new Set<string>();
  const seen = new Set<string>();
  for (const source of amazonCredentialSources(store, 'workspace')) {
    regions.add(source.config.region);
    for (const profile of await new AmazonAdsConnector(source.config, fetcher).listProfiles())
      if (!seen.has(profile.profileId)) {
        seen.add(profile.profileId);
        all.push(profile);
      }
  }
  return { profiles: all, region: [...regions].join(', ') || null };
}

export function amazonConnectionConfigured(store: Store) {
  return amazonCredentialSources(store, 'workspace').length > 0;
}
