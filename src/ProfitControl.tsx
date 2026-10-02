import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowRight,
  BookOpen,
  Boxes,
  CheckCircle2,
  CalendarClock,
  CircleAlert,
  CircleDollarSign,
  FlaskConical,
  FileCheck2,
  Gauge,
  GitMerge,
  Loader2,
  Link2,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trophy,
  Trash2,
  UsersRound,
} from 'lucide-react';
import type {
  MappingCandidate,
  ProfitAsset,
  ProfitControlView,
  ProfitExperimentSource,
  ProfitItem,
  ProfitItemView,
  ProfitTestPlan,
} from '../shared/control';
import type { Dataset } from '../shared/types';
import { Badge, Empty, Modal } from './components';
import { api, dollarInput, money, number, timeAgo } from './lib';

const decisionKind = {
  blocked: 'reduce',
  observe: 'neutral',
  test: 'purple',
  scale: 'scale',
  stop: 'reduce',
} as const;

export function ProfitControlPage({
  dataset,
  onWorkspace,
  onNotice,
}: {
  dataset: Dataset;
  onWorkspace: () => void;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const [view, setView] = useState<ProfitControlView | null>(null);
  const [activeClientId, setActiveClientId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'portfolio' | 'mapping' | 'assets' | 'tests' | 'allocator'>('portfolio');
  const [modal, setModal] = useState<'item' | 'pool' | 'asset' | 'test' | null>(null);
  const [selectedTestId, setSelectedTestId] = useState('');
  const [busy, setBusy] = useState('');

  async function load(signal?: AbortSignal, clientId = activeClientId) {
    setLoading(true);
    setError('');
    try {
      const data = await api<ProfitControlView>(
        `/profit-control?dataset=${dataset}${clientId ? `&clientId=${encodeURIComponent(clientId)}` : ''}`,
        undefined,
        'GET',
        signal,
      );
      setView(data);
      setActiveClientId(data.activeClientId);
    } catch (caught) {
      if ((caught as Error).name !== 'AbortError') setError((caught as Error).message);
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

  async function map(candidate: MappingCandidate, itemId: string) {
    if (!view || !itemId) return;
    setBusy(`${candidate.connectionId}:${candidate.sourceKind}:${candidate.externalId}`);
    try {
      await api('/profit-control/mappings', {
        dataset: 'workspace',
        clientId: view.activeClientId,
        connectionId: candidate.connectionId,
        sourceKind: candidate.sourceKind,
        externalId: candidate.externalId,
        itemId,
      });
      await load(undefined, view.activeClientId);
      onNotice(`${candidate.sourceName} mapped to the profit model.`);
    } catch (caught) {
      onNotice((caught as Error).message, true);
    } finally {
      setBusy('');
    }
  }

  async function removeMapping(mappingId: string) {
    if (!view) return;
    setBusy(mappingId);
    try {
      await api(`/profit-control/mappings/${mappingId}/remove`, {
        dataset: 'workspace',
        clientId: view.activeClientId,
      });
      await load(undefined, view.activeClientId);
      onNotice('Source mapping removed.');
    } catch (caught) {
      onNotice((caught as Error).message, true);
    } finally {
      setBusy('');
    }
  }

  async function optimize(poolId: string) {
    if (!view) return;
    setBusy(poolId);
    try {
      await api('/profit-control/optimize', {
        dataset: 'workspace',
        clientId: view.activeClientId,
        poolId,
      });
      await load(undefined, view.activeClientId);
      onNotice('Shadow allocation completed. No platform changes were made.');
    } catch (caught) {
      onNotice((caught as Error).message, true);
    } finally {
      setBusy('');
    }
  }

  async function activateTest(testId: string) {
    if (!view) return;
    setBusy(testId);
    try {
      await api(`/profit-control/tests/${testId}/activate`, {
        dataset: 'workspace',
        clientId: view.activeClientId,
      });
      await load(undefined, view.activeClientId);
      onNotice('First bounded wave approved. No ad platform changes were made.');
    } catch (caught) {
      onNotice((caught as Error).message, true);
    } finally {
      setBusy('');
    }
  }

  if (loading && !view)
    return (
      <div className="loading-state">
        <Loader2 className="spin" size={28} /> Loading client profit evidence…
      </div>
    );
  if (error && !view)
    return (
      <Empty
        icon={<CircleAlert size={28} />}
        title="Profit control could not load"
        action={
          <button className="button primary" onClick={() => void load()}>
            Try again
          </button>
        }
      >
        {error}
      </Empty>
    );
  if (!view) return null;
  const activeClient = view.clients.find((client) => client.id === view.activeClientId);
  const openCandidates = view.candidates.filter((candidate) => !candidate.mappedItemId);
  const selectedTest = view.tests.find((test) => test.id === selectedTestId);

  return (
    <div className="profit-control">
      <section className="profit-safety">
        <span><ShieldCheck size={21} /></span>
        <div>
          <strong>Profit decisions fail closed.</strong>
          <p>Scale stays blocked until economics, source mappings, freshness, and independent receipts are present. Allocations run in shadow mode.</p>
        </div>
        <button className="button secondary small-button" onClick={() => void load(undefined, view.activeClientId)}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh evidence
        </button>
      </section>

      <div className="profit-client-bar">
        <label>
          <UsersRound size={15} />
          <span>Client</span>
          <select
            aria-label="Profit client scope"
            value={view.activeClientId}
            onChange={(event) => {
              setActiveClientId(event.target.value);
              void load(undefined, event.target.value);
            }}
          >
            {view.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
          </select>
        </label>
        <p>{activeClient?.name} · source facts, mappings, economics, and allocations are isolated here.</p>
      </div>

      {dataset === 'demo' && (
        <div className="connection-demo-note">
          <div><strong>Build real profit controls in Your workspace.</strong><p>The demo remains synthetic and isolated.</p></div>
          <button className="button primary" onClick={onWorkspace}>Open Your workspace <ArrowRight size={15} /></button>
        </div>
      )}

      <div className="profit-summary">
        <Summary label="Profit items" value={view.summary.items} detail={`${view.summary.verified} verified`} />
        <Summary label="Mapped items" value={view.summary.mapped} detail={`${view.summary.mappingGaps} source gaps`} />
        <Summary label="Scale candidates" value={view.summary.scaleCandidates} detail="shadow recommendations" />
        <Summary label="Stop candidates" value={view.summary.stopCandidates} detail="loss controls" />
        <Summary label="Observed ad spend" value={money(view.summary.spendCents)} detail="platform attributed" />
        <Summary label="Independent receipts" value={money(view.summary.independentReceiptsCents)} detail="commerce / publisher" />
      </div>

      <section className={`pilot-readiness ${view.readiness.ready ? 'ready' : ''}`}>
        <div><span className="eyebrow">SUPERVISED PILOT GATE</span><h2>{view.readiness.ready ? 'Ready for a controlled pilot' : 'Pilot evidence is incomplete'}</h2></div>
        <div className="readiness-checks">
          {view.readiness.checks.map((check) => <div key={check.key}><span>{check.ready ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}</span><p><strong>{check.label}</strong><small>{check.detail}</small></p></div>)}
        </div>
      </section>

      <div className="profit-tabs" role="tablist" aria-label="Profit control views">
        <button role="tab" aria-selected={tab === 'portfolio'} className={tab === 'portfolio' ? 'active' : ''} onClick={() => setTab('portfolio')}><Gauge size={15} /> Portfolio</button>
        <button role="tab" aria-selected={tab === 'mapping'} className={tab === 'mapping' ? 'active' : ''} onClick={() => setTab('mapping')}><GitMerge size={15} /> Mapping inbox <span>{openCandidates.length}</span></button>
        <button role="tab" aria-selected={tab === 'assets'} className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}><FileCheck2 size={15} /> Assets <span>{view.assets.length}</span></button>
        <button role="tab" aria-selected={tab === 'tests'} className={tab === 'tests' ? 'active' : ''} onClick={() => setTab('tests')}><FlaskConical size={15} /> Test queue <span>{view.tests.length}</span></button>
        <button role="tab" aria-selected={tab === 'allocator'} className={tab === 'allocator' ? 'active' : ''} onClick={() => setTab('allocator')}><Sparkles size={15} /> Shadow allocator</button>
      </div>

      {tab === 'portfolio' && (
        <section className="profit-panel">
          <div className="section-heading-row">
            <div><span className="eyebrow">CLIENT PROFIT PORTFOLIO</span><h2>Evidence by item</h2></div>
            {dataset === 'workspace' && <button className="button primary small-button" onClick={() => setModal('item')}><Plus size={14} /> Add profit item</button>}
          </div>
          {!view.items.length ? (
            <Empty icon={<CircleDollarSign size={28} />} title="No client profit items yet">
              Add an exact SKU or book format, enter its economics, then map connected source identities.
            </Empty>
          ) : (
            <div className="profit-item-list">
              {view.items.map((item) => <ProfitRow key={item.id} item={item} busy={busy} onRemove={removeMapping} />)}
            </div>
          )}
        </section>
      )}

      {tab === 'mapping' && (
        <section className="profit-panel">
          <div className="section-heading-row">
            <div><span className="eyebrow">IDENTITY RECONCILIATION</span><h2>Mapping inbox</h2></div>
            <Badge kind={openCandidates.length ? 'reduce' : 'scale'}>{openCandidates.length ? `${openCandidates.length} open` : 'Complete'}</Badge>
          </div>
          {!view.candidates.length ? (
            <Empty icon={<GitMerge size={28} />} title="No source identities collected">
              Connect and synchronize Shopify, Meta Ads, Amazon Ads, or PBS HQ first.
            </Empty>
          ) : (
            <div className="mapping-list">
              {view.candidates.map((candidate) => (
                <MappingRow
                  key={`${candidate.connectionId}:${candidate.sourceKind}:${candidate.externalId}`}
                  candidate={candidate}
                  items={view.items}
                  busy={busy}
                  onMap={map}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'allocator' && (
        <section className="profit-panel">
          <div className="section-heading-row">
            <div><span className="eyebrow">NO-WRITE ALLOCATION</span><h2>Shadow budget allocator</h2></div>
            {dataset === 'workspace' && <button className="button secondary small-button" onClick={() => setModal('pool')}><Plus size={14} /> Configure pool</button>}
          </div>
          {!view.pools.length ? (
            <Empty icon={<Sparkles size={28} />} title="Create a bounded budget pool">
              Reserve headroom and set daily and learning limits before comparing allocations.
            </Empty>
          ) : (
            <div className="pool-list">
              {view.pools.map((pool) => (
                <article key={pool.id}>
                  <div><strong>{pool.name}</strong><span>{pool.vertical} · {pool.reservePercent}% held in reserve</span></div>
                  <div><strong>{money(pool.dailyLimitCents)}</strong><span>daily ceiling</span></div>
                  <div><strong>{money(pool.learningLimitCents)}</strong><span>learning ceiling</span></div>
                  <button className="button primary small-button" disabled={busy === pool.id || dataset === 'demo'} onClick={() => void optimize(pool.id)}>
                    {busy === pool.id ? <Loader2 className="spin" size={13} /> : <Sparkles size={13} />} Run shadow allocation
                  </button>
                </article>
              ))}
            </div>
          )}
          {!!view.runs.length && <OptimizerHistory runs={view.runs} />}
        </section>
      )}

      {tab === 'assets' && (
        <section className="profit-panel">
          <div className="section-heading-row">
            <div><span className="eyebrow">IMMUTABLE CREATIVE PROVENANCE</span><h2>Approved asset versions</h2></div>
            {dataset === 'workspace' && <button className="button primary small-button" onClick={() => setModal('asset')} disabled={!view.items.some((item) => item.vertical === 'commerce')}><Plus size={14} /> Register asset version</button>}
          </div>
          {!view.assets.length ? <Empty icon={<FileCheck2 size={28} />} title="No product assets registered">Register an exact SHA-256 version with rights, claims, and product-evidence review before a product test can start.</Empty> : <div className="asset-version-list">{view.assets.map((asset) => <article key={asset.id}><span className={`asset-kind ${asset.kind}`}>{asset.kind}</span><div><strong>{asset.name} · v{asset.version}</strong><span>{asset.itemName} · {asset.sourceRef}</span><code>{asset.contentHash}</code></div><div className="asset-approvals"><span className={asset.rightsApproved ? 'ok' : ''}>Rights</span><span className={asset.claimsApproved ? 'ok' : ''}>Claims</span><span className={asset.evidenceApproved ? 'ok' : ''}>Evidence</span></div><Badge kind={asset.status === 'approved' ? 'scale' : asset.status === 'draft' ? 'neutral' : 'reduce'}>{asset.status}</Badge></article>)}</div>}
        </section>
      )}

      {tab === 'tests' && (
        <section className="profit-panel">
          <div className="section-heading-row">
            <div><span className="eyebrow">BOUNDED EXPERIMENTS</span><h2>Candidate test queue</h2></div>
            {dataset === 'workspace' && <button className="button primary small-button" onClick={() => setModal('test')} disabled={!view.items.length}><Plus size={14} /> Build candidate library</button>}
          </div>
          {!view.tests.length ? <Empty icon={<FlaskConical size={28} />} title="No experiments planned">Build 2 to 300 traceable candidates, then approve only the first bounded wave.</Empty> : <div className="test-plan-list">{view.tests.map((test) => {
            const active = test.candidates.filter((candidate) => candidate.status === 'active').length;
            const held = test.candidates.filter((candidate) => candidate.status === 'held').length;
            const wave = test.waves.at(-1);
            return <article key={test.id}><div><span className="eyebrow">{test.variable.replace('-', ' ')}</span><h3>{test.itemName}</h3><p>{test.hypothesis}</p>{wave && <small className="wave-state">Wave {wave.sequence} · {wave.status}{wave.expectedMatureAt ? ` · matures ${new Date(wave.expectedMatureAt).toLocaleDateString()}` : ''}</small>}</div><div className="test-plan-stats"><span><b>{test.candidates.length}</b> candidates</span><span><b>{active}</b> active</span><span><b>{held}</b> held</span><span><b>{money(test.lossBudgetCents)}</b> loss boundary</span></div><div className="test-plan-actions"><Badge kind={test.outcome === 'winner' ? 'scale' : test.status === 'draft' ? 'neutral' : 'purple'}>{test.outcome || test.status}</Badge>{test.status === 'draft' ? <button className="button secondary small-button" disabled={busy === test.id || dataset === 'demo'} onClick={() => void activateTest(test.id)}>{busy === test.id ? <Loader2 className="spin" size={13} /> : <ShieldCheck size={13} />} Approve first wave</button> : <button className="button secondary small-button" onClick={() => setSelectedTestId(test.id)}><FlaskConical size={13} /> {test.status === 'completed' ? 'Review evidence' : 'Open workflow'}</button>}</div></article>;
          })}</div>}
        </section>
      )}

      {modal === 'item' && <Modal title="Add a profit item" subtitle="One exact SKU or book format with versioned economics." onClose={() => setModal(null)}><ItemForm clientId={view.activeClientId} onSaved={async () => { setModal(null); await load(undefined, view.activeClientId); onNotice('Profit item created.'); }} /></Modal>}
      {modal === 'pool' && <Modal title="Configure the client budget pool" subtitle="Every allocation remains a shadow recommendation." onClose={() => setModal(null)}><PoolForm clientId={view.activeClientId} existing={view.pools[0]} onSaved={async () => { setModal(null); await load(undefined, view.activeClientId); onNotice('Budget pool saved.'); }} /></Modal>}
      {modal === 'asset' && <Modal title="Register an immutable asset version" subtitle="Freeze the content hash and approval evidence used by product tests." onClose={() => setModal(null)}><AssetForm clientId={view.activeClientId} items={view.items} assets={view.assets} onSaved={async () => { setModal(null); await load(undefined, view.activeClientId); onNotice('Asset version registered.'); }} /></Modal>}
      {modal === 'test' && <Modal title="Build a candidate library" subtitle="Generate a traceable queue under one loss boundary." onClose={() => setModal(null)}><TestForm clientId={view.activeClientId} items={view.items} assets={view.assets} onSaved={async () => { setModal(null); await load(undefined, view.activeClientId); onNotice('Candidate library created.'); }} /></Modal>}
      {selectedTest && <TestWorkflow test={selectedTest} clientId={view.activeClientId} dataset={dataset} onClose={() => setSelectedTestId('')} onChanged={async (message) => { await load(undefined, view.activeClientId); onNotice(message); }} />}
    </div>
  );
}

function Summary({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <div><span>{label}</span><strong>{typeof value === 'number' ? number(value) : value}</strong><small>{detail}</small></div>;
}

function ProfitRow({ item, busy, onRemove }: { item: ProfitItemView; busy: string; onRemove: (id: string) => Promise<void> }) {
  return (
    <article className="profit-item">
      <div className="profit-item-main">
        <span className={`profit-kind ${item.vertical}`}>{item.vertical === 'commerce' ? <Boxes size={16} /> : <BookOpen size={16} />}</span>
        <div><strong>{item.name}</strong><span>{item.sku || item.isbn || item.asin} · economics {item.economics.verified ? 'verified' : 'unverified'}</span></div>
        <Badge kind={decisionKind[item.decision]}>{item.decision}</Badge>
      </div>
      <p>{item.reason}</p>
      <div className="profit-evidence-grid">
        <span><b>{money(item.evidence.spendCents)}</b> ad spend</span>
        <span><b>{money(item.evidence.attributedRevenueCents)}</b> attributed sales</span>
        <span><b>{number(item.evidence.attributedPurchases)}</b> attributed purchases</span>
        <span><b>{money(item.evidence.independentReceiptsCents)}</b> independent receipts</span>
        <span><b>{money(item.affordableAcquisitionCents)}</b> affordable acquisition</span>
        <span><b>{money(item.remainingLossCents)}</b> loss room</span>
      </div>
      <div className="profit-source-tags">
        {item.mappings.map((mapping) => (
          <span key={mapping.id}>{mapping.provider} · {mapping.sourceName}<button aria-label={`Remove ${mapping.sourceName} mapping`} disabled={busy === mapping.id} onClick={() => void onRemove(mapping.id)}><Trash2 size={11} /></button></span>
        ))}
        {!item.mappings.length && <span className="missing"><CircleAlert size={11} /> No sources mapped</span>}
      </div>
      {item.evidence.sourceAsOf && <small className="profit-asof">Evidence updated {timeAgo(item.evidence.sourceAsOf)}</small>}
    </article>
  );
}

function MappingRow({ candidate, items, busy, onMap }: { candidate: MappingCandidate; items: ProfitItem[]; busy: string; onMap: (candidate: MappingCandidate, itemId: string) => Promise<void> }) {
  const [itemId, setItemId] = useState(candidate.suggestedItemId || '');
  const key = `${candidate.connectionId}:${candidate.sourceKind}:${candidate.externalId}`;
  const mapped = items.find((item) => item.id === candidate.mappedItemId);
  return (
    <div className="mapping-row">
      <div><strong>{candidate.sourceName}</strong><span>{candidate.provider} · {candidate.sourceKind} · {candidate.identityHint || candidate.externalId}</span></div>
      {mapped ? <span className="mapped-label"><CheckCircle2 size={13} /> {mapped.name}</span> : <><select aria-label={`Map ${candidate.sourceName}`} value={itemId} onChange={(event) => setItemId(event.target.value)}><option value="">Choose profit item</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.sku || item.isbn || item.asin}</option>)}</select><button className="button secondary small-button" disabled={!itemId || busy === key} onClick={() => void onMap(candidate, itemId)}>{busy === key ? <Loader2 className="spin" size={13} /> : <GitMerge size={13} />} Map</button></>}
    </div>
  );
}

function OptimizerHistory({ runs }: { runs: ProfitControlView['runs'] }) {
  const latest = runs[0];
  return <div className="optimizer-history"><div className="section-heading-row"><div><span className="eyebrow">LATEST SHADOW RUN</span><h2>{timeAgo(latest.createdAt)}</h2></div><Badge kind="neutral">No platform writes</Badge></div><div className="optimizer-totals"><span><b>{money(latest.totalAllocatedCents)}</b> allocated per day</span><span><b>{money(latest.unallocatedCents)}</b> deliberately unallocated</span><span><b>{latest.allocations.length}</b> evaluated items</span></div>{latest.allocations.map((row) => <div className="allocation-row" key={row.itemId}><strong>{row.itemName}</strong><Badge kind={decisionKind[row.decision]}>{row.decision}</Badge><span>{money(row.allocatedDailyCents)}/day</span><small>{row.reason}</small></div>)}</div>;
}

function ItemForm({ clientId, onSaved }: { clientId: string; onSaved: () => Promise<void> }) {
  const [vertical, setVertical] = useState<'commerce' | 'books'>('commerce');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const form = new FormData(event.currentTarget);
      const dollars = (name: string) => dollarInput(form.get(name));
      await api('/profit-control/items', { dataset: 'workspace', clientId, vertical, name: String(form.get('name') || ''), ...(vertical === 'commerce' ? { sku: String(form.get('identity') || '') } : { isbn: String(form.get('identity') || ''), asin: String(form.get('asin') || '') }), retailPriceCents: dollars('retail'), netReceiptCents: dollars('receipt'), variableCostCents: dollars('cost'), profitReserveCents: dollars('reserve'), lossLimitCents: dollars('loss'), dailyBudgetLimitCents: dollars('daily'), verified: form.get('verified') === 'on', note: String(form.get('note') || '') });
      await onSaved();
    } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); }
  }
  return <form className="detail-stack connection-form" onSubmit={submit}><label><span>Item type</span><select value={vertical} onChange={(event) => setVertical(event.target.value as typeof vertical)}><option value="commerce">Commerce SKU</option><option value="books">Book format</option></select></label><label><span>Item name</span><input name="name" required maxLength={200} autoFocus /></label><label><span>{vertical === 'commerce' ? 'Exact SKU' : 'ISBN'}</span><input name="identity" required maxLength={160} /></label>{vertical === 'books' && <label><span>ASIN (optional until verified)</span><input name="asin" maxLength={32} /></label>}<div className="money-form-grid">{[['retail','Retail price'],['receipt','Net receipt'],['cost','Variable cost'],['reserve','Profit reserve'],['loss','Learning loss limit'],['daily','Daily budget ceiling']].map(([name,label]) => <label key={name}><span>{label}</span><input name={name} required inputMode="decimal" placeholder="0.00" /></label>)}</div><label className="check-row"><input type="checkbox" name="verified" /> <span>I verified these economics from current business records.</span></label><label><span>Economics note</span><textarea name="note" rows={2} maxLength={500} /></label>{error && <div className="form-error" role="alert">{error}</div>}<button className="button primary setup-download" disabled={busy}>{busy ? <Loader2 className="spin" size={15} /> : <Plus size={15} />} Create profit item</button></form>;
}

function PoolForm({ clientId, existing, onSaved }: { clientId: string; existing?: ProfitControlView['pools'][number]; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(''); try { const form = new FormData(event.currentTarget); await api('/profit-control/pools', { dataset: 'workspace', clientId, name: String(form.get('name') || ''), vertical: String(form.get('vertical') || 'all'), dailyLimitCents: dollarInput(form.get('daily')), learningLimitCents: dollarInput(form.get('learning')), reservePercent: Number(form.get('reserve')) }); await onSaved(); } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); } }
  return <form className="detail-stack connection-form" onSubmit={submit}><label><span>Pool name</span><input name="name" required defaultValue={existing?.name || 'Client learning and scale pool'} /></label><label><span>Coverage</span><select name="vertical" defaultValue={existing?.vertical || 'all'}><option value="all">Products and books</option><option value="commerce">Products only</option><option value="books">Books only</option></select></label><label><span>Daily ceiling</span><input name="daily" required inputMode="decimal" defaultValue={existing ? (existing.dailyLimitCents / 100).toFixed(2) : ''} /></label><label><span>Total learning ceiling</span><input name="learning" required inputMode="decimal" defaultValue={existing ? (existing.learningLimitCents / 100).toFixed(2) : ''} /></label><label><span>Headroom held in reserve (%)</span><input name="reserve" type="number" required min="0" max="90" defaultValue={existing?.reservePercent ?? 20} /></label><div className="inline-note"><ShieldCheck size={18} /><p>The allocator may leave money unused. It cannot authorize or execute platform changes.</p></div>{error && <div className="form-error" role="alert">{error}</div>}<button className="button primary setup-download" disabled={busy}>{busy ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />} Save budget pool</button></form>;
}

function AssetForm({ clientId, items, assets, onSaved }: { clientId: string; items: ProfitItemView[]; assets: ProfitAsset[]; onSaved: () => Promise<void> }) {
  const commerce = items.filter((item) => item.vertical === 'commerce');
  const [itemId, setItemId] = useState(commerce[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const prior = assets.filter((asset) => asset.itemId === itemId && asset.status !== 'superseded');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const form = new FormData(event.currentTarget);
      await api('/profit-control/assets', {
        dataset: 'workspace', clientId, itemId,
        kind: String(form.get('kind') || 'image'), name: String(form.get('name') || ''),
        contentHash: String(form.get('hash') || ''), sourceRef: String(form.get('sourceRef') || ''),
        rightsApproved: form.get('rights') === 'on', claimsApproved: form.get('claims') === 'on',
        evidenceApproved: form.get('evidence') === 'on', approvalNote: String(form.get('note') || ''),
        ...(form.get('supersedesId') ? { supersedesId: String(form.get('supersedesId')) } : {}),
      });
      await onSaved();
    } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); }
  }
  return <form className="detail-stack connection-form" onSubmit={submit}><label><span>Commerce item</span><select value={itemId} onChange={(event) => setItemId(event.target.value)}>{commerce.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.sku}</option>)}</select></label><label><span>Asset type</span><select name="kind"><option value="image">Image</option><option value="video">Video</option><option value="copy">Copy or script</option><option value="landing-page">Landing page</option></select></label><label><span>Version name</span><input name="name" required maxLength={200} placeholder="Proof-led installation video" /></label><label><span>Source reference</span><input name="sourceRef" required maxLength={1000} placeholder="DAM path, approved URL, or internal asset ID" /></label><label><span>SHA-256 content hash</span><input name="hash" required minLength={64} maxLength={64} pattern="[a-fA-F0-9]{64}" spellCheck={false} placeholder="64 hexadecimal characters" /></label><label><span>Supersedes version (optional)</span><select name="supersedesId" key={itemId} defaultValue=""><option value="">New asset lineage</option>{prior.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · v{asset.version}</option>)}</select></label><div className="asset-approval-form"><label className="check-row"><input name="rights" type="checkbox" /><span>Usage rights verified</span></label><label className="check-row"><input name="claims" type="checkbox" /><span>Advertising claims approved</span></label><label className="check-row"><input name="evidence" type="checkbox" /><span>Product evidence verified</span></label></div><label><span>Approval record</span><textarea name="note" rows={3} maxLength={1000} placeholder="Reviewer, source records, restrictions, and approval date" /></label><div className="inline-note"><FileCheck2 size={18} /><p>All three approvals create an approved version. Incomplete records remain drafts and cannot enter a product test.</p></div>{error && <div className="form-error" role="alert">{error}</div>}<button className="button primary setup-download" disabled={busy || !itemId}>{busy ? <Loader2 className="spin" size={15} /> : <FileCheck2 size={15} />} Register immutable version</button></form>;
}

function TestForm({ clientId, items, assets, onSaved }: { clientId: string; items: ProfitItemView[]; assets: ProfitAsset[]; onSaved: () => Promise<void> }) {
  const [itemId, setItemId] = useState(items[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const item = items.find((candidate) => candidate.id === itemId);
  const variables = item?.vertical === 'books'
    ? [['keyword', 'Keyword'], ['product-target', 'Product target']]
    : [['hook', 'Hook'], ['headline', 'Headline'], ['audience', 'Audience'], ['landing-page', 'Landing page']];
  const approvedAssets = assets.filter((asset) => asset.itemId === itemId && asset.status === 'approved');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const form = new FormData(event.currentTarget);
      const seeds = String(form.get('seeds') || '').split(/[\n,]/).map((seed) => seed.trim()).filter(Boolean);
      await api('/profit-control/tests', {
        dataset: 'workspace', clientId, itemId,
        hypothesis: String(form.get('hypothesis') || ''),
        variable: String(form.get('variable') || ''), seeds,
        count: Number(form.get('count')), lossBudgetCents: dollarInput(form.get('loss')),
        maxConcurrent: Number(form.get('concurrent')),
        assetIds: item?.vertical === 'commerce' ? [String(form.get('assetId') || '')].filter(Boolean) : [],
      });
      await onSaved();
    } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); }
  }
  return <form className="detail-stack connection-form" onSubmit={submit}><label><span>Profit item</span><select value={itemId} onChange={(event) => setItemId(event.target.value)}>{items.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><label><span>Variable under test</span><select name="variable" key={item?.vertical}>{variables.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{item?.vertical === 'commerce' && <label><span>Approved source asset version</span><select name="assetId" key={itemId} required defaultValue=""><option value="" disabled>{approvedAssets.length ? 'Choose approved version' : 'Register an approved asset first'}</option>{approvedAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · v{asset.version} · {asset.kind}</option>)}</select></label>}<label><span>Hypothesis</span><textarea name="hypothesis" rows={3} minLength={10} maxLength={1200} required placeholder="If we test this variable, then qualified response should improve because…" /></label><label><span>Verified seeds (comma or line separated)</span><textarea name="seeds" rows={4} required placeholder="reader intent, comparable title, product benefit" /></label><div className="money-form-grid"><label><span>Candidate count</span><input name="count" type="number" min="2" max="300" defaultValue="100" required /></label><label><span>Maximum concurrent</span><input name="concurrent" type="number" min="2" max="20" defaultValue="4" required /></label><label><span>Total learning loss boundary</span><input name="loss" inputMode="decimal" required placeholder="100.00" /></label></div><div className="inline-note"><ShieldCheck size={18} /><p>Approval stages only the first wave. Candidates remain held until evidence supports another wave.</p></div>{error && <div className="form-error" role="alert">{error}</div>}<button className="button primary setup-download" disabled={busy || !itemId || (item?.vertical === 'commerce' && !approvedAssets.length)}>{busy ? <Loader2 className="spin" size={15} /> : <FlaskConical size={15} />} Create test queue</button></form>;
}

const sourceKey = (source: Pick<ProfitExperimentSource, 'connectionId' | 'sourceKind' | 'externalId'>) =>
  JSON.stringify([source.connectionId, source.sourceKind, source.externalId]);

function TestWorkflow({ test, clientId, dataset, onClose, onChanged }: { test: ProfitTestPlan; clientId: string; dataset: Dataset; onClose: () => void; onChanged: (message: string) => Promise<void> }) {
  const wave = test.waves.at(-1);
  const [sources, setSources] = useState<ProfitExperimentSource[]>([]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [loadingSources, setLoadingSources] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!wave || wave.status !== 'setup') return;
    const controller = new AbortController();
    setLoadingSources(true);
    api<ProfitExperimentSource[]>(`/profit-control/tests/${test.id}/sources?dataset=${dataset}&clientId=${encodeURIComponent(clientId)}`, undefined, 'GET', controller.signal)
      .then(setSources)
      .catch((caught) => { if ((caught as Error).name !== 'AbortError') setError((caught as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoadingSources(false); });
    return () => controller.abort();
  }, [test.id, wave?.id, wave?.status, clientId, dataset]);
  if (!wave) return <Modal title={test.itemName} subtitle="This draft has no approved wave yet." onClose={onClose}><p className="inline-note">Approve the first bounded wave from the test queue.</p></Modal>;
  const currentWave = wave;
  const candidates = test.candidates.filter((candidate) => wave.candidateIds.includes(candidate.id));
  async function setup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const form = new FormData(event.currentTarget);
      const bindings = candidates.filter((candidate) => !candidate.binding).map((candidate) => {
        const chosen = sources.find((source) => sourceKey(source) === selections[candidate.id]);
        if (!chosen) throw new Error(`Choose an exact platform identity for ${candidate.label}.`);
        return { candidateId: candidate.id, connectionId: chosen.connectionId, sourceKind: chosen.sourceKind, externalId: chosen.externalId };
      });
      await api(`/profit-control/tests/${test.id}/waves/${currentWave.id}/setup`, { dataset: 'workspace', clientId, bindings, startDate: String(form.get('startDate') || ''), endDate: String(form.get('endDate') || ''), attributionDays: Number(form.get('attributionDays')), lossBudgetCents: dollarInput(form.get('loss')) });
      await onChanged(`Wave ${currentWave.sequence} registered and waiting for mature attribution evidence.`);
    } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); }
  }
  async function evaluate() {
    setBusy(true); setError('');
    try { await api(`/profit-control/tests/${test.id}/waves/${currentWave.id}/evaluate`, { dataset: 'workspace', clientId }); await onChanged(`Wave ${currentWave.sequence} evaluated from reconciled source facts.`); }
    catch (caught) { setError((caught as Error).message); } finally { setBusy(false); }
  }
  async function decide(action: 'next-wave' | 'complete' | 'stop') {
    setBusy(true); setError('');
    try { await api(`/profit-control/tests/${test.id}/waves/${currentWave.id}/decision`, { dataset: 'workspace', clientId, action }); await onChanged(action === 'next-wave' ? 'The next bounded wave is ready for exact platform mappings.' : 'The test decision was recorded.'); }
    catch (caught) { setError((caught as Error).message); } finally { setBusy(false); }
  }
  const today = new Date();
  const defaultEnd = new Date(today.getTime() - 15 * 86_400_000).toISOString().slice(0, 10);
  const defaultStart = new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  const remainingLossCents = Math.max(0, test.lossBudgetCents - test.waves.reduce((sum, candidate) => sum + candidate.totalRiskCents, 0));
  const sourceUsedByOther = (candidateId: string, key: string) => candidates.some((candidate) =>
    candidate.id !== candidateId && (candidate.binding ? sourceKey(candidate.binding) : selections[candidate.id]) === key);
  return <Modal title={`${test.itemName} · wave ${wave.sequence}`} subtitle="Exact platform identity, frozen window, mature evidence, then an operator decision." onClose={onClose}><div className="test-workflow"><div className="workflow-header"><Badge kind={wave.status === 'decided' ? 'scale' : 'purple'}>{wave.status}</Badge><span>{test.variable.replace('-', ' ')} · {money(test.lossBudgetCents)} total loss boundary</span></div>{wave.status === 'setup' && <form className="detail-stack connection-form" onSubmit={setup}><div className="inline-note"><Link2 size={18} /><p>Map each active arm to the exact entity created in the advertising console. Orbit will never infer this identity from a name.</p></div>{loadingSources ? <div className="loading-state"><Loader2 className="spin" size={18} /> Loading eligible platform identities…</div> : <div className="candidate-bindings">{candidates.map((candidate) => <label key={candidate.id}><span>{candidate.label}</span>{candidate.binding ? <div className="bound-source"><CheckCircle2 size={14} /> {candidate.binding.sourceName}</div> : <select required value={selections[candidate.id] || ''} onChange={(event) => setSelections((current) => ({ ...current, [candidate.id]: event.target.value }))}><option value="">Choose exact {test.variable === 'keyword' ? 'keyword' : test.variable === 'product-target' ? 'target' : 'ad'}</option>{sources.map((source) => <option key={sourceKey(source)} value={sourceKey(source)} disabled={sourceUsedByOther(candidate.id, sourceKey(source))}>{source.connectionName} · {source.sourceName} · {source.externalId}</option>)}</select>}</label>)}</div>}<div className="money-form-grid"><label><span>Window starts</span><input name="startDate" type="date" required defaultValue={defaultStart} /></label><label><span>Window ends</span><input name="endDate" type="date" required defaultValue={defaultEnd} /></label><label><span>Attribution maturity (days)</span><input name="attributionDays" type="number" min="1" max="30" defaultValue={test.variable === 'keyword' || test.variable === 'product-target' ? 14 : 7} required /></label><label><span>Wave loss boundary</span><input name="loss" inputMode="decimal" defaultValue={(remainingLossCents / 100).toFixed(2)} required /></label></div>{!sources.length && !loadingSources && <div className="form-error">No eligible source entities were found. Synchronize the provider and map its parent campaign to this item first.</div>}{error && <div className="form-error" role="alert">{error}</div>}<button className="button primary setup-download" disabled={busy || loadingSources || remainingLossCents <= 0 || dataset === 'demo'}>{busy ? <Loader2 className="spin" size={15} /> : <Play size={15} />} Register measured wave</button></form>}{wave.status === 'running' && <div className="detail-stack"><div className="wave-window"><CalendarClock size={22} /><div><strong>{wave.startDate} through {wave.endDate}</strong><span>{wave.attributionDays}-day attribution · matures {wave.expectedMatureAt ? new Date(wave.expectedMatureAt).toLocaleString() : 'after refresh'}</span></div></div><div className="candidate-bindings compact">{candidates.map((candidate) => <div key={candidate.id}><strong>{candidate.label}</strong><span>{candidate.binding?.sourceName || 'Missing binding'}</span></div>)}</div>{error && <div className="form-error" role="alert">{error}</div>}<button className="button primary setup-download" disabled={busy || dataset === 'demo'} onClick={() => void evaluate()}>{busy ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />} Evaluate mature source evidence</button></div>}{wave.status === 'decided' && <div className="detail-stack"><div className="wave-decision"><Trophy size={22} /><div><strong>{wave.recommendation?.replace('-', ' ')}</strong><p>{wave.reason}</p></div></div><div className="wave-results">{wave.results.map((result) => <div key={result.candidateId} className={result.verdict === 'winner' ? 'winner' : ''}><div><strong>{result.label}</strong><Badge kind={result.verdict === 'winner' || result.verdict === 'promising' ? 'scale' : result.verdict === 'loss-limit' || result.verdict === 'below-hurdle' ? 'reduce' : 'neutral'}>{result.verdict}</Badge></div><span>{money(result.spendCents)} spend</span><span>{result.attributedPurchases} purchases</span><span>{money(result.costPerPurchaseCents)} CPA</span><span>{money(result.screeningContributionCents)} screening contribution</span><p>{result.reason}</p></div>)}</div><div className="evidence-fingerprint"><span>Evidence fingerprint</span><code>{wave.evidenceFingerprint}</code></div>{error && <div className="form-error" role="alert">{error}</div>}{test.status !== 'completed' && <div className="wave-actions">{test.candidates.some((candidate) => candidate.status === 'held') && wave.recommendation !== 'stop' && <button className="button primary" disabled={busy} onClick={() => void decide('next-wave')}><ArrowRight size={14} /> Stage next wave</button>}<button className="button secondary" disabled={busy} onClick={() => void decide('complete')}><CheckCircle2 size={14} /> Complete test</button><button className="button ghost" disabled={busy} onClick={() => void decide('stop')}>Stop test</button></div>}</div>}</div></Modal>;
}
