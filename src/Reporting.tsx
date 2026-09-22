import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Database,
  Download,
  FileCheck2,
  FileUp,
  History,
  Info,
  Plus,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import type { Dashboard, ReportReceipt, ReportRevision, ReportSource } from '../shared/types';
import { Badge, ChannelMark, Empty, Modal } from './components';
import { api, channelName, date, money, number, timeAgo } from './lib';
import './reporting.css';

const profileNames: Record<ReportSource['profile'], string> = {
  'orbit-campaigns': 'Normalized campaign / day',
  'orbit-targets': 'Normalized target / day',
  'amazon-campaigns': 'Amazon campaign console CSV',
};
type HubData = { sources: ReportSource[]; batches: ReportReceipt[] };
type ModalState =
  | { type: 'source' }
  | { type: 'upload'; sourceId?: string }
  | { type: 'batch'; receipt: ReportReceipt }
  | { type: 'source-detail'; source: ReportSource }
  | null;

export function ReportingHub({
  data,
  query,
  onWorkspace,
  onCampaign,
}: {
  data: Dashboard;
  query: string;
  onWorkspace: () => void;
  onCampaign: () => void;
}) {
  const [hub, setHub] = useState<HubData>({ sources: [], batches: [] });
  const [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const [status, setStatus] = useState('all');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api<HubData>(`/reporting?dataset=${data.dataset}`, undefined, 'GET', controller.signal)
      .then((result) => {
        setHub(result);
        setError('');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [data.dataset, revision]);
  const refresh = () => setRevision((v) => v + 1);
  const staged = hub.batches.filter((b) => b.status === 'staged');
  const matching = hub.batches.filter(
    (b) =>
      (status === 'all' || b.status === status) &&
      `${b.fileName} ${b.sourceName}`.toLowerCase().includes(query.toLowerCase()),
  );
  if (data.dataset === 'demo')
    return (
      <div className="report-demo">
        <div className="report-hero">
          <div className="report-emblem">
            <Database size={32} />
          </div>
          <span className="eyebrow">A CLEAR PATH FROM REPORT TO DECISION</span>
          <h2>Bring the whole portfolio into view.</h2>
          <p>
            Save your account mappings once. Preview an entire report, understand its corrections,
            and apply every campaign together.
          </p>
          <button className="button primary" onClick={onWorkspace}>
            Open your reporting workspace
            <ArrowRight size={15} />
          </button>
        </div>
        <div className="report-explainer">
          {[
            [
              '01',
              'Map the source',
              'Pin the account, campaign IDs, currency, timezone, and attribution window.',
            ],
            [
              '02',
              'Inspect the differences',
              'See new, corrected, refreshed, and unchanged rows before they affect decisions.',
            ],
            [
              '03',
              'Keep the evidence trail',
              'Apply every campaign together and retain a before/after record of each changed observation.',
            ],
          ].map(([n, title, description]) => (
            <div key={n}>
              <span>{n}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
          ))}
        </div>
        <div className="inline-note">
          <Info size={20} />
          <p>
            Business reports belong in Your workspace. The demo remains synthetic. Batch uploads are
            available for product campaign/creative reports and the supported Amazon campaign CSV
            profile.
          </p>
        </div>
      </div>
    );
  return (
    <>
      <div className="report-toolbar">
        <div>
          <h2>Your reporting desk</h2>
          <p>Saved source contracts · reviewed batch imports · no live account connection</p>
        </div>
        <div>
          <button className="button secondary" onClick={() => setModal({ type: 'source' })}>
            <Plus size={15} />
            Add report source
          </button>
          <button
            className="button primary"
            disabled={!hub.sources.length}
            onClick={() => setModal({ type: 'upload' })}
          >
            <FileUp size={15} />
            Stage report
          </button>
        </div>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
          <button className="button secondary" onClick={refresh}>
            Retry
          </button>
        </div>
      )}
      <div className="report-summary">
        <div>
          <Database size={21} />
          <span>
            <strong>{hub.sources.length}</strong> saved sources
          </span>
        </div>
        <div>
          <FileCheck2 size={21} />
          <span>
            <strong>{staged.length}</strong> awaiting review
          </span>
        </div>
        <div>
          <History size={21} />
          <span>
            <strong>{hub.batches.filter((b) => b.status === 'committed').length}</strong> applied
            reports
          </span>
        </div>
      </div>
      {!hub.sources.length && !loading && (
        <Empty
          icon={<Unplug size={30} />}
          title="Start with a trusted reporting source"
          action={
            <button
              className="button primary"
              onClick={() => (data.campaigns.length ? setModal({ type: 'source' }) : onCampaign())}
            >
              <Plus size={15} />
              {data.campaigns.length ? 'Map your first source' : 'Create a campaign first'}
            </button>
          }
        >
          Connect a report’s external campaign IDs to existing local campaigns. Reports do not
          create campaigns or invent their unit economics.
        </Empty>
      )}
      <div className="report-sources">
        {hub.sources
          .filter((s) => `${s.name} ${s.accountRef}`.toLowerCase().includes(query.toLowerCase()))
          .map((s) => {
            const latest = hub.batches
              .filter((b) => b.sourceId === s.id && b.status === 'committed')
              .sort((a, b) => b.committedAt!.localeCompare(a.committedAt!))[0];
            return (
              <article className="report-source-card" key={s.id}>
                <div className="report-source-top">
                  <ChannelMark channel={s.provider} />
                  <Badge kind="neutral">CSV source</Badge>
                </div>
                <h3>{s.name}</h3>
                <p>{profileNames[s.profile]}</p>
                <div className="source-account">
                  {s.accountRef} · {s.mappings.length} campaigns
                </div>
                <div className="source-freshness">
                  <span className={latest ? 'report-dot' : 'report-dot empty'} />
                  {latest
                    ? `Last applied export: ${date(latest.exportedAt)} · ${timeAgo(latest.exportedAt)}`
                    : 'No applied reports yet'}
                </div>
                <div className="source-card-actions">
                  <button
                    className="button secondary small-button"
                    onClick={() => setModal({ type: 'source-detail', source: s })}
                  >
                    View contract
                  </button>
                  <button
                    className="button primary small-button"
                    onClick={() => setModal({ type: 'upload', sourceId: s.id })}
                  >
                    Stage CSV
                    <ArrowRight size={14} />
                  </button>
                </div>
              </article>
            );
          })}
      </div>
      <section className="panel report-history">
        <div className="panel-heading">
          <div>
            <h2>Report inbox</h2>
            <p>Applied reports keep their original preview and correction history.</p>
          </div>
          <select
            aria-label="Filter report status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All reports</option>
            <option value="staged">Awaiting review</option>
            <option value="committed">Applied</option>
            <option value="discarded">Discarded</option>
          </select>
        </div>
        <div className="table-scroll" role="region" aria-label="Report inbox table" tabIndex={0}>
          <table className="report-table">
            <thead>
              <tr>
                <th>Report / source</th>
                <th>Reporting dates</th>
                <th>Rows</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Inspect report</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {matching.map((b) => (
                <tr key={b.id}>
                  <td>
                    <button
                      className="report-name"
                      onClick={() => setModal({ type: 'batch', receipt: b })}
                    >
                      <strong>{b.fileName}</strong>
                      <span>{b.sourceName}</span>
                    </button>
                  </td>
                  <td>
                    {date(b.preview.startDate)} – {date(b.preview.endDate)}
                  </td>
                  <td>{number(b.preview.rows)}</td>
                  <td>
                    <Badge
                      kind={
                        b.status === 'committed'
                          ? 'scale'
                          : b.preview.errors.length
                            ? 'repair'
                            : 'neutral'
                      }
                    >
                      {b.status === 'committed'
                        ? 'Applied'
                        : b.status === 'discarded'
                          ? 'Discarded'
                          : b.preview.errors.length
                            ? 'Conflicts'
                            : 'Ready for review'}
                    </Badge>
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Inspect report ${b.fileName}`}
                      onClick={() => setModal({ type: 'batch', receipt: b })}
                    >
                      <ArrowRight size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!matching.length && (
          <div className="empty-inline">
            {loading
              ? 'Loading report history…'
              : 'No reports here yet. Stage a CSV to inspect its changes.'}
          </div>
        )}
      </section>
      <div className="inline-note page-note">
        <Info size={18} />
        <p>
          A recent source upload does not prove every campaign is current. Missing days stay
          missing, absent campaigns are retained, and the evidence engine checks individual cohorts.
        </p>
      </div>
      {modal && (
        <Modal
          title={
            modal.type === 'source'
              ? 'Register a report source'
              : modal.type === 'upload'
                ? 'Stage a portfolio report'
                : modal.type === 'source-detail'
                  ? modal.source.name
                  : modal.receipt.fileName
          }
          onClose={() => setModal(null)}
          wide={modal.type !== 'upload'}
        >
          {modal.type === 'source' && (
            <SourceForm
              data={data}
              sources={hub.sources}
              onSaved={(source) => {
                refresh();
                setModal({ type: 'source-detail', source });
              }}
            />
          )}
          {modal.type === 'upload' && (
            <BatchForm
              sources={hub.sources}
              initialSourceId={modal.sourceId}
              onStaged={(receipt) => {
                refresh();
                setModal({ type: 'batch', receipt });
              }}
            />
          )}
          {modal.type === 'source-detail' && (
            <SourceDetail
              source={modal.source}
              campaigns={data.campaigns}
              canRemove={!hub.batches.some((b) => b.sourceId === modal.source.id)}
              onRemoved={() => {
                setModal(null);
                refresh();
              }}
              onStage={() => setModal({ type: 'upload', sourceId: modal.source.id })}
            />
          )}
          {modal.type === 'batch' && (
            <BatchDetail key={modal.receipt.id} initial={modal.receipt} onUpdated={refresh} />
          )}
        </Modal>
      )}
    </>
  );
}

function SourceForm({
  data,
  sources,
  onSaved,
}: {
  data: Dashboard;
  sources: ReportSource[];
  onSaved: (s: ReportSource) => void;
}) {
  const [provider, setProvider] = useState<ReportSource['provider']>('amazon');
  const [profile, setProfile] = useState<ReportSource['profile']>('amazon-campaigns');
  const [window, setWindow] = useState(14);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const available = data.campaigns.filter(
    (c) =>
      c.channel === provider &&
      c.attributionDays === window &&
      !sources.some(
        (s) =>
          (s.profile === 'orbit-targets') === (profile === 'orbit-targets') &&
          s.mappings.some((m) => m.campaignId === c.id),
      ),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(event.currentTarget);
    try {
      onSaved(
        await api<ReportSource>('/reporting/sources', {
          dataset: data.dataset,
          name: f.get('name'),
          provider,
          accountRef: f.get('account'),
          profile,
          attributionDays: window,
          timezone: 'UTC',
          currency: 'USD',
          contractVerified: f.get('verified') === 'on',
          mappings: available
            .filter((c) => mappings[c.id] !== undefined)
            .map((c) => ({ campaignId: c.id, externalCampaignId: mappings[c.id] })),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="inline-note">
        <Info size={19} />
        <p>
          This saves a CSV reporting contract. No API credentials are needed. Use one account and
          one consistent reporting definition per source.
        </p>
      </div>
      <label>
        Source name
        <input
          name="name"
          required
          maxLength={160}
          placeholder="Publisher account · daily campaign reports"
        />
      </label>
      <div className="form-grid">
        <label>
          Advertising platform
          <select
            value={provider}
            onChange={(e) => {
              const p = e.target.value as ReportSource['provider'];
              setProvider(p);
              setProfile(p === 'amazon' ? 'amazon-campaigns' : 'orbit-campaigns');
              setWindow(p === 'amazon' ? 14 : 7);
              setMappings({});
            }}
          >
            <option value="amazon">Amazon Ads</option>
            <option value="meta">Meta Ads</option>
            <option value="tiktok">TikTok Ads</option>
          </select>
        </label>
        <label>
          Account reference
          <input
            name="account"
            required
            maxLength={120}
            pattern="[a-zA-Z0-9_.:\-]+"
            placeholder="Stable account ID or local account reference"
          />
        </label>
      </div>
      <div className="form-grid">
        <label>
          Report profile
          <select
            value={profile}
            onChange={(e) => {
              setProfile(e.target.value as ReportSource['profile']);
              setMappings({});
            }}
          >
            {Object.entries(profileNames)
              .filter(([p]) => p !== 'amazon-campaigns' || provider === 'amazon')
              .map(([p, name]) => (
                <option key={p} value={p}>
                  {name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Click attribution window (days)
          <input
            type="number"
            required
            min="1"
            max="30"
            value={window}
            onChange={(e) => {
              setWindow(Number(e.target.value));
              setMappings({});
            }}
          />
        </label>
      </div>
      <div className="report-contract-note">
        <strong>USD · UTC reporting dates · click-attributed purchase events</strong>
        <p>
          These must match the report’s actual definitions. Relabeling another timezone as UTC does
          not convert its daily totals. Exclude view-through purchases and unit counts.
        </p>
      </div>
      <h3 className="mapping-heading">Map the campaigns</h3>
      <p className="form-help">
        {profile === 'amazon-campaigns'
          ? 'Use the exact exported Campaign Name. Names are a console-export fallback; do not rename or reuse them during this contract.'
          : 'Use stable external campaign IDs. Every CSV row must also carry this source’s account_id.'}{' '}
        One local campaign can have one campaign source and one target source.
      </p>
      <div className="source-mappings">
        {available.map((c) => (
          <div className="source-mapping" key={c.id}>
            <label className="report-check">
              <input
                type="checkbox"
                checked={mappings[c.id] !== undefined}
                onChange={(e) =>
                  setMappings((old) => {
                    const next = { ...old };
                    if (e.target.checked) next[c.id] = profile === 'amazon-campaigns' ? c.name : '';
                    else delete next[c.id];
                    return next;
                  })
                }
              />
              {c.name}
            </label>
            {mappings[c.id] !== undefined && (
              <label>
                {profile === 'amazon-campaigns'
                  ? 'Exact exported campaign name'
                  : 'External campaign ID'}
                <input
                  aria-label={`External mapping for ${c.name}`}
                  required
                  maxLength={160}
                  value={mappings[c.id]}
                  onChange={(e) => setMappings((old) => ({ ...old, [c.id]: e.target.value }))}
                />
              </label>
            )}
          </div>
        ))}
      </div>
      {!available.length && (
        <p className="form-help">
          No unmapped campaigns match this platform and attribution window. Add a matching campaign,
          change the window, or reuse an existing source.
        </p>
      )}
      <label className="report-check">
        <input type="checkbox" required name="verified" />I verified the account, campaign mappings,
        currency, timezone, click window, and purchase definition against the source report.
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span>Contracts remain fixed after report history exists.</span>
        <button className="button primary" disabled={busy || !Object.keys(mappings).length}>
          {busy ? 'Saving…' : 'Save report source'}
        </button>
      </div>
    </form>
  );
}

function SourceDetail({
  source,
  campaigns,
  canRemove,
  onRemoved,
  onStage,
}: {
  source: ReportSource;
  campaigns: Dashboard['campaigns'];
  canRemove: boolean;
  onRemoved: () => void;
  onStage: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    try {
      await api(`/reporting/sources/${source.id}`, { dataset: source.dataset }, 'DELETE');
      onRemoved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="detail-stack">
      <div className="detail-identity">
        <ChannelMark channel={source.provider} />
        <div>
          <strong>
            {channelName[source.provider]} · {source.accountRef}
          </strong>
          <span>{profileNames[source.profile]}</span>
        </div>
        <Badge kind="neutral">CSV source</Badge>
      </div>
      <div className="detail-metrics">
        <div>
          <span>Reporting contract</span>
          <strong>USD / UTC</strong>
        </div>
        <div>
          <span>Click attribution</span>
          <strong>{source.attributionDays} days</strong>
        </div>
        <div>
          <span>Mapped campaigns</span>
          <strong>{source.mappings.length}</strong>
        </div>
      </div>
      <div
        className="table-scroll"
        role="region"
        aria-label="Campaign source mappings"
        tabIndex={0}
      >
        <table className="report-table">
          <thead>
            <tr>
              <th>
                External {source.profile === 'amazon-campaigns' ? 'campaign name' : 'campaign ID'}
              </th>
              <th>Local campaign</th>
            </tr>
          </thead>
          <tbody>
            {source.mappings.map((m) => (
              <tr key={m.campaignId}>
                <td>{m.externalCampaignId}</td>
                <td>{campaigns.find((c) => c.id === m.campaignId)?.name || m.campaignId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="form-help">
        {source.profile === 'amazon-campaigns'
          ? 'Export a daily campaign report from the intended advertising account. The supported English headers are in the template. The CSV cannot independently prove which account produced it.'
          : 'The normalized template is an Orbit contract, not a native Meta/TikTok export schema. Convert the report deliberately and preserve the account, IDs, dates, and attribution definitions.'}
      </p>
      <p className="form-help">
        Contract {source.contractId.slice(0, 16)} · registered{' '}
        {new Date(source.createdAt).toLocaleString()}
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="source-detail-actions">
        <a
          className="button secondary"
          href={`/api/reporting/sources/${source.id}/template?dataset=${source.dataset}`}
        >
          <Download size={15} />
          Download template
        </a>
        <button className="button primary" onClick={onStage}>
          <FileUp size={15} />
          Stage a report
        </button>
        {canRemove && (
          <button className="button secondary" disabled={busy} onClick={remove}>
            Remove unused source
          </button>
        )}
      </div>
    </div>
  );
}

function BatchForm({
  sources,
  initialSourceId,
  onStaged,
}: {
  sources: ReportSource[];
  initialSourceId?: string;
  onStaged: (b: ReportReceipt) => void;
}) {
  const [sourceId, setSourceId] = useState(initialSourceId || sources[0]?.id || '');
  const [csv, setCsv] = useState(''),
    [fileName, setFileName] = useState('pasted-report.csv');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const source = sources.find((s) => s.id === sourceId)!;
  const localTime = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      onStaged(
        await api<ReportReceipt>('/reporting/batches', {
          dataset: 'workspace',
          sourceId,
          fileName,
          exportedAt: new Date(String(form.get('exportedAt'))).toISOString(),
          csv,
          exportVerified: form.get('exportVerified') === 'on',
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        Saved source
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="report-contract-note">
        <strong>{profileNames[source.profile]}</strong>
        <p>
          {source.accountRef} · USD / UTC · {source.attributionDays}-day click attribution ·{' '}
          {source.mappings.length} mapped campaigns
        </p>
        <a href={`/api/reporting/sources/${source.id}/template?dataset=workspace`}>
          Download this source’s template
        </a>
      </div>
      <label>
        Choose a CSV
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 1_000_000) {
              setError('Choose a CSV up to 1 MB.');
              return;
            }
            setFileName(file.name);
            setCsv(await file.text());
            setError('');
          }}
        />
      </label>
      <label>
        Report label
        <input
          required
          maxLength={120}
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
        />
      </label>
      <label>
        Or paste the report CSV
        <textarea
          rows={7}
          required
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          maxLength={1000000}
          spellCheck={false}
        />
      </label>
      <label>
        Actual export time (your local time)
        <input type="datetime-local" name="exportedAt" defaultValue={localTime} required />
      </label>
      <p className="form-help">
        Use the time the reporting system produced this data, not when you uploaded or downloaded an
        older file. It is stored as a UTC timestamp. The report’s daily dates must already follow
        the source’s UTC contract.
      </p>
      <label className="report-check">
        <input type="checkbox" required name="exportVerified" />I checked the actual export time and
        this report’s account, attribution, and date definitions.
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span>Staging leaves performance data unchanged.</span>
        <button className="button primary" disabled={busy}>
          <FileCheck2 size={15} />
          {busy ? 'Inspecting…' : 'Preview report'}
        </button>
      </div>
    </form>
  );
}

function BatchDetail({ initial, onUpdated }: { initial: ReportReceipt; onUpdated: () => void }) {
  const [batch, setBatch] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const p = batch.preview;
  async function action(command: 'refresh' | 'commit' | 'discard') {
    setBusy(true);
    setError('');
    try {
      const updated = await api<ReportReceipt>(`/reporting/batches/${batch.id}/${command}`, {
        dataset: batch.dataset,
        ...(command === 'commit' ? { fingerprint: p.fingerprint } : {}),
      });
      setBatch(updated);
      onUpdated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="detail-stack report-preview">
      <div className="detail-identity">
        <FileCheck2 size={25} />
        <div>
          <strong>{batch.sourceName}</strong>
          <span>
            Exported {new Date(batch.exportedAt).toLocaleString()} · {date(p.startDate)} –{' '}
            {date(p.endDate)}
          </span>
        </div>
        <Badge kind={batch.status === 'committed' ? 'scale' : 'neutral'}>
          {batch.status === 'committed'
            ? 'Applied'
            : batch.status === 'discarded'
              ? 'Discarded'
              : 'Preview'}
        </Badge>
      </div>
      <div className="report-counts">
        {[
          ['inserted', 'New rows'],
          ['corrected', 'Corrections'],
          ['refreshed', 'Freshness updates'],
          ['unchanged', 'Unchanged'],
        ].map(([key, title]) => (
          <div key={key}>
            <span>{title}</span>
            <strong>{number(p.counts[key as keyof typeof p.counts])}</strong>
          </div>
        ))}
      </div>
      <div className="report-impact">
        <div>
          <span>
            {p.campaignSpendDeltaCents === null
              ? 'Target breakdown spend'
              : 'Change to portfolio ad spend'}
          </span>
          <strong>{money(p.campaignSpendDeltaCents ?? p.spendCents, 2)}</strong>
          <small>
            {p.campaignSpendDeltaCents === null
              ? 'Target facts do not add to portfolio totals.'
              : 'For the included dates and campaigns only.'}
          </small>
        </div>
        <div>
          <span>Coverage in this file</span>
          <strong>
            {p.campaignCount} campaigns · {number(p.rows)} rows
          </strong>
          <small>
            {p.targetCount
              ? `${p.targetCount} measured target definitions`
              : 'Campaign daily totals'}
          </small>
        </div>
      </div>
      {p.errors.length > 0 && (
        <div className="form-error">
          <strong>Resolve these conflicts before applying</strong>
          <ul>
            {p.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {p.warnings.length > 0 && (
        <div className="report-warnings">
          <strong>Report notes</strong>
          <ul>
            {p.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {p.affectedLearningIds.length > 0 && (
        <div className="inline-note">
          <History size={18} />
          <p>
            {p.affectedLearningIds.length} recorded learning snapshots overlap these changed facts.
            Original findings remain available and will be flagged for review if their evidence
            changes.
          </p>
        </div>
      )}
      <div
        className="table-scroll"
        role="region"
        aria-label="Campaign changes in this report"
        tabIndex={0}
      >
        <table className="report-table">
          <thead>
            <tr>
              <th>Local campaign</th>
              <th>New</th>
              <th>Corrected</th>
              <th>Refreshed</th>
              <th>Spend in file</th>
            </tr>
          </thead>
          <tbody>
            {p.campaigns.map((c) => (
              <tr key={c.campaignId}>
                <td>{c.name}</td>
                <td>{c.counts.inserted}</td>
                <td>{c.counts.corrected}</td>
                <td>{c.counts.refreshed}</td>
                <td>{money(c.spendCents, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="form-help">
        Preview covers this batch only. It does not delete missing rows or certify a complete
        account report.
      </p>
      <details className="form-help report-receipt-reference">
        <summary>Receipt references</summary>
        <p>
          File SHA-256: {batch.contentHash}
          <br />
          Source contract: {batch.sourceContractId}
        </p>
      </details>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {batch.status === 'staged' && (
        <div className="report-actions">
          <button className="button secondary" disabled={busy} onClick={() => action('discard')}>
            Discard preview
          </button>
          <button className="button secondary" disabled={busy} onClick={() => action('refresh')}>
            <RefreshCw size={15} />
            Refresh preview
          </button>
          <button
            className="button primary"
            disabled={busy || p.errors.length > 0}
            onClick={() => action('commit')}
          >
            <CheckCircle2 size={15} />
            {busy ? 'Working…' : 'Apply report batch'}
          </button>
        </div>
      )}
      {batch.status === 'committed' && (
        <div className="inline-note">
          <CheckCircle2 size={20} />
          <p>
            Applied {new Date(batch.committedAt!).toLocaleString()}. Replaying this same source,
            file, and export time returns this receipt without importing again.
          </p>
        </div>
      )}
      {batch.status !== 'discarded' && (
        <RevisionHistory key={`${batch.status}-${batch.preview.fingerprint}`} batch={batch} />
      )}
    </div>
  );
}

function RevisionHistory({ batch }: { batch: ReportReceipt }) {
  const [offset, setOffset] = useState(0),
    [data, setData] = useState<{ total: number; revisions: ReportRevision[] } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    api<{ total: number; revisions: ReportRevision[] }>(
      `/reporting/batches/${batch.id}/revisions?dataset=${batch.dataset}&offset=${offset}`,
      undefined,
      'GET',
      c.signal,
    )
      .then((v) => {
        setData(v);
        setError('');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => c.abort();
  }, [batch.id, batch.dataset, offset]);
  return (
    <section className="report-revisions">
      <h3>{batch.status === 'staged' ? 'Proposed row changes' : 'Before and after'}</h3>
      <p className="form-help">
        {batch.status === 'staged'
          ? 'Compare the stored observations with this report before applying it. No observations have changed.'
          : 'Original changed observations, including freshness-only revisions. Unchanged rows do not create duplicate history.'}
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="revision-list">
        {data?.revisions.map((r, i) => (
          <details key={`${offset}-${i}`}>
            <summary>
              <span>
                {r.label} · {date(r.date)}
              </span>
              <span>
                {r.before ? `${money(r.before.spendCents, 2)} → ` : 'New: '}
                {money(r.after.spendCents, 2)}
              </span>
            </summary>
            <div className="revision-values">
              {(
                [
                  'impressions',
                  'clicks',
                  'orders',
                  'spendCents',
                  'salesCents',
                  'refundsCents',
                ] as const
              ).map((key) => (
                <div key={key}>
                  <span>
                    {
                      {
                        impressions: 'Impressions',
                        clicks: 'Clicks',
                        orders: 'Purchases',
                        spendCents: 'Ad spend',
                        salesCents: 'Attributed sales',
                        refundsCents: 'Net receipt refunds',
                      }[key]
                    }
                  </span>
                  <strong>
                    {r.before
                      ? key.endsWith('Cents')
                        ? money(r.before[key], 2)
                        : number(r.before[key])
                      : '—'}{' '}
                    → {key.endsWith('Cents') ? money(r.after[key], 2) : number(r.after[key])}
                  </strong>
                </div>
              ))}
            </div>
            <p className="form-help">
              Export timestamp: {r.before?.observedAt || 'No prior row'} → {r.after.observedAt}
            </p>
          </details>
        ))}
      </div>
      {data && (
        <div className="pagination">
          <span>
            {data.total ? offset + 1 : 0}–{Math.min(offset + 25, data.total)} of {data.total}{' '}
            revisions
          </span>
          <div>
            <button
              className="button secondary small-button"
              disabled={offset === 0}
              onClick={() => setOffset((o) => o - 25)}
            >
              Previous
            </button>
            <button
              className="button secondary small-button"
              disabled={offset + 25 >= data.total}
              onClick={() => setOffset((o) => o + 25)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
