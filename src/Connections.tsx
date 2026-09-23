import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  KeyRound,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Unplug,
  UsersRound,
} from 'lucide-react';
import type {
  ConnectionsView,
  ConnectionStatus,
  SourceConnection,
  SourceProvider,
} from '../shared/connections';
import type { Dataset } from '../shared/types';
import { Badge, Empty, Modal } from './components';
import { api, number, timeAgo } from './lib';

const providers: Record<
  SourceProvider,
  {
    name: string;
    letter: string;
    className: string;
    category: string;
    description: string;
  }
> = {
  shopify: {
    name: 'Shopify',
    letter: 's',
    className: 'shopify',
    category: 'COMMERCE & ECONOMICS',
    description: 'Products, inventory, paid order lines, refunds, and exact SKU reconciliation.',
  },
  'meta-ads': {
    name: 'Meta Ads',
    letter: '∞',
    className: 'meta',
    category: 'PRODUCT ADVERTISING',
    description: 'Ad accounts, campaigns, ad sets, creatives, and daily ad-level Insights.',
  },
  'amazon-ads': {
    name: 'Amazon Ads',
    letter: 'a',
    className: 'amazon',
    category: 'BOOK ADVERTISING',
    description: 'Advertiser profiles and Sponsored Products entities, handed to Reporting v3.',
  },
  pbs: {
    name: 'PBS HQ',
    letter: 'P',
    className: 'pbs',
    category: 'PUBLISHER OPERATIONS',
    description: 'ISBN catalog, format identity, availability, returns, and settlement evidence.',
  },
};

const healthLabel: Record<ConnectionStatus, string> = {
  setup: 'Setup needed',
  authorizing: 'Authorizing',
  connected: 'Ready to sync',
  syncing: 'Syncing',
  healthy: 'Healthy',
  partial: 'Mapping needed',
  stale: 'Stale',
  error: 'Sync failed',
  reauthorize: 'Reauthorize',
};

const healthKind = (status: ConnectionStatus) =>
  status === 'healthy'
    ? 'scale'
    : status === 'syncing' || status === 'authorizing'
      ? 'purple'
      : ['partial', 'stale', 'error', 'reauthorize'].includes(status)
        ? 'reduce'
        : 'neutral';

export function ConnectionsPage({
  dataset,
  onWorkspace,
  onNotice,
}: {
  dataset: Dataset;
  onWorkspace: () => void;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const [view, setView] = useState<ConnectionsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [adding, setAdding] = useState<SourceProvider | null>(null);
  const [addingClient, setAddingClient] = useState(false);
  const [activeClientId, setActiveClientId] = useState('');
  const [busyId, setBusyId] = useState('');
  const [expanded, setExpanded] = useState('');

  async function load(signal?: AbortSignal, selectedClientId = activeClientId) {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api<ConnectionsView>(
        `/connections?dataset=${dataset}${selectedClientId ? `&clientId=${encodeURIComponent(selectedClientId)}` : ''}`,
        undefined,
        'GET',
        signal,
      );
      setView(data);
      setActiveClientId(data.activeClientId);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setLoadError((error as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setActiveClientId('');
    void load(controller.signal, '');
    return () => controller.abort();
  }, [dataset]);

  async function sync(connection: SourceConnection) {
    setBusyId(connection.id);
    try {
      await api(`/connections/${connection.id}/sync`, {
        dataset,
        clientId: connection.clientId,
      });
      await load(undefined, connection.clientId);
      onNotice(`${connection.name} synchronized in read-only mode.`);
    } catch (error) {
      await load(undefined, connection.clientId);
      onNotice((error as Error).message, true);
    } finally {
      setBusyId('');
    }
  }

  async function revoke(connection: SourceConnection) {
    setBusyId(connection.id);
    try {
      await api(`/connections/${connection.id}/revoke`, {
        dataset,
        clientId: connection.clientId,
      });
      await load();
      onNotice(`${connection.name} credentials were removed from Orbit.`);
    } catch (error) {
      onNotice((error as Error).message, true);
    } finally {
      setBusyId('');
    }
  }

  if (loading && !view)
    return (
      <div className="loading-state">
        <Loader2 className="spin" size={28} />
        <span>Checking source health…</span>
      </div>
    );
  if (loadError && !view)
    return (
      <Empty
        icon={<Unplug size={28} />}
        title="Connection health could not load"
        action={
          <button className="button primary" onClick={() => void load()}>
            Try again
          </button>
        }
      >
        {loadError}
      </Empty>
    );
  if (!view) return null;

  const providerConnections = (provider: SourceProvider) =>
    view.connections.filter((connection) => connection.provider === provider);
  const activeClientName =
    view.clients.find((client) => client.id === view.activeClientId)?.name || 'Client workspace';

  return (
    <div className="connection-center">
      <section className="connection-security" aria-label="Connection safety">
        <span className="connection-security-icon">
          <ShieldCheck size={22} />
        </span>
        <div>
          <strong>Observation mode is locked on.</strong>
          <p>
            Credentials stay encrypted on the server. Source syncs can read and reconcile facts;
            they cannot change ads, budgets, products, orders, or publisher records.
          </p>
        </div>
        <div className="security-facts">
          <span>
            <LockKeyhole size={13} /> {view.security.vaultConfigured ? 'Vault ready' : 'Vault key needed'}
          </span>
          <span>
            <Database size={13} /> Client scoped
          </span>
        </div>
      </section>

      <div className="client-scope-bar">
        <label>
          <UsersRound size={15} />
          <span>Client scope</span>
          <select
            value={view.activeClientId}
            onChange={(event) => {
              const next = event.target.value;
              setActiveClientId(next);
              void load(undefined, next);
            }}
          >
            {view.clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        {dataset === 'workspace' && (
          <button className="button secondary small-button" onClick={() => setAddingClient(true)}>
            <Plus size={13} /> Add client
          </button>
        )}
        <p>Connections, credentials, jobs, and audits stay inside this selected client.</p>
      </div>

      <div className="connection-summary" aria-label="Connection summary">
        <div>
          <span>Healthy sources</span>
          <strong>{view.summary.healthy}</strong>
          <small>reconciled and current</small>
        </div>
        <div>
          <span>Needs attention</span>
          <strong>{view.summary.attention}</strong>
          <small>stale, partial, or blocked</small>
        </div>
        <div>
          <span>Active syncs</span>
          <strong>{view.summary.syncing}</strong>
          <small>durable background work</small>
        </div>
        <div>
          <span>Last source success</span>
          <strong className="summary-time">
            {view.summary.lastSuccessAt ? timeAgo(view.summary.lastSuccessAt) : 'Not yet'}
          </strong>
          <small>{activeClientName}</small>
        </div>
      </div>

      {dataset === 'demo' && (
        <div className="connection-demo-note">
          <div>
            <strong>Live authorization belongs in Your workspace.</strong>
            <p>The demo remains isolated and never accepts business credentials.</p>
          </div>
          <button className="button primary" onClick={onWorkspace}>
            Open Your workspace <ArrowRight size={15} />
          </button>
        </div>
      )}

      <div className="connections-grid source-grid">
        {(Object.keys(providers) as SourceProvider[]).map((provider) => {
          const spec = providers[provider];
          const connected = providerConnections(provider);
          return (
            <article className="connection-card source-card" key={provider}>
              <div className="connection-top">
                <span className={`integration-mark ${spec.className}`}>{spec.letter}</span>
                <Badge kind={connected.some((item) => item.health.status === 'healthy') ? 'scale' : 'neutral'}>
                  {connected.length ? `${connected.length} configured` : 'Not connected'}
                </Badge>
              </div>
              <span className="eyebrow">{spec.category}</span>
              <h2>{spec.name}</h2>
              <p>{spec.description}</p>
              {connected.map((connection) => (
                <div className="source-connection" key={connection.id}>
                  <button
                    className="source-connection-heading"
                    onClick={() => setExpanded(expanded === connection.id ? '' : connection.id)}
                    aria-expanded={expanded === connection.id}
                  >
                    <span>
                      <strong>{connection.name}</strong>
                      <small>{connection.externalAccountName || connection.externalAccountId || 'Authorization pending'}</small>
                    </span>
                    <Badge kind={healthKind(connection.health.status)}>
                      {healthLabel[connection.health.status]}
                    </Badge>
                  </button>
                  <p className="source-message">{connection.health.message}</p>
                  {expanded === connection.id && (
                    <div className="connection-details">
                      <div className="connection-counts">
                        {Object.entries(connection.health.counts)
                          .filter(([, value]) => value > 0)
                          .map(([key, value]) => (
                            <span key={key}>
                              <strong>{number(value)}</strong> {key.replace(/([A-Z])/g, ' $1')}
                            </span>
                          ))}
                      </div>
                      <div className="capability-list">
                        {connection.capabilities.map((capability) => (
                          <span key={capability.key} className={capability.state}>
                            {capability.state === 'ready' ? (
                              <CheckCircle2 size={13} />
                            ) : capability.state === 'blocked' ? (
                              <CircleAlert size={13} />
                            ) : (
                              <Clock3 size={13} />
                            )}
                            {capability.label}
                          </span>
                        ))}
                      </div>
                      <small className="connection-meta">
                        {connection.health.lastSuccessAt
                          ? `Last success ${timeAgo(connection.health.lastSuccessAt)}`
                          : 'No successful collection yet'}
                        {connection.health.sourceAsOf
                          ? ` · source through ${connection.health.sourceAsOf.slice(0, 10)}`
                          : ''}
                      </small>
                    </div>
                  )}
                  <div className="source-actions">
                    <button
                      className="button secondary small-button"
                      disabled={busyId === connection.id || !connection.secretConfigured || dataset === 'demo'}
                      onClick={() => void sync(connection)}
                    >
                      {busyId === connection.id ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
                      Sync now
                    </button>
                    {connection.secretConfigured && connection.authMode !== 'environment' && (
                      <button
                        className="text-button danger-text"
                        disabled={busyId === connection.id}
                        onClick={() => void revoke(connection)}
                      >
                        Remove credentials
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <button
                className="button secondary add-source"
                onClick={() => (dataset === 'demo' ? onWorkspace() : setAdding(provider))}
              >
                <KeyRound size={14} />
                {connected.length ? `Add another ${spec.name} source` : `Connect ${spec.name}`}
              </button>
            </article>
          );
        })}
      </div>

      <section className="connection-jobs">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">DURABLE COLLECTION LOG</span>
            <h2>Recent source work</h2>
          </div>
          <button
            className="button secondary small-button"
            onClick={() => void load(undefined, view.activeClientId)}
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
          </button>
        </div>
        {!view.jobs.length ? (
          <div className="empty-inline">No source jobs yet. Connect a provider and run its first sync.</div>
        ) : (
          <div className="connection-job-list">
            {view.jobs.slice(0, 12).map((job) => (
              <div key={job.id}>
                <span className={`job-state ${job.status}`}>
                  <Activity size={13} /> {job.status}
                </span>
                <strong>{providers[job.provider].name}</strong>
                <p>{job.message}</p>
                <time>{timeAgo(job.finishedAt || job.startedAt)}</time>
              </div>
            ))}
          </div>
        )}
      </section>

      {adding && (
        <Modal
          title={`Connect ${providers[adding].name}`}
          subtitle="Read-only collection. Orbit never returns the saved credential to this browser."
          onClose={() => setAdding(null)}
        >
          <ConnectionForm
            provider={adding}
            view={view}
            onSaved={async (message) => {
              setAdding(null);
              await load();
              onNotice(message);
            }}
          />
        </Modal>
      )}
      {addingClient && (
        <Modal
          title="Add a client workspace"
          subtitle="Source credentials and job history will be isolated to this client scope."
          onClose={() => setAddingClient(false)}
        >
          <ClientForm
            onSaved={async (clientId) => {
              setAddingClient(false);
              setActiveClientId(clientId);
              await load(undefined, clientId);
              onNotice('Client workspace created.');
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function ClientForm({ onSaved }: { onSaved: (clientId: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="detail-stack connection-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
          const form = new FormData(event.currentTarget);
          const client = await api<{ id: string }>('/clients', {
            dataset: 'workspace',
            name: String(form.get('name') || '').trim(),
          });
          await onSaved(client.id);
        } catch (caught) {
          setError((caught as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        <span>Client name</span>
        <input name="name" required maxLength={160} autoFocus />
      </label>
      <div className="inline-note">
        <ShieldCheck size={18} />
        <p>Legacy campaign and portfolio records remain in the Pathway bootstrap workspace until their schemas are migrated to client scope.</p>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button primary setup-download" disabled={busy}>
        {busy ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
        Create client workspace
      </button>
    </form>
  );
}

function ConnectionForm({
  provider,
  view,
  onSaved,
}: {
  provider: SourceProvider;
  view: ConnectionsView;
  onSaved: (message: string) => Promise<void>;
}) {
  const defaultMode = provider === 'amazon-ads' ? 'environment' : provider === 'pbs' ? 'token' : 'oauth';
  const [mode, setMode] = useState<'oauth' | 'token' | 'environment'>(defaultMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const form = new FormData(event.currentTarget);
      const field = (name: string) => String(form.get(name) || '').trim();
      let credentials: Record<string, string> | undefined;
      if (mode === 'token') {
        if (provider === 'shopify')
          credentials = { accessToken: field('accessToken'), shopDomain: field('shopDomain').toLowerCase() };
        if (provider === 'meta-ads') credentials = { accessToken: field('accessToken') };
        if (provider === 'amazon-ads')
          credentials = {
            clientId: field('clientId'),
            clientSecret: field('clientSecret'),
            refreshToken: field('refreshToken'),
            region: field('region'),
          };
        if (provider === 'pbs')
          credentials = {
            baseUrl: field('baseUrl'),
            accessToken: field('accessToken'),
            publisherCode: field('publisherCode'),
          };
      }
      const connection = await api<SourceConnection>('/connections', {
        dataset: 'workspace',
        clientId: view.activeClientId,
        provider,
        name: field('name'),
        authMode: mode,
        externalAccountId: field('externalAccountId') || undefined,
        ...(credentials ? { credentials } : {}),
      });
      if (mode === 'oauth') {
        const started = await api<{ authorizationUrl: string }>(
          `/connections/${connection.id}/oauth/start`,
          {
            dataset: 'workspace',
            clientId: view.activeClientId,
            ...(provider === 'shopify' ? { shopDomain: field('shopDomain').toLowerCase() } : {}),
          },
        );
        window.location.assign(started.authorizationUrl);
        return;
      }
      await onSaved(`${providers[provider].name} connection saved. Run its first sync to verify access.`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const needsVault = mode !== 'environment';
  return (
    <form className="detail-stack connection-form" onSubmit={submit}>
      <label>
        <span>Connection name</span>
        <input name="name" required maxLength={160} defaultValue={`${providers[provider].name} · primary`} />
      </label>
      {provider !== 'pbs' && (
        <label>
          <span>Authorization method</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            {provider !== 'amazon-ads' && <option value="oauth">OAuth consent</option>}
            {provider === 'amazon-ads' && <option value="environment">Existing server API configuration</option>}
            <option value="token">Server credential</option>
            {provider === 'amazon-ads' && <option value="oauth">Login with Amazon</option>}
          </select>
        </label>
      )}
      {(provider === 'meta-ads' || provider === 'amazon-ads') && (
        <label>
          <span>{provider === 'meta-ads' ? 'Ad account ID' : 'Advertiser profile ID'} (optional for one-account access)</span>
          <input name="externalAccountId" placeholder={provider === 'meta-ads' ? 'act_123456789' : '123456789'} />
        </label>
      )}
      {provider === 'shopify' && (
        <label>
          <span>Permanent Shopify domain</span>
          <input name="shopDomain" required placeholder="store-name.myshopify.com" autoCapitalize="none" />
        </label>
      )}
      {provider === 'pbs' && (
        <>
          <label>
            <span>PBS API base URL</span>
            <input name="baseUrl" type="url" required placeholder="https://api.pathwaybook.net/" />
          </label>
          <label>
            <span>Publisher code</span>
            <input name="publisherCode" required maxLength={32} />
          </label>
        </>
      )}
      {mode === 'token' && provider === 'amazon-ads' && (
        <>
          <label><span>Login with Amazon client ID</span><input name="clientId" required autoComplete="off" /></label>
          <label><span>Client secret</span><input name="clientSecret" type="password" required autoComplete="new-password" /></label>
          <label><span>Advertiser refresh token</span><textarea name="refreshToken" required rows={3} /></label>
          <label><span>API region</span><select name="region"><option>NA</option><option>EU</option><option>FE</option></select></label>
        </>
      )}
      {mode === 'token' && provider !== 'amazon-ads' && (
        <label>
          <span>{provider === 'pbs' ? 'Scoped PBS access token' : 'Access token'}</span>
          <textarea name="accessToken" required rows={3} autoComplete="off" />
        </label>
      )}
      {needsVault && !view.security.vaultConfigured && (
        <div className="inline-note warning-note">
          <CircleAlert size={18} />
          <p>Set ORBIT_VAULT_KEY on the server before saving credentials or starting OAuth.</p>
        </div>
      )}
      <div className="inline-note">
        <ShieldCheck size={18} />
        <p>Requested access is used for observation and reconciliation. This connection cannot authorize platform writes.</p>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button primary setup-download" disabled={busy || (needsVault && !view.security.vaultConfigured)}>
        {busy ? <Loader2 className="spin" size={15} /> : <KeyRound size={15} />}
        {mode === 'oauth' ? 'Continue to authorization' : 'Save encrypted connection'}
      </button>
    </form>
  );
}
