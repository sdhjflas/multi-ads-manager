import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  Download,
  FlaskConical,
  History,
  Info,
  LockKeyhole,
  Plus,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type {
  Dashboard,
  Experiment,
  LearningView,
  Target,
  WaveOutcome,
  WaveView,
} from '../shared/types';
import { Badge, ChannelMark, Empty } from './components';
import { api, date, dollarInput, money, number } from './lib';
import './waves.css';

const outcomeLabel: Record<WaveOutcome, string> = {
  scheduled: 'Scheduled',
  collecting: 'Maturing',
  repair: 'Evidence needed',
  'limit-reached': 'Limit reached',
  promising: 'Ready to confirm',
  'baseline-leading': 'Baseline leads',
  unprofitable: 'Below hurdle',
  inconclusive: 'Inconclusive',
};
const outcomeKind = (o: WaveOutcome) =>
  o === 'promising'
    ? ('scale' as const)
    : o === 'repair'
      ? ('repair' as const)
      : o === 'limit-reached' || o === 'unprofitable'
        ? ('reduce' as const)
        : ('neutral' as const);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(d.slice(0, 10) + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
type Mapping = Pick<Target, 'sourceId' | 'label' | 'kind' | 'matchType'>;

export function WaveForm({
  data,
  experiment,
  onSaved,
}: {
  data: Dashboard;
  experiment: Experiment;
  onSaved: () => void;
}) {
  const campaign = data.campaigns.find((c) => c.id === experiment.campaignId)!;
  const shortlisted = experiment.variants.filter((v) => v.state === 'shortlisted');
  const targets = data.targets.filter((t) => t.campaignId === campaign.id);
  const empty = (label = ''): Mapping => ({
    sourceId: '',
    label,
    kind: campaign.vertical === 'books' ? 'keyword' : 'creative',
    matchType: campaign.vertical === 'books' ? 'exact' : 'creative',
  });
  const [mappings, setMappings] = useState<Record<string, Mapping>>(() =>
    Object.fromEntries([['baseline', empty()], ...shortlisted.map((v) => [v.id, empty(v.label)])]),
  );
  const [included, setIncluded] = useState(shortlisted.map((v) => v.id));
  const [registration, setRegistration] = useState('prospective');
  const [start, setStart] = useState(addDays(data.reportingAt, 1));
  const [end, setEnd] = useState(addDays(data.reportingAt, 14));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (!shortlisted.length)
    return (
      <Empty icon={<FlaskConical size={28} />} title="Shortlist a challenger first">
        Select at least one candidate in this experiment’s library before registering its
        measurement wave.
      </Empty>
    );
  function update(key: string, patch: Partial<Mapping>) {
    setMappings((all) => ({ ...all, [key]: { ...all[key], ...patch } }));
  }
  function mappingFields(key: string, label: string) {
    const value = mappings[key];
    const existing = targets.find(
      (t) =>
        t.sourceId === value.sourceId && t.label === value.label && t.matchType === value.matchType,
    );
    return (
      <fieldset className="arm-mapping" key={key}>
        <legend>{label}</legend>
        <label>
          Reporting cell
          <select
            aria-label={`${label} reporting cell`}
            value={existing?.id || ''}
            onChange={(e) => {
              const t = targets.find((t) => t.id === e.target.value);
              update(
                key,
                t
                  ? { sourceId: t.sourceId, label: t.label, kind: t.kind, matchType: t.matchType }
                  : empty(
                      key === 'baseline'
                        ? ''
                        : experiment.variants.find((v) => v.id === key)!.label,
                    ),
              );
            }}
          >
            <option value="">Enter a reporting ID</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} · {t.matchType} · {t.sourceId}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label>
            Target / creative ID
            <input
              aria-label={`${label} reporting ID`}
              required
              maxLength={120}
              pattern="[a-zA-Z0-9_.:\-]+"
              value={value.sourceId}
              onChange={(e) => update(key, { sourceId: e.target.value })}
            />
          </label>
          <label>
            Report label
            <input
              aria-label={`${label} report label`}
              required
              maxLength={200}
              value={value.label}
              onChange={(e) => update(key, { label: e.target.value })}
            />
          </label>
        </div>
        {campaign.vertical === 'books' && (
          <label>
            Match type
            <select
              aria-label={`${label} match type`}
              value={value.matchType}
              onChange={(e) =>
                update(key, {
                  matchType: e.target.value as Target['matchType'],
                  kind: e.target.value === 'product' ? 'product-target' : 'keyword',
                })
              }
            >
              <option value="exact">Exact</option>
              <option value="phrase">Phrase</option>
              <option value="broad">Broad</option>
              <option value="auto">Automatic target</option>
              {key === 'baseline' && <option value="product">Product target</option>}
            </select>
          </label>
        )}
      </fieldset>
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(event.currentTarget);
    try {
      await api('/waves', {
        dataset: data.dataset,
        experimentId: experiment.id,
        name: f.get('name'),
        registration,
        mappingVerified: f.get('mappingVerified') === 'on',
        startDate: start,
        endDate: end,
        budgetCents: dollarInput(f.get('budget')),
        lossLimitCents: dollarInput(f.get('loss')),
        minClicksPerArm: Number(f.get('clicks')),
        minLiftCentsPer100Clicks: dollarInput(f.get('lift')),
        arms: [
          { ...mappings.baseline, role: 'baseline', variantId: null },
          ...included.map((id) => ({ ...mappings[id], role: 'challenger', variantId: id })),
        ],
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack wave-form" onSubmit={submit}>
      <div className="inline-note">
        <LockKeyhole size={20} />
        <p>
          Freeze one question, a baseline, and the reporting IDs for each challenger. This creates a
          measurement plan and local budget reservation. Set up delivery in your advertising
          console.
        </p>
      </div>
      <label>
        Wave name
        <input
          name="name"
          required
          minLength={3}
          maxLength={160}
          defaultValue={`${experiment.name.slice(0, 120)} · wave ${data.waves.filter((w) => w.experimentId === experiment.id).length + 1}`}
        />
      </label>
      <label>
        Registration
        <select
          value={registration}
          onChange={(e) => {
            setRegistration(e.target.value);
            setStart(addDays(data.reportingAt, e.target.value === 'prospective' ? 1 : -35));
            setEnd(addDays(data.reportingAt, e.target.value === 'prospective' ? 14 : -22));
          }}
        >
          <option value="prospective">Register before the test begins</option>
          <option value="retrospective">Review an existing historical test</option>
        </select>
      </label>
      {registration === 'retrospective' && (
        <p className="form-help">
          This will be labeled a historical review. Selecting candidates after seeing results can
          bias the finding.
        </p>
      )}
      <div className="form-grid">
        <label>
          First reporting day
          <input type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          Last reporting day
          <input type="date" required value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label>
          Wave budget ($)
          <input
            name="budget"
            inputMode="decimal"
            required
            defaultValue={(Math.min(experiment.budgetCents, 30000) / 100).toFixed(2)}
          />
        </label>
        <label>
          Mature loss boundary ($)
          <input
            name="loss"
            inputMode="decimal"
            required
            defaultValue={(Math.min(experiment.budgetCents / 2, 15000) / 100).toFixed(2)}
          />
        </label>
        <label>
          Minimum clicks per arm
          <input name="clicks" type="number" min="100" max="1000000" required defaultValue="100" />
        </label>
        <label>
          Minimum gain per 100 clicks ($)
          <input name="lift" inputMode="decimal" required defaultValue="5.00" />
        </label>
      </div>
      <p className="form-help">
        Use a 7–56 day window. Decisions wait for the last cohort’s {campaign.attributionDays}-day
        attribution window. The click floor is a screening rule, not a power calculation. Budgets
        and losses require console monitoring.
      </p>
      {mappingFields('baseline', 'Baseline')}
      {shortlisted.map((v, i) => (
        <div className="challenger-mapping" key={v.id}>
          <label className="check-row">
            <input
              type="checkbox"
              checked={included.includes(v.id)}
              onChange={(e) =>
                setIncluded((old) =>
                  e.target.checked ? [...old, v.id] : old.filter((id) => id !== v.id),
                )
              }
            />
            Include challenger {i + 1}: {v.value}
          </label>
          {included.includes(v.id) && mappingFields(v.id, `Challenger ${i + 1}`)}
        </div>
      ))}
      <label className="check-row">
        <input type="checkbox" required name="mappingVerified" />I checked that each reporting ID
        represents its assigned baseline or candidate.
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span>Frozen plans keep results traceable.</span>
        <button className="button primary" disabled={busy || !included.length}>
          <Plus size={15} />
          {busy ? 'Registering…' : 'Register test wave'}
        </button>
      </div>
    </form>
  );
}

export function WaveBoard({
  data,
  query,
  onOpen,
  onLab,
}: {
  data: Dashboard;
  query: string;
  onOpen: (id: string) => void;
  onLab: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const waves = data.waves.filter(
    (w) =>
      `${w.name} ${w.campaignSnapshot.entityName} ${w.hypothesis}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === 'all' || w.status === filter),
  );
  const active = data.waves.filter((w) => w.status === 'measuring');
  return (
    <>
      <div className="wave-summary">
        <div>
          <FlaskConical size={22} />
          <span>
            <strong>{active.length}</strong> open waves
          </span>
        </div>
        <div>
          <LockKeyhole size={22} />
          <span>
            <strong>
              {money(active.reduce((s, w) => s + w.evaluation.remainingPlanCents, 0))}
            </strong>{' '}
            local planning reservations
          </span>
        </div>
        <div>
          <BookOpen size={22} />
          <span>
            <strong>{data.learnings.filter((l) => !l.superseded).length}</strong> recorded findings
          </span>
        </div>
      </div>
      <div className="section-heading">
        <div>
          <h2>From hypothesis to evidence</h2>
          <p className="form-help">Both portfolios · full registered test windows</p>
        </div>
        <select
          className="wave-status-filter"
          aria-label="Filter wave status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All waves</option>
          <option value="measuring">Open</option>
          <option value="closed">Concluded</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <div className="wave-grid">
        {waves.map((w) => (
          <button className="wave-card" key={w.id} onClick={() => onOpen(w.id)}>
            <div className="wave-card-top">
              <ChannelMark channel={w.campaignSnapshot.channel} />
              <Badge
                kind={w.status === 'cancelled' ? 'neutral' : outcomeKind(w.evaluation.outcome)}
              >
                {w.status === 'cancelled'
                  ? 'Cancelled'
                  : w.status === 'closed'
                    ? 'Concluded'
                    : outcomeLabel[w.evaluation.outcome]}
              </Badge>
            </div>
            <span className="eyebrow">
              {w.registration === 'retrospective' ? 'HISTORICAL REVIEW' : 'REGISTERED BEFORE START'}
            </span>
            <h3>{w.name}</h3>
            <p>{w.campaignSnapshot.entityName}</p>
            <div className="wave-window">
              <CalendarDays size={14} />
              {date(w.startDate)} – {date(w.endDate)}
              <span>{w.arms.length} arms</span>
            </div>
            <div className="wave-budget-label">
              <span>{money(w.evaluation.spentCents)} observed</span>
              <span>{money(w.budgetCents)} plan</span>
            </div>
            <div className="wave-budget-track">
              <span
                style={{
                  width: `${Math.min(100, (w.evaluation.spentCents / w.budgetCents) * 100)}%`,
                }}
              />
            </div>
            <div className="wave-card-footer">
              <span>{w.evaluation.title}</span>
              <ArrowRight size={16} />
            </div>
          </button>
        ))}
      </div>
      {!waves.length && (
        <Empty
          icon={<FlaskConical size={30} />}
          title={data.waves.length ? 'No matching waves' : 'Give your next test a finish line'}
          action={
            <button className="button primary" onClick={onLab}>
              Open experiment lab
              <ArrowRight size={15} />
            </button>
          }
        >
          Open a candidate library, shortlist challengers, and register a baseline and measurement
          window. Then import their campaign and target reports.
        </Empty>
      )}
      <div className="inline-note page-note">
        <Info size={19} />
        <p>
          These are observational comparisons of click-attributed performance. Platform delivery can
          differ between arms. Use a controlled confirmation test before broader scaling; Orbit does
          not launch, pause, or fund ads.
        </p>
      </div>
    </>
  );
}

export function WaveDetail({
  wave,
  recorded,
  onSaved,
}: {
  wave: WaveView;
  recorded?: LearningView;
  onSaved: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [mode, setMode] = useState<'conclusion' | 'cancel'>('conclusion');
  const [notes, setNotes] = useState('');
  const e = wave.evaluation;
  const alreadyRecorded = recorded?.result.evidenceId === e.evidenceId;
  const bands = e.arms.flatMap((a) =>
    a.contributionPer100Clicks
      ? [a.contributionPer100Clicks.lower, a.contributionPer100Clicks.upper]
      : [],
  );
  const lo = Math.min(0, ...bands),
    hi = Math.max(1, ...bands);
  const position = (v: number) => ((v - lo) / (hi - lo)) * 100;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(
        `/waves/${wave.id}/${mode}`,
        mode === 'cancel'
          ? { dataset: wave.dataset, reason: notes }
          : { dataset: wave.dataset, notes, evidenceId: e.evidenceId },
      );
      onSaved(
        mode === 'cancel'
          ? 'Local wave cancelled. Check delivery separately in your ad console.'
          : 'Finding recorded in the learning library. Unused local allowance released.',
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="detail-stack wave-detail">
      <div className="detail-identity">
        <ChannelMark channel={wave.campaignSnapshot.channel} />
        <div>
          <strong>{wave.campaignSnapshot.entityName}</strong>
          <span>
            {date(wave.startDate)} – {date(wave.endDate)} ·{' '}
            {wave.registration === 'retrospective' ? 'Historical review' : 'Prospective plan'} ·{' '}
            {wave.status}
          </span>
        </div>
        <Badge kind={outcomeKind(e.outcome)}>{outcomeLabel[e.outcome]}</Badge>
      </div>
      <div className="inline-note">
        <FlaskConical size={20} />
        <p>{wave.hypothesis}</p>
      </div>
      <div className="detail-metrics">
        <div>
          <span>Observed / wave budget</span>
          <strong>
            {money(e.spentCents)}
            <small> / {money(wave.budgetCents)}</small>
          </strong>
        </div>
        <div>
          <span>Mature loss / boundary</span>
          <strong>
            {money(e.matureLossCents)}
            <small> / {money(wave.lossLimitCents)}</small>
          </strong>
        </div>
        <div>
          <span>Cohorts mature through</span>
          <strong>{date(e.matureThrough)}</strong>
        </div>
      </div>
      <div className="recommendation-detail">
        <span className="eyebrow">
          {wave.status === 'closed'
            ? 'CURRENT EVIDENCE · RECORDED FINDING IN LEARNING LIBRARY'
            : 'CURRENT EVIDENCE'}
        </span>
        <h3>{e.title}</h3>
        <p>{e.reason}</p>
      </div>
      {!!e.blockers.length && (
        <div className="form-error">
          <strong>Evidence to resolve</strong>
          <ul>
            {e.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      <section className="comparison-panel">
        <h3>Contribution after the profit reserve</h3>
        <p>Modeled dollars per 100 clicks · conservative joint posterior bands</p>
        <div className="comparison-axis">
          <span>{money(lo)}</span>
          <span>{money(hi)}</span>
        </div>
        {e.arms.map((a) => (
          <div className="comparison-arm" key={a.targetId}>
            <div className="comparison-label">
              <strong>{a.label}</strong>
              <span>
                {a.role} · {number(a.mature.clicks)} mature clicks · {number(a.mature.orders)}{' '}
                purchases
              </span>
            </div>
            <div className="interval-track" aria-hidden="true">
              <span className="interval-zero" style={{ left: `${position(0)}%` }} />
              {a.contributionPer100Clicks && (
                <>
                  <span
                    className={`interval-range ${a.role}`}
                    style={{
                      left: `${position(a.contributionPer100Clicks.lower)}%`,
                      width: `${position(a.contributionPer100Clicks.upper) - position(a.contributionPer100Clicks.lower)}%`,
                    }}
                  />
                  <span
                    className="interval-point"
                    style={{ left: `${position(a.contributionPer100Clicks.mean)}%` }}
                  />
                </>
              )}
            </div>
            <div className="interval-values">
              <span>
                {a.contributionPer100Clicks
                  ? `${money(a.contributionPer100Clicks.lower, 2)} to ${money(a.contributionPer100Clicks.upper, 2)}`
                  : 'More clicks needed'}
              </span>
              <span>
                {a.coveredDays}/{a.expectedDays} days reported
              </span>
            </div>
          </div>
        ))}
        <p className="form-help">
          Beta(1,19) conversion model, with 5% posterior tail mass shared across all arms. CPC,
          refunds per purchase, and unit economics are held fixed. These bands do not establish
          causal lift or account for future auction prices.
        </p>
      </section>
      <details className="wave-contract">
        <summary>
          <LockKeyhole size={15} />
          Frozen measurement contract
        </summary>
        <dl>
          <div>
            <dt>Click floor / arm</dt>
            <dd>{number(wave.minClicksPerArm)}</dd>
          </div>
          <div>
            <dt>Minimum gain / 100 clicks</dt>
            <dd>{money(wave.minLiftCentsPer100Clicks, 2)}</dd>
          </div>
          <div>
            <dt>Net receipt / variable cost</dt>
            <dd>
              {money(wave.campaignSnapshot.netReceiptCents, 2)} /{' '}
              {money(wave.campaignSnapshot.variableCostCents, 2)}
            </dd>
          </div>
          <div>
            <dt>Attribution window</dt>
            <dd>{wave.campaignSnapshot.attributionDays} days</dd>
          </div>
        </dl>
        <p className="form-help">
          Plan: {wave.planId.slice(0, 16)} · Reporting IDs checked by the operator. Candidate
          content and economics were copied into this plan at registration.
        </p>
        <ul>
          {wave.arms.map((a) => (
            <li key={a.target.id}>
              <strong>
                {a.role}: {a.target.sourceId}
              </strong>{' '}
              — {a.candidate?.value || 'Existing baseline'}
            </li>
          ))}
        </ul>
      </details>
      <a
        className="button secondary setup-download"
        href={`/api/waves/${wave.id}/setup-sheet?dataset=${wave.dataset}`}
      >
        <Download size={15} />
        Download setup sheet
      </a>
      <p className="form-help">
        The setup sheet maps console/report IDs. It is not an Amazon or Meta bulk-upload file. Keep
        the candidate’s creative, destination, or keyword definition stable for the registered
        window.
      </p>
      {alreadyRecorded && (
        <div className="inline-note">
          <BookOpen size={20} />
          <p>
            This evidence is saved in the learning library. A corrected report can produce a new
            revision while the original finding remains available.
          </p>
        </div>
      )}
      {wave.status !== 'cancelled' && !alreadyRecorded && (
        <form className="form-stack wave-review" onSubmit={submit}>
          <div className="wave-review-options">
            <button
              type="button"
              className={`button ${mode === 'conclusion' ? 'primary' : 'secondary'}`}
              onClick={() => setMode('conclusion')}
            >
              Record finding
            </button>
            {wave.status === 'measuring' && (
              <button
                type="button"
                className={`button ${mode === 'cancel' ? 'primary' : 'secondary'}`}
                onClick={() => setMode('cancel')}
              >
                Cancel local wave
              </button>
            )}
          </div>
          <label>
            {mode === 'conclusion'
              ? 'What did we learn, and what should change next?'
              : 'Why are you ending this local wave?'}
            <textarea
              rows={3}
              required
              minLength={10}
              maxLength={mode === 'conclusion' ? 2000 : 1000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-footer">
            <span>
              {mode === 'conclusion'
                ? 'A recorded finding keeps an immutable evidence snapshot.'
                : 'This releases the local reservation. It does not pause ads.'}
            </span>
            <button
              className="button primary"
              disabled={busy || (mode === 'conclusion' && !e.canRecord)}
            >
              {busy ? 'Saving…' : mode === 'conclusion' ? 'Save learning' : 'Cancel local plan'}
            </button>
          </div>
          {mode === 'conclusion' && !e.canRecord && (
            <p className="form-help">
              Resolve evidence gaps or wait for maturity before saving a conclusion. You can cancel
              an open wave and retain its plan.
            </p>
          )}
        </form>
      )}
    </div>
  );
}

export function LearningLibrary({
  data,
  query,
  onWave,
  onFollowUp,
}: {
  data: Dashboard;
  query: string;
  onWave: (id: string) => void;
  onFollowUp: (id: string) => void;
}) {
  const [vertical, setVertical] = useState('all');
  const [showHistory, setShowHistory] = useState(false);
  const findings = data.learnings.filter(
    (l) =>
      (showHistory || !l.superseded) &&
      (vertical === 'all' || l.vertical === vertical) &&
      `${l.waveName} ${l.entityName} ${l.hypothesis} ${l.notes} ${l.result.title}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="learning-intro">
        <div className="learning-symbol">
          <BookOpen size={30} />
        </div>
        <div>
          <h2>A memory for the next decision</h2>
          <p>
            Keep the failed ideas, sparse tests, and promising signals together. Every finding
            retains the evidence and assumptions used to reach it.
          </p>
        </div>
      </div>
      <div className="section-heading">
        <span>{findings.length} findings</span>
        <div className="learning-filters">
          <label className="check-row">
            <input
              type="checkbox"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
            />
            Show prior revisions
          </label>
          <select
            aria-label="Filter learning portfolio"
            value={vertical}
            onChange={(e) => setVertical(e.target.value)}
          >
            <option value="all">Both portfolios</option>
            <option value="commerce">Product ads</option>
            <option value="books">Amazon books</option>
          </select>
        </div>
      </div>
      <div className="learning-list">
        {findings.map((l) => (
          <LearningCard
            key={l.id}
            learning={l}
            onWave={() => onWave(l.waveId)}
            onFollowUp={() => onFollowUp(l.id)}
          />
        ))}
      </div>
      {!findings.length && (
        <Empty icon={<Search size={28} />} title="The useful lessons belong here">
          Record a completed wave’s finding to build a searchable history. Inconclusive results
          matter too.
        </Empty>
      )}
    </>
  );
}

function LearningCard({
  learning: l,
  onWave,
  onFollowUp,
}: {
  learning: LearningView;
  onWave: () => void;
  onFollowUp: () => void;
}) {
  return (
    <article className="learning-card">
      <div className="learning-card-top">
        <Badge kind={outcomeKind(l.result.outcome)}>{outcomeLabel[l.result.outcome]}</Badge>
        <span>
          {l.entityName} · {date(l.createdAt)}
        </span>
      </div>
      <h3>{l.waveName}</h3>
      <p className="learning-finding">{l.result.title}</p>
      <p>{l.notes}</p>
      {(l.evidenceChanged || l.superseded) && (
        <div className="learning-revision">
          <History size={16} />
          {l.superseded
            ? 'A newer recorded revision supersedes this finding.'
            : 'Reports or economics changed since this finding. Revisit the wave before reusing it.'}
        </div>
      )}
      <details>
        <summary>Evidence saved with this finding</summary>
        <p>{l.hypothesis}</p>
        <p>{l.result.reason}</p>
        <ul>
          {l.result.arms.map((a) => (
            <li key={a.targetId}>
              {a.label}: {number(a.mature.clicks)} mature clicks, {number(a.mature.orders)}{' '}
              purchases, {money(a.mature.contributionCents)} modeled contribution before reserve.
            </li>
          ))}
        </ul>
        <p className="form-help">
          Evidence {l.result.evidenceId.slice(0, 16)} · saved{' '}
          {new Date(l.createdAt).toLocaleString()}
        </p>
      </details>
      <div className="learning-card-footer">
        <button className="button secondary" onClick={onWave}>
          Inspect wave
          <ArrowRight size={14} />
        </button>
        <button
          className="button primary"
          disabled={l.evidenceChanged || l.superseded}
          onClick={onFollowUp}
        >
          <FlaskConical size={15} />
          Plan a follow-up
        </button>
      </div>
    </article>
  );
}
