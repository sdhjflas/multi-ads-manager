import { createHash, randomUUID } from 'node:crypto';
import type {
  ClientWorkspace,
  ConnectionAuditEvent,
  ConnectionJob,
  SourceConnection,
  SourceProvider,
} from '../../shared/connections.js';
import type { Dataset } from '../../shared/types.js';
import { AppError } from '../validation.js';
import type { Store } from '../store.js';
import type { CredentialVault, EncryptedSecret } from '../security/vault.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface SourceObject<T = unknown> {
  kind: string;
  externalId: string;
  observedAt: string;
  value: T;
}

export class ConnectionRepository {
  constructor(
    readonly store: Store,
    readonly vault: CredentialVault | null,
    readonly operatorId = 'local-operator',
  ) {
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(operatorId))
      throw new AppError('Operator identity is invalid.', 500);
    this.store.db
      .prepare(
        'INSERT INTO operators(id,display_name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .run(operatorId, operatorId === 'local-operator' ? 'Local operator' : operatorId, new Date(0).toISOString());
  }

  clients(dataset: Dataset): ClientWorkspace[] {
    if (this.operatorId === 'local-operator') this.ensureDefaultClient(dataset);
    return (
      this.store.db
        .prepare(
          `SELECT c.id,c.dataset,c.name,c.created_at FROM client_workspaces c
           JOIN client_memberships m ON m.client_id=c.id
           WHERE c.dataset=? AND m.operator_id=? ORDER BY c.created_at,c.id`,
        )
        .all(dataset, this.operatorId) as {
        id: string;
        dataset: Dataset;
        name: string;
        created_at: string;
      }[]
    ).map((row) => ({
      id: row.id,
      dataset: row.dataset,
      name: row.name,
      createdAt: row.created_at,
    }));
  }

  ensureDefaultClient(dataset: Dataset): ClientWorkspace {
    if (this.operatorId !== 'local-operator')
      throw new AppError('Only the local bootstrap operator can create the default client.', 403);
    const id = `${dataset}-default-client`;
    const name = dataset === 'demo' ? 'Fictional demo client' : 'Pathway workspace';
    const createdAt = new Date(0).toISOString();
    this.store.db
      .prepare(
        'INSERT INTO client_workspaces(id,dataset,name,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .run(id, dataset, name, createdAt);
    this.store.db
      .prepare(
        `INSERT INTO client_memberships(operator_id,client_id,role,created_at)
         VALUES(?,?,?,?) ON CONFLICT(operator_id,client_id) DO NOTHING`,
      )
      .run(this.operatorId, id, 'owner', createdAt);
    return { id, dataset, name, createdAt };
  }

  createClient(dataset: 'workspace', name: string, now = new Date()): ClientWorkspace {
    const cleaned = name.trim();
    if (this.clients(dataset).some((client) => client.name.toLowerCase() === cleaned.toLowerCase()))
      throw new AppError('A client workspace with that name already exists.', 409);
    const count = (
      this.store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM client_memberships m
           JOIN client_workspaces c ON c.id=m.client_id
           WHERE m.operator_id=? AND c.dataset=?`,
        )
        .get(this.operatorId, dataset) as { count: number }
    ).count;
    if (count >= 100) throw new AppError('An operator can access up to 100 client workspaces.');
    const client: ClientWorkspace = {
      id: randomUUID(),
      dataset,
      name: cleaned,
      createdAt: now.toISOString(),
    };
    this.store.db
      .prepare('INSERT INTO client_workspaces(id,dataset,name,created_at) VALUES(?,?,?,?)')
      .run(client.id, client.dataset, client.name, client.createdAt);
    this.store.db
      .prepare(
        'INSERT INTO client_memberships(operator_id,client_id,role,created_at) VALUES(?,?,?,?)',
      )
      .run(this.operatorId, client.id, 'owner', client.createdAt);
    return client;
  }

  client(dataset: Dataset, clientId: string): ClientWorkspace {
    const row = this.store.db
      .prepare(
        `SELECT c.id,c.dataset,c.name,c.created_at FROM client_workspaces c
         JOIN client_memberships m ON m.client_id=c.id
         WHERE c.dataset=? AND c.id=? AND m.operator_id=?`,
      )
      .get(dataset, clientId, this.operatorId) as
      | { id: string; dataset: Dataset; name: string; created_at: string }
      | undefined;
    if (!row) throw new AppError('Client workspace not found in this dataset.', 404);
    return { id: row.id, dataset: row.dataset, name: row.name, createdAt: row.created_at };
  }

  connections(dataset: Dataset, clientId: string): SourceConnection[] {
    this.client(dataset, clientId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM source_connections WHERE dataset=? AND client_id=? ORDER BY updated_at DESC,id',
        )
        .all(dataset, clientId) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  allConnections(): SourceConnection[] {
    return (
      this.store.db
        .prepare('SELECT body FROM source_connections ORDER BY updated_at,id')
        .all() as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  connection(dataset: Dataset, clientId: string, id: string): SourceConnection {
    const row = this.store.db
      .prepare(
        'SELECT body FROM source_connections WHERE id=? AND dataset=? AND client_id=?',
      )
      .get(id, dataset, clientId) as { body: string } | undefined;
    if (!row) throw new AppError('Connection not found in this client workspace.', 404);
    return JSON.parse(row.body);
  }

  connectionById(id: string): SourceConnection {
    const row = this.store.db.prepare('SELECT body FROM source_connections WHERE id=?').get(id) as
      | { body: string }
      | undefined;
    if (!row) throw new AppError('Connection not found.', 404);
    return JSON.parse(row.body);
  }

  saveConnection(connection: SourceConnection) {
    this.client(connection.dataset, connection.clientId);
    this.store.db
      .prepare(
        `INSERT INTO source_connections(id,dataset,client_id,provider,status,updated_at,body)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,body=excluded.body`,
      )
      .run(
        connection.id,
        connection.dataset,
        connection.clientId,
        connection.provider,
        connection.health.status,
        connection.updatedAt,
        JSON.stringify(connection),
      );
  }

  saveSecret(connection: SourceConnection, value: unknown, now = new Date()) {
    if (!this.vault)
      throw new AppError(
        'Configure ORBIT_VAULT_KEY before saving OAuth or access credentials.',
        503,
      );
    const encrypted = this.vault.encrypt(value, `connection:${connection.id}`);
    this.store.db
      .prepare(
        `INSERT INTO connection_secrets(connection_id,key_id,updated_at,body) VALUES(?,?,?,?)
         ON CONFLICT(connection_id) DO UPDATE SET key_id=excluded.key_id,updated_at=excluded.updated_at,body=excluded.body`,
      )
      .run(connection.id, encrypted.keyId, now.toISOString(), JSON.stringify(encrypted));
  }

  secret<T>(connection: SourceConnection): T {
    if (!this.vault)
      throw new AppError('The credential vault is unavailable. Configure ORBIT_VAULT_KEY.', 503);
    const row = this.store.db
      .prepare('SELECT body FROM connection_secrets WHERE connection_id=?')
      .get(connection.id) as { body: string } | undefined;
    if (!row) throw new AppError('This connection has no saved credentials.', 409);
    return this.vault.decrypt<T>(JSON.parse(row.body) as EncryptedSecret, `connection:${connection.id}`);
  }

  clearSecret(connection: SourceConnection) {
    this.store.db
      .prepare('DELETE FROM connection_secrets WHERE connection_id=?')
      .run(connection.id);
  }

  secretExists(connectionId: string): boolean {
    return Boolean(
      this.store.db
        .prepare('SELECT 1 FROM connection_secrets WHERE connection_id=?')
        .get(connectionId),
    );
  }

  createOAuthState(
    connection: SourceConnection,
    state: string,
    metadata: Record<string, unknown>,
    now = new Date(),
  ) {
    const stateHash = createHash('sha256').update(state).digest('hex');
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    this.store.db
      .prepare(
        `INSERT INTO connection_oauth_states
         (state_hash,connection_id,dataset,client_id,provider,expires_at,consumed_at,body)
         VALUES(?,?,?,?,?,?,NULL,?)`,
      )
      .run(
        stateHash,
        connection.id,
        connection.dataset,
        connection.clientId,
        connection.provider,
        expiresAt,
        JSON.stringify(metadata),
      );
    return expiresAt;
  }

  consumeOAuthState(state: string, provider: SourceProvider, now = new Date()) {
    const stateHash = createHash('sha256').update(state).digest('hex');
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare('SELECT * FROM connection_oauth_states WHERE state_hash=? AND provider=?')
        .get(stateHash, provider) as
        | {
            connection_id: string;
            dataset: Dataset;
            client_id: string;
            expires_at: string;
            consumed_at: string | null;
            body: string;
          }
        | undefined;
      if (!row || row.consumed_at || Date.parse(row.expires_at) < now.getTime())
        throw new AppError('The authorization state is invalid, expired, or already used.', 400);
      this.store.db
        .prepare('UPDATE connection_oauth_states SET consumed_at=? WHERE state_hash=?')
        .run(now.toISOString(), stateHash);
      return {
        connection: this.connection(row.dataset, row.client_id, row.connection_id),
        metadata: JSON.parse(row.body) as Record<string, unknown>,
      };
    });
  }

  saveJob(job: ConnectionJob) {
    this.store.db
      .prepare(
        `INSERT INTO connection_jobs(id,dataset,client_id,connection_id,status,started_at,body)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body`,
      )
      .run(
        job.id,
        job.dataset,
        job.clientId,
        job.connectionId,
        job.status,
        job.startedAt,
        JSON.stringify(job),
      );
  }

  jobs(dataset: Dataset, clientId: string, limit = 50): ConnectionJob[] {
    this.client(dataset, clientId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM connection_jobs WHERE dataset=? AND client_id=? ORDER BY started_at DESC LIMIT ?',
        )
        .all(dataset, clientId, limit) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  unfinishedJobs(): ConnectionJob[] {
    return (
      this.store.db
        .prepare("SELECT body FROM connection_jobs WHERE status IN ('queued','running') ORDER BY started_at")
        .all() as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  queuedJobs(limit = 20, now = new Date()): ConnectionJob[] {
    return (
      this.store.db
        .prepare("SELECT body FROM connection_jobs WHERE status='queued' ORDER BY started_at LIMIT ?")
        .all(limit) as { body: string }[]
    )
      .map((row) => JSON.parse(row.body) as ConnectionJob)
      .filter((job) => !job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now.getTime())
      .slice(0, limit);
  }

  replaceObjects(
    connectionId: string,
    kind: string,
    items: SourceObject[],
    now = new Date(),
    complete = true,
  ) {
    const existing = new Map(
      (
        this.store.db
          .prepare('SELECT external_id,fingerprint FROM connection_objects WHERE connection_id=? AND kind=?')
          .all(connectionId, kind) as { external_id: string; fingerprint: string }[]
      ).map((row) => [row.external_id, row.fingerprint]),
    );
    const put = this.store.db.prepare(
      `INSERT INTO connection_objects(connection_id,kind,external_id,observed_at,fingerprint,body)
       VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id,kind,external_id)
       DO UPDATE SET observed_at=excluded.observed_at,fingerprint=excluded.fingerprint,body=excluded.body`,
    );
    const seen = new Set<string>();
    let inserted = 0,
      changed = 0,
      unchanged = 0;
    for (const item of items) {
      if (seen.has(item.externalId))
        throw new AppError(`Source returned duplicate ${kind} identity ${item.externalId}.`);
      seen.add(item.externalId);
      const fingerprint = digest(item.value);
      const old = existing.get(item.externalId);
      if (!old) inserted++;
      else if (old === fingerprint) unchanged++;
      else changed++;
      put.run(
        connectionId,
        kind,
        item.externalId,
        item.observedAt || now.toISOString(),
        fingerprint,
        JSON.stringify(item.value),
      );
    }
    const remove = this.store.db.prepare(
      'DELETE FROM connection_objects WHERE connection_id=? AND kind=? AND external_id=?',
    );
    let removed = 0;
    for (const externalId of existing.keys())
      if (complete && !seen.has(externalId)) {
        remove.run(connectionId, kind, externalId);
        removed++;
      }
    return { inserted, changed, unchanged, removed };
  }

  objects<T>(connectionId: string, kind: string): T[] {
    return (
      this.store.db
        .prepare(
          'SELECT body FROM connection_objects WHERE connection_id=? AND kind=? ORDER BY external_id',
        )
        .all(connectionId, kind) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  event(
    connection: Pick<SourceConnection, 'id' | 'dataset' | 'clientId'> | null,
    dataset: Dataset,
    clientId: string,
    action: string,
    detail: string,
    now = new Date(),
  ) {
    const value: ConnectionAuditEvent = {
      id: randomUUID(),
      dataset,
      clientId,
      connectionId: connection?.id || null,
      action,
      detail,
      createdAt: now.toISOString(),
    };
    this.store.db
      .prepare(
        'INSERT INTO connection_events(id,dataset,client_id,connection_id,action,created_at,body) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        value.id,
        value.dataset,
        value.clientId,
        value.connectionId,
        value.action,
        value.createdAt,
        JSON.stringify(value),
      );
    return value;
  }

  events(dataset: Dataset, clientId: string, limit = 50): ConnectionAuditEvent[] {
    this.client(dataset, clientId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM connection_events WHERE dataset=? AND client_id=? ORDER BY created_at DESC LIMIT ?',
        )
        .all(dataset, clientId, limit) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }

  acceptWebhook(
    connectionId: string,
    deliveryId: string,
    topic: string,
    now = new Date(),
  ): boolean {
    const result = this.store.db
      .prepare(
        `INSERT INTO connection_webhook_receipts(connection_id,delivery_id,topic,received_at)
         VALUES(?,?,?,?) ON CONFLICT(connection_id,delivery_id) DO NOTHING`,
      )
      .run(connectionId, deliveryId, topic, now.toISOString());
    return result.changes === 1;
  }
}
