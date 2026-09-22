import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  Download,
  FileUp,
  Info,
  Link2,
  OctagonX,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Unplug,
} from 'lucide-react';
import type {
  AdAccount,
  BrainView,
  Dashboard,
  Policy,
  Proposal,
  ProposalStatus,
  SearchTermView,
} from '../shared/types';
import { actionClasses } from '../shared/types';
import { Badge, Empty, Modal } from './components';
import { api, date, money, number, percent, timeAgo } from './lib';
import './brain.css';
import { AmazonReports } from './AmazonReports';

const statusKind = (s: ProposalStatus) =>
  s === 'applied'
    ? ('scale' as const)
    : s === 'proposed'
      ? ('explore' as const)
      : s === 'authorized'
        ? ('purple' as const)
        : s === 'failed' || s === 'cancelled' || s === 'rejected' || s === 'expired'
          ? ('repair' as const)
          : ('hold' as const);
const classLabel: Record<Proposal['actionClass'], string> = {
  harvest: 'Harvest target',
  negative: 'Add negative',
  'bid-up': 'Raise bid',
  'bid-down': 'Lower bid',
  pause: 'Pause target',
  'budget-up': 'Raise budget',
  'budget-down': 'Lower budget',
};
const modeLabel: Record<Policy['mode'], string> = {
  observe: 'Observe',
  recommend: 'Recommend',
  supervised: 'Supervised execution',
  bounded: 'Bounded automation',
};
const healthKind = (status: AdAccount['health']['status']) =>
  status === 'ok'
    ? ('scale' as const)
    : status === 'partial' || status === 'pending'
      ? ('explore' as const)
      : status === 'never'
        ? ('neutral' as const)
        : ('repair' as const);
const change = (p: Proposal) => {
  const a = p.action;
  switch (a.type) {
    case 'create-keyword':
      return `exact · bid ${money(a.bidCents, 2)}`;
    case 'create-negative-keyword':
      return 'negative exact';
    case 'create-product-target':
      return `ASIN ${a.asin} · bid ${money(a.bidCents, 2)}`;
    case 'create-negative-product-target':
      return `exclude ASIN ${a.asin}`;
    case 'update-keyword-bid':
    case 'update-product-target-bid':
    case 'update-campaign-budget':
      return `${money(a.fromCents, 2)} → ${money(a.toCents, 2)}`;
    case 'update-keyword-state':
    case 'update-product-target-state':
      return `${a.from} → ${a.to}`;
  }
};
const termKind = (s: SearchTermView['signal']) =>
  s === 'harvest'
    ? ('scale' as const)
    : s === 'negative'
      ? ('reduce' as const)
      : s === 'blocked'
        ? ('repair' as const)
        : ('neutral' as const);
const termLabel: Record<SearchTermView['signal'], string> = {
  harvest: 'Harvest',
  negative: 'Exclude',
  hold: 'Collecting',
  blocked: 'Blocked',
  'already-exact': 'Exact exists',
};

type ModalState =
  | { type: 'account' }
  | { type: 'link'; account: AdAccount }
  | { type: 'policy'; account: AdAccount }
  | { type: 'jobs'; account: AdAccount }
  | { type: 'ledger' }
  | { type: 'explain'; campaignId: string; ids: string[] }
  | { type: 'proposal'; proposal: Proposal }
  | null;

export function BrainPage({
  data,
  query,
  days,
  onWorkspace,
  onCampaign,
}: {
  data: Dashboard;
  query: string;
  days: string;
  onWorkspace: () => void;
  onCampaign: () => void;
}) {
  const dataset = data.dataset;
  const [view, setView] = useState<BrainView | null>(null);
  const [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [notice, setNotice] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const [status, setStatus] = useState('open');
  const [campaignFilter, setCampaignFilter] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    api<BrainView>(`/brain?dataset=${dataset}&days=${days}`, undefined, 'GET', controller.signal)
      .then((v) => {
        setView(v);
        setError('');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [dataset, days, revision]);
  const refresh = () => setRevision((r) => r + 1);
  async function act(label: string, work: () => Promise<unknown>, done: string) {
    setBusy(label);
    setNotice('');
    try {
      const result = await work();
      setNotice(typeof result === 'string' ? result : done);
      refresh();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  if (error)
    return (
      <Empty icon={<BrainCircuit size={30} />} title="The brain could not load">
        {error}
      </Empty>
    );
  if (!view) return <div className="loading-state">Loading the brain…</div>;
  const q = query.toLowerCase();
  const openStatuses: ProposalStatus[] = [
    'proposed',
    'authorized',
    'reserved',
    'sending',
    'uncertain',
  ];
  const proposals = view.proposals.filter(
    (p) =>
      (status === 'all' ||
        (status === 'open' ? openStatuses.includes(p.status) : p.status === status)) &&
      (campaignFilter === 'all' || p.campaignId === campaignFilter) &&
      `${p.title} ${p.campaignName} ${p.targetRef}`.toLowerCase().includes(q),
  );
  const terms = view.searchTerms.filter(
    (t) =>
      (campaignFilter === 'all' || t.campaignId === campaignFilter) &&
      `${t.term} ${t.campaignName}`.toLowerCase().includes(q),
  );
  const linkedCampaigns = view.scorecards.filter((s) => s.linked);
  const selectedProposals = view.proposals.filter((p) => selected.includes(p.id));
  const selectedCampaigns = new Set(selectedProposals.map((p) => p.campaignId));

  return (
    <div className="brain">
      {notice && (
        <div className="brain-notice" role="status">
          <Info size={16} />
          <span>{notice}</span>
        </div>
      )}
      <section className="brain-accounts">
        {view.accounts.map((account) => (
          <article className="brain-account" key={account.id}>
            <div className="brain-account-top">
              <div>
                <span className="eyebrow">
                  {account.connector === 'sandbox' ? 'SIMULATED ACCOUNT' : 'AMAZON ADS PROFILE'}
                </span>
                <h2>{account.name}</h2>
                <p>
                  {modeLabel[account.policy.mode]} · policy {account.policy.version} ·{' '}
                  {account.attributionDays}-day attribution ·{' '}
                  {account.health.watermarkDate
                    ? `reports through ${date(account.health.watermarkDate)}`
                    : 'no reports yet'}
                </p>
              </div>
              <div className="brain-account-badges">
                <Badge kind={healthKind(account.health.status)}>
                  {account.health.status === 'never' ? 'not synced' : account.health.status}
                </Badge>
                {account.policy.killSwitch && <Badge kind="repair">Kill switch on</Badge>}
              </div>
            </div>
            <p className="brain-health">{account.health.message}</p>
            <div className="brain-coverage">
              <span>
                <b>{number(account.health.coverage.campaigns)}</b> platform campaigns
              </span>
              <span>
                <b>{number(account.health.coverage.keywords)}</b> keywords
              </span>
              <span>
                <b>{number(account.health.coverage.negatives)}</b> negatives
              </span>
              <span>
                <b>{number(account.health.coverage.productTargets ?? 0)}</b> product targets
              </span>
              <span>
                <b>{number(account.health.coverage.negativeProductTargets ?? 0)}</b> product
                exclusions
              </span>
              <span>
                <b>{number(view.links.filter((l) => l.accountId === account.id).length)}</b> linked
                campaigns
              </span>
            </div>
            <div className="brain-account-actions">
              <button
                className="button primary"
                disabled={Boolean(busy)}
                onClick={() =>
                  act(
                    'run',
                    async () => {
                      const s = await api<{
                        proposed: number;
                        authorized: number;
                        executed: {
                          applied: number;
                          uncertain: number;
                          failed: number;
                          cancelled: number;
                        };
                        sync: { status: string; message: string } | null;
                        notes: string[];
                      }>(`/brain/accounts/${account.id}/run`, { dataset, sync: true });
                      return `Sync ${s.sync?.status ?? 'skipped'}. ${s.proposed} new proposals, ${s.authorized} authorized by policy, ${s.executed.applied} applied, ${s.executed.uncertain} uncertain, ${s.executed.failed} failed.${s.notes.length ? ' ' + s.notes.join(' ') : ''}`;
                    },
                    'Brain run completed.',
                  )
                }
              >
                <Play size={15} />
                {busy === 'run' ? 'Running…' : 'Run brain'}
              </button>
              <button
                className="button secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  act(
                    'sync',
                    async () => {
                      const run = await api<{ status: string; message: string }>(
                        `/brain/accounts/${account.id}/sync`,
                        { dataset },
                      );
                      return `Sync ${run.status}: ${run.message}`;
                    },
                    'Synchronized.',
                  )
                }
              >
                <RefreshCw size={15} />
                Sync now
              </button>
              {account.connector === 'amazon-ads' && (
                <button
                  className="button secondary"
                  onClick={() => setModal({ type: 'jobs', account })}
                >
                  Report jobs
                </button>
              )}
              <button
                className="button secondary"
                onClick={() => setModal({ type: 'policy', account })}
              >
                <SlidersHorizontal size={15} />
                Policy
              </button>
              <button
                className="button secondary"
                onClick={() => setModal({ type: 'link', account })}
              >
                <Link2 size={15} />
                Link campaign
              </button>
              <button
                className={`button ${account.policy.killSwitch ? 'primary' : 'danger'}`}
                disabled={Boolean(busy)}
                onClick={() =>
                  act(
                    'kill',
                    () =>
                      api(`/brain/accounts/${account.id}/kill`, {
                        dataset,
                        on: !account.policy.killSwitch,
                      }),
                    account.policy.killSwitch
                      ? 'Kill switch released.'
                      : 'Kill switch engaged. Authorized changes were cancelled.',
                  )
                }
              >
                <OctagonX size={15} />
                {account.policy.killSwitch ? 'Release kill switch' : 'Kill switch'}
              </button>
            </div>
          </article>
        ))}
        {!view.accounts.length && (
          <Empty
            icon={<Unplug size={30} />}
            title="Connect an advertising account"
            action={
              dataset === 'workspace' ? (
                <button className="button primary" onClick={() => setModal({ type: 'account' })}>
                  <Plus size={15} />
                  Connect account
                </button>
              ) : (
                <button className="button primary" onClick={onWorkspace}>
                  Open your workspace
                </button>
              )
            }
          >
            The brain synchronizes platform structure and daily performance, evaluates every keyword
            and search term against your unit economics, and proposes exact changes for review or
            bounded execution.
          </Empty>
        )}
        {dataset === 'workspace' && view.accounts.length > 0 && (
          <button
            className="button secondary brain-add"
            onClick={() => setModal({ type: 'account' })}
          >
            <Plus size={15} />
            Connect another account
          </button>
        )}
      </section>

      <div className="brain-strip">
        <span>
          <Sparkles size={15} />
          {view.ai.provider
            ? `AI: ${view.ai.provider} · ${view.ai.model} · ${view.ai.dailyLimit - view.ai.requestsToday} requests left today`
            : 'AI provider not configured (relevance review and explanations unavailable)'}
        </span>
        <span>
          <ShieldCheck size={15} />
          {view.integrations.amazonAds.configured
            ? `Amazon Ads credentials configured · writes ${view.integrations.amazonAds.writesEnabled ? 'enabled' : 'disabled'}`
            : 'Amazon Ads credentials not configured · sandbox available'}
        </span>
        <label>
          Campaign
          <select
            value={campaignFilter}
            onChange={(e) => setCampaignFilter(e.target.value)}
            aria-label="Filter by campaign"
          >
            <option value="all">All linked campaigns</option>
            {linkedCampaigns.map((s) => (
              <option key={s.campaignId} value={s.campaignId}>
                {s.campaignName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <h2>Scorecard</h2>
          <span className="small-tag">
            Last {days} days · attributed sales beside reconciled receipts
          </span>
        </div>
        <div className="table-scroll">
          <table className="brain-table" aria-label="Campaign scorecard">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Platform</th>
                <th className="numeric">Spend</th>
                <th className="numeric">Attributed sales</th>
                <th className="numeric">ROAS</th>
                <th className="numeric">ACOS / target</th>
                <th className="numeric">Modeled contribution</th>
                <th className="numeric">Ledger contribution</th>
                <th className="numeric">Keywords · products · terms</th>
                <th>Decision</th>
                <th className="numeric">Open</th>
              </tr>
            </thead>
            <tbody>
              {view.scorecards
                .filter((s) => `${s.campaignName} ${s.entityName}`.toLowerCase().includes(q))
                .map((s) => (
                  <tr key={s.campaignId}>
                    <td>
                      <strong>{s.campaignName}</strong>
                      <span className="subtle">{s.entityName}</span>
                    </td>
                    <td>
                      {s.linked ? (
                        <>
                          <Badge kind={s.platformState === 'enabled' ? 'scale' : 'neutral'}>
                            {s.platformState ?? 'unknown'}
                          </Badge>
                          <span className="subtle">
                            {s.platformDailyBudgetCents !== null
                              ? `${money(s.platformDailyBudgetCents, 2)} / day`
                              : 'budget unknown'}
                          </span>
                        </>
                      ) : (
                        <span className="subtle">Not linked</span>
                      )}
                    </td>
                    <td className="numeric">{money(s.metrics.spendCents, 2)}</td>
                    <td className="numeric">{money(s.metrics.salesCents, 2)}</td>
                    <td className="numeric">
                      {s.metrics.roas === null ? '—' : `${s.metrics.roas.toFixed(2)}×`}
                    </td>
                    <td className="numeric">
                      {percent(s.metrics.acos)} / {percent(s.targetAcos)}
                      <span className="subtle">break-even {percent(s.breakEvenAcos)}</span>
                    </td>
                    <td
                      className={`numeric ${(s.metrics.contributionCents ?? 0) < 0 ? 'negative' : 'positive'}`}
                    >
                      {money(s.metrics.contributionCents, 2)}
                    </td>
                    <td className="numeric">
                      {s.ledgerContributionCents === null ? (
                        <span className="subtle">No ledger</span>
                      ) : (
                        money(s.ledgerContributionCents, 2)
                      )}
                      {s.ledger && (
                        <span className="subtle">
                          {number(s.ledger.units)} units · {s.ledger.days} days
                        </span>
                      )}
                    </td>
                    <td className="numeric">
                      {number(s.keywords)} · {number(s.productTargets)} · {number(s.searchTerms)}
                    </td>
                    <td>
                      <Badge kind={s.decision.kind} />
                    </td>
                    <td className="numeric">{number(s.openProposals)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {dataset === 'workspace' && (
          <div className="brain-table-footer">
            <button className="text-button" onClick={onCampaign}>
              <Plus size={14} />
              Add campaign
            </button>
            <button className="text-button" onClick={() => setModal({ type: 'ledger' })}>
              <FileUp size={14} />
              Import business ledger
            </button>
            <a className="text-button" href="/api/brain/ledger-template">
              <Download size={14} />
              Ledger template
            </a>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading brain-proposals-heading">
          <div>
            <h2>Proposed changes</h2>
            <span className="small-tag">
              Exact platform changes with expected prior state and daily commitment
            </span>
          </div>
          <div className="brain-proposal-tools">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter proposals by status"
            >
              <option value="open">Open</option>
              <option value="all">All</option>
              {(
                [
                  'proposed',
                  'authorized',
                  'applied',
                  'uncertain',
                  'failed',
                  'cancelled',
                  'rejected',
                  'expired',
                ] as ProposalStatus[]
              ).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              className="button secondary"
              disabled={!selected.length || selectedCampaigns.size !== 1 || !view.ai.provider}
              onClick={() =>
                setModal({ type: 'explain', campaignId: [...selectedCampaigns][0], ids: selected })
              }
            >
              <Sparkles size={15} />
              Explain with AI ({selected.length})
            </button>
          </div>
        </div>
        <div className="table-scroll">
          <table className="brain-table" aria-label="Proposed changes">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">Select</span>
                </th>
                <th>Change</th>
                <th>Campaign</th>
                <th>Evidence</th>
                <th>Relevance</th>
                <th className="numeric">Commitment / day</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={p.id} className={p.needsReview ? 'needs-review' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.title}`}
                      checked={selected.includes(p.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, p.id]
                            : selected.filter((id) => id !== p.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <button
                      className="campaign-link"
                      onClick={() => setModal({ type: 'proposal', proposal: p })}
                    >
                      {p.title}
                    </button>
                    <span className="subtle">
                      {classLabel[p.actionClass]} · {change(p)}
                      {p.needsReview && ' · needs operator review'}
                    </span>
                  </td>
                  <td>{p.campaignName}</td>
                  <td>
                    <span className="subtle">
                      {number(p.evidence.matureClicks)} mature clicks ·{' '}
                      {number(p.evidence.matureOrders)} purchases ·{' '}
                      {percent(p.evidence.probabilityProfitable)} modeled
                    </span>
                  </td>
                  <td>
                    {p.relevance ? (
                      <Badge
                        kind={
                          p.relevance.level === 'high'
                            ? 'scale'
                            : p.relevance.level === 'medium'
                              ? 'explore'
                              : 'reduce'
                        }
                      >
                        {p.relevance.level}
                      </Badge>
                    ) : (
                      <span className="subtle">unreviewed</span>
                    )}
                  </td>
                  <td className="numeric">{money(p.maxCommitmentCents, 2)}</td>
                  <td>
                    <Badge kind={statusKind(p.status)}>{p.status}</Badge>
                    <span className="subtle">{timeAgo(p.updatedAt)}</span>
                  </td>
                  <td className="brain-actions">
                    {p.status === 'proposed' && (
                      <button
                        className="button secondary small-button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          act(
                            'auth',
                            () => api(`/brain/proposals/${p.id}/authorize`, { dataset }),
                            'Change authorized. Execute it when ready.',
                          )
                        }
                      >
                        Authorize
                      </button>
                    )}
                    {p.status === 'authorized' && (
                      <button
                        className="button primary small-button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          act(
                            'exec',
                            async () => {
                              const r = await api<{ proposal: Proposal }>(
                                `/brain/proposals/${p.id}/execute`,
                                { dataset },
                              );
                              return `${r.proposal.status}: ${r.proposal.history.at(-1)?.note ?? ''}`;
                            },
                            'Executed.',
                          )
                        }
                      >
                        Execute
                      </button>
                    )}
                    {p.status === 'uncertain' && (
                      <button
                        className="button secondary small-button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          act(
                            'reconcile',
                            () => api(`/brain/proposals/${p.id}/reconcile`, { dataset }),
                            'Reconciled against platform state.',
                          )
                        }
                      >
                        Reconcile
                      </button>
                    )}
                    {(p.status === 'proposed' || p.status === 'authorized') && (
                      <button
                        className="text-button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          act(
                            'reject',
                            () =>
                              api(`/brain/proposals/${p.id}/reject`, {
                                dataset,
                                reason: 'Rejected by the operator.',
                              }),
                            'Rejected.',
                          )
                        }
                      >
                        Reject
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!proposals.length && (
          <p className="form-help">
            No proposals match. Run the brain after synchronizing; proposals appear only when mature
            evidence, verified economics, and a linked platform campaign all exist.
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading brain-proposals-heading">
          <div>
            <h2>Search terms</h2>
            <span className="small-tag">
              Shopper queries and matched products behind each target, screened against affordable
              CPC
            </span>
          </div>
          <div className="brain-proposal-tools">
            <button
              className="button secondary"
              disabled={Boolean(busy) || campaignFilter === 'all' || !view.ai.provider}
              onClick={() =>
                act(
                  'review',
                  async () => {
                    const r = await api<{ reviewed: number }>('/brain/search-terms/review', {
                      dataset,
                      campaignId: campaignFilter,
                    });
                    return `${r.reviewed} search terms reviewed for relevance.`;
                  },
                  'Reviewed.',
                )
              }
            >
              <Sparkles size={15} />
              Review relevance with AI
            </button>
          </div>
        </div>
        <div className="table-scroll">
          <table className="brain-table" aria-label="Search terms">
            <thead>
              <tr>
                <th>Search term</th>
                <th>Source target</th>
                <th className="numeric">Clicks</th>
                <th className="numeric">Purchases</th>
                <th className="numeric">Spend</th>
                <th className="numeric">CPC / affordable</th>
                <th className="numeric">P(profitable)</th>
                <th>Relevance</th>
                <th>Signal</th>
              </tr>
            </thead>
            <tbody>
              {terms.slice(0, 60).map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{t.term}</strong>
                    <span className="subtle">{t.campaignName}</span>
                  </td>
                  <td>
                    {t.keywordText}{' '}
                    <span className="match-type">
                      {t.sourceKind === 'product-target' ? 'product' : t.matchType}
                    </span>
                  </td>
                  <td className="numeric">{number(t.metrics.clicks)}</td>
                  <td className="numeric">{number(t.metrics.orders)}</td>
                  <td className="numeric">{money(t.metrics.spendCents, 2)}</td>
                  <td className="numeric">
                    {t.metrics.cpcCents === null ? '—' : money(Math.round(t.metrics.cpcCents), 2)} /{' '}
                    {money(t.affordableCpcCents, 2)}
                  </td>
                  <td className="numeric">{percent(t.probabilityProfitable)}</td>
                  <td>
                    {t.relevance ? (
                      <Badge
                        kind={
                          t.relevance.level === 'high'
                            ? 'scale'
                            : t.relevance.level === 'medium'
                              ? 'explore'
                              : 'reduce'
                        }
                      >
                        {t.relevance.level}
                      </Badge>
                    ) : (
                      <span className="subtle">
                        {t.sourceKind === 'product-target' ? 'operator check' : 'unreviewed'}
                      </span>
                    )}
                  </td>
                  <td>
                    <Badge kind={termKind(t.signal)}>{termLabel[t.signal]}</Badge>
                    <span className="subtle">{t.reason}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!terms.length && (
          <p className="form-help">
            No search terms yet. Link a campaign and synchronize the account.
          </p>
        )}
      </section>

      <div className="brain-columns">
        <section className="panel">
          <div className="panel-heading">
            <h2>Execution log</h2>
            <span className="small-tag">Outbox rows written before every platform request</span>
          </div>
          <ul className="brain-log">
            {view.executions.slice(0, 20).map((e) => {
              const p = view.proposals.find((x) => x.id === e.proposalId);
              return (
                <li key={e.id}>
                  <Badge
                    kind={
                      e.outcome === 'applied' || e.outcome === 'reconciled'
                        ? 'scale'
                        : e.outcome === 'failed'
                          ? 'repair'
                          : 'hold'
                    }
                  >
                    {e.outcome ?? 'in flight'}
                  </Badge>
                  <div>
                    <strong>{p?.title ?? e.proposalId}</strong>
                    <p>{e.note}</p>
                    <span>{new Date(e.startedAt).toLocaleString()}</span>
                  </div>
                </li>
              );
            })}
            {!view.executions.length && (
              <li className="subtle">No platform requests have been sent.</li>
            )}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Synchronization runs</h2>
            <span className="small-tag">Coverage and freshness, not just process exit</span>
          </div>
          <ul className="brain-log">
            {view.syncRuns.slice(0, 20).map((r) => (
              <li key={r.id}>
                <Badge kind={healthKind(r.status)}>{r.status}</Badge>
                <div>
                  <strong>
                    {date(r.startDate)} – {date(r.endDate)}
                  </strong>
                  <p>{r.message}</p>
                  <span>{new Date(r.startedAt).toLocaleString()}</span>
                </div>
              </li>
            ))}
            {!view.syncRuns.length && <li className="subtle">Not synchronized yet.</li>}
          </ul>
        </section>
      </div>

      <div className="inline-note page-note">
        <ShieldCheck size={19} />
        <p>
          Proposals are generated from mature, click-attributed evidence and your verified unit
          economics. Execution requires supervised or bounded mode, a live connector with writes
          enabled, an unchanged platform state, and room inside the daily commitment envelope. The
          kill switch cancels authorized work but cannot recall a request already accepted by the
          platform.
        </p>
      </div>

      {modal?.type === 'jobs' && (
        <Modal title="Amazon report jobs" onClose={() => setModal(null)}>
          <AmazonReports account={modal.account} />
        </Modal>
      )}
      {modal?.type === 'account' && (
        <Modal
          title="Connect an advertising account"
          subtitle="Credentials stay on the server. The sandbox needs none."
          onClose={() => setModal(null)}
        >
          <AccountForm
            dataset={dataset}
            amazonConfigured={view.integrations.amazonAds.configured}
            onSaved={() => {
              setModal(null);
              refresh();
            }}
          />
        </Modal>
      )}
      {modal?.type === 'link' && (
        <Modal
          title="Link a campaign to the platform"
          subtitle={modal.account.name}
          onClose={() => setModal(null)}
        >
          <LinkForm
            dataset={dataset}
            data={data}
            view={view}
            account={modal.account}
            onSaved={() => {
              setModal(null);
              refresh();
            }}
          />
        </Modal>
      )}
      {modal?.type === 'policy' && (
        <Modal
          title="Operating policy"
          subtitle={`${modal.account.name} · current version ${modal.account.policy.version}`}
          onClose={() => setModal(null)}
          wide
        >
          <PolicyForm
            dataset={dataset}
            account={modal.account}
            liveWritesEnabled={view.integrations.amazonAds.writesEnabled}
            onSaved={() => {
              setModal(null);
              refresh();
            }}
          />
        </Modal>
      )}
      {modal?.type === 'ledger' && (
        <Modal
          title="Import a business ledger"
          subtitle="Reconciled units and net receipts per day, independent of platform attribution"
          onClose={() => setModal(null)}
        >
          <LedgerForm
            data={data}
            onSaved={() => {
              setModal(null);
              refresh();
            }}
          />
        </Modal>
      )}
      {modal?.type === 'explain' && (
        <Modal
          title="AI explanation"
          subtitle="Plain-language summary, risks, and checks for the selected proposals"
          onClose={() => setModal(null)}
        >
          <Explanation dataset={dataset} ids={modal.ids} />
        </Modal>
      )}
      {modal?.type === 'proposal' && (
        <Modal
          title={modal.proposal.title}
          subtitle={`${classLabel[modal.proposal.actionClass]} · ${modal.proposal.campaignName}`}
          onClose={() => setModal(null)}
        >
          <ProposalDetail proposal={modal.proposal} />
        </Modal>
      )}
    </div>
  );
}

function AccountForm({
  dataset,
  amazonConfigured,
  onSaved,
}: {
  dataset: string;
  amazonConfigured: boolean;
  onSaved: () => void;
}) {
  const [connector, setConnector] = useState<'sandbox' | 'amazon-ads'>('sandbox');
  const [profiles, setProfiles] = useState<
    {
      profileId: string;
      countryCode: string;
      currencyCode: string;
      timezone: string;
      accountInfo: { name?: string; type: string };
    }[]
  >([]);
  const [profileId, setProfileId] = useState(''),
    [region, setRegion] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(event.currentTarget);
    try {
      await api('/brain/accounts', {
        dataset,
        name: f.get('name'),
        connector,
        profileId: connector === 'sandbox' ? 'sandbox' : f.get('profileId'),
        marketplace: f.get('marketplace') || 'US',
        attributionDays: Number(f.get('attributionDays')),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="form-stack">
      <div className="segmented wide-segment" aria-label="Connector">
        <button
          type="button"
          className={connector === 'sandbox' ? 'selected' : ''}
          onClick={() => setConnector('sandbox')}
        >
          Simulated account
        </button>
        <button
          type="button"
          className={connector === 'amazon-ads' ? 'selected' : ''}
          onClick={() => setConnector('amazon-ads')}
        >
          Amazon Ads profile
        </button>
      </div>
      <label>
        Account name
        <input
          key={connector}
          name="name"
          required
          maxLength={160}
          defaultValue={connector === 'sandbox' ? 'Sandbox advertiser' : ''}
        />
      </label>
      {connector === 'amazon-ads' && (
        <div className="form-stack">
          <button
            type="button"
            className="button secondary"
            disabled={busy || !amazonConfigured || dataset !== 'workspace'}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const result = await api<{ profiles: typeof profiles; region: string }>(
                  '/brain/amazon/profiles',
                  { dataset },
                );
                setProfiles(result.profiles);
                setRegion(result.region);
                setProfileId(
                  result.profiles.find((p) => p.currencyCode === 'USD')?.profileId || '',
                );
                if (!result.profiles.length)
                  setError(
                    'No profiles were returned for this region and authorization. Ask the account owner to check Ads API access.',
                  );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Discover Amazon profiles
          </button>
          <label>
            Amazon Ads profile ID
            <select
              name="profileId"
              required
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              <option value="">Choose a verified profile</option>
              {profiles.map((p) => (
                <option key={p.profileId} value={p.profileId} disabled={p.currencyCode !== 'USD'}>
                  {p.accountInfo.name || p.profileId} · {p.countryCode} · {p.currencyCode}
                </option>
              ))}
            </select>
            <span className="form-help">
              {amazonConfigured
                ? `${region ? region + ' region. ' : ''}Currency, marketplace, and timezone come from Amazon. USD profiles are supported in this release.`
                : 'Ask your integration owner to configure the approved Amazon Ads API credentials on the server.'}
            </span>
          </label>
          {profileId && (
            <p className="form-help">
              Reporting timezone: {profiles.find((p) => p.profileId === profileId)?.timezone}
            </p>
          )}
        </div>
      )}
      <div className="form-grid two">
        {connector === 'sandbox' && (
          <label>
            Marketplace
            <input name="marketplace" defaultValue="US" maxLength={40} />
          </label>
        )}
        <label>
          Attribution window (days)
          <select name="attributionDays" defaultValue="14">
            {[1, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-footer">
        <span>
          <ShieldCheck size={14} />
          Starts in {connector === 'sandbox' ? 'supervised' : 'observe'} mode
        </span>
        <button className="button primary" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  );
}

function LinkForm({
  dataset,
  data,
  view,
  account,
  onSaved,
}: {
  dataset: string;
  data: Dashboard;
  view: BrainView;
  account: AdAccount;
  onSaved: () => void;
}) {
  const snapshot = view.platform[account.id];
  const [campaignId, setCampaignId] = useState(
    data.campaigns.find((c) => c.channel === 'amazon')?.id || '',
  );
  const [externalCampaignId, setExternal] = useState(snapshot?.campaigns[0]?.externalId || '');
  const adGroups =
    snapshot?.adGroups.filter((g) => g.campaignExternalId === externalCampaignId) || [];
  const [adGroupExternalId, setAdGroup] = useState(adGroups[0]?.externalId || '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (!snapshot)
    return (
      <p className="form-help">
        Synchronize the account first so platform campaigns and ad groups can be selected.
      </p>
    );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/brain/accounts/${account.id}/links`, {
        dataset,
        campaignId,
        externalCampaignId,
        adGroupExternalId: adGroupExternalId || adGroups[0]?.externalId,
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="form-stack">
      <label>
        Local campaign
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} required>
          {data.campaigns
            .filter((c) => c.channel === 'amazon')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.attributionDays}-day
              </option>
            ))}
        </select>
      </label>
      <label>
        Platform campaign
        <select
          value={externalCampaignId}
          onChange={(e) => {
            setExternal(e.target.value);
            setAdGroup('');
          }}
          required
        >
          {snapshot.campaigns.map((c) => (
            <option key={c.externalId} value={c.externalId}>
              {c.name} · {c.externalId}
            </option>
          ))}
        </select>
      </label>
      <label>
        Ad group for new keywords
        <select
          value={adGroupExternalId || adGroups[0]?.externalId || ''}
          onChange={(e) => setAdGroup(e.target.value)}
          required
        >
          {adGroups.map((g) => (
            <option key={g.externalId} value={g.externalId}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="form-footer">
        <span>The campaign’s click window must match the account’s.</span>
        <button className="button primary" disabled={busy}>
          {busy ? 'Linking…' : 'Save link'}
        </button>
      </div>
    </form>
  );
}

function PolicyForm({
  dataset,
  account,
  liveWritesEnabled,
  onSaved,
}: {
  dataset: string;
  account: AdAccount;
  liveWritesEnabled: boolean;
  onSaved: () => void;
}) {
  const policy = account.policy;
  const [mode, setMode] = useState<Policy['mode']>(policy.mode);
  const [allowed, setAllowed] = useState<string[]>(policy.allowedClasses);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(event.currentTarget);
    const n = (name: string) => Number(f.get(name));
    try {
      await api(
        `/brain/accounts/${account.id}/policy`,
        {
          dataset,
          policy: {
            mode,
            killSwitch: policy.killSwitch,
            autoSync: f.get('autoSync') === 'on',
            aiReview: f.get('aiReview') === 'on',
            allowedClasses: allowed,
            maxBidCents: Math.round(n('maxBid') * 100),
            maxBidStepPct: n('maxBidStepPct'),
            maxDailyBudgetCents: Math.round(n('maxDailyBudget') * 100),
            maxBudgetStepPct: n('maxBudgetStepPct'),
            maxDailyCommitmentCents: Math.round(n('maxDailyCommitment') * 100),
            cooldownHours: n('cooldownHours'),
            maxActionsPerRun: n('maxActionsPerRun'),
            maxEvidenceAgeHours: n('maxEvidenceAgeHours'),
            harvestMinClicks: n('harvestMinClicks'),
            harvestMinOrders: n('harvestMinOrders'),
            negativeMinClicks: n('negativeMinClicks'),
            negativeMaxProbability: n('negativeMaxProbability'),
            bidMinClicks: n('bidMinClicks'),
          },
        },
        'PATCH',
      );
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const field = (label: string, name: string, value: number, step = '1', min = '0') => (
    <label key={name}>
      {label}
      <input name={name} type="number" step={step} min={min} defaultValue={value} required />
    </label>
  );
  return (
    <form onSubmit={submit} className="form-stack">
      <div className="segmented wide-segment" aria-label="Operating mode">
        {(['observe', 'recommend', 'supervised', 'bounded'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={mode === m ? 'selected' : ''}
            onClick={() => setMode(m)}
          >
            {modeLabel[m]}
          </button>
        ))}
      </div>
      <p className="form-help">
        Observe reads only. Recommend saves proposals. Supervised executes exact reviewed changes
        when you press Execute. Bounded authorizes and executes the allowed classes below on every
        run, within the envelope.
        {mode === 'bounded' &&
          account.connector === 'amazon-ads' &&
          !liveWritesEnabled &&
          ' Live writes are disabled on this server, so bounded mode cannot be saved for this account yet.'}
      </p>
      <div className="form-section-heading">Bounded automation may authorize</div>
      <div className="checklist brain-classes">
        {actionClasses.map((c) => (
          <label key={c}>
            <input
              type="checkbox"
              checked={allowed.includes(c)}
              onChange={(e) =>
                setAllowed(e.target.checked ? [...allowed, c] : allowed.filter((x) => x !== c))
              }
            />
            <span>{classLabel[c]}</span>
          </label>
        ))}
      </div>
      <div className="form-section-heading">Envelope</div>
      <div className="form-grid three">
        {field('Maximum bid ($)', 'maxBid', policy.maxBidCents / 100, '0.01')}
        {field('Bid step (%)', 'maxBidStepPct', policy.maxBidStepPct)}
        {field(
          'Maximum daily budget ($)',
          'maxDailyBudget',
          policy.maxDailyBudgetCents / 100,
          '0.01',
        )}
        {field('Budget step (%)', 'maxBudgetStepPct', policy.maxBudgetStepPct)}
        {field(
          'Daily commitment envelope ($)',
          'maxDailyCommitment',
          policy.maxDailyCommitmentCents / 100,
          '0.01',
        )}
        {field('Cooldown per target (hours)', 'cooldownHours', policy.cooldownHours)}
        {field('Actions per run', 'maxActionsPerRun', policy.maxActionsPerRun, '1', '1')}
        {field(
          'Maximum evidence age (hours)',
          'maxEvidenceAgeHours',
          policy.maxEvidenceAgeHours,
          '1',
          '1',
        )}
      </div>
      <div className="form-section-heading">Evidence floors</div>
      <div className="form-grid three">
        {field(
          'Harvest: minimum mature clicks',
          'harvestMinClicks',
          policy.harvestMinClicks,
          '1',
          '1',
        )}
        {field('Harvest: minimum purchases', 'harvestMinOrders', policy.harvestMinOrders, '1', '1')}
        {field(
          'Negative: minimum mature clicks',
          'negativeMinClicks',
          policy.negativeMinClicks,
          '1',
          '1',
        )}
        {field(
          'Negative: maximum P(profitable)',
          'negativeMaxProbability',
          policy.negativeMaxProbability,
          '0.01',
        )}
        {field('Bid changes: minimum mature clicks', 'bidMinClicks', policy.bidMinClicks, '1', '1')}
      </div>
      <div className="checklist">
        <label>
          <input type="checkbox" name="autoSync" defaultChecked={policy.autoSync} />
          <span>Run the brain automatically on the server schedule (workspace accounts).</span>
        </label>
        <label>
          <input type="checkbox" name="aiReview" defaultChecked={policy.aiReview} />
          <span>
            Ask the AI provider to review search-term relevance before proposing harvests and
            negatives.
          </span>
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-footer">
        <span>
          <ShieldCheck size={14} />
          Saving creates a new policy version
        </span>
        <button className="button primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save policy'}
        </button>
      </div>
    </form>
  );
}

function LedgerForm({ data, onSaved }: { data: Dashboard; onSaved: () => void }) {
  const [campaignId, setCampaignId] = useState(data.campaigns[0]?.id || '');
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(event.currentTarget);
    try {
      await api('/brain/ledger', {
        dataset: 'workspace',
        campaignId,
        csv,
        reconciled: f.get('reconciled') === 'on',
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="form-stack">
      <label>
        Campaign
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} required>
          {data.campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Ledger CSV
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={8}
          placeholder="date,units,net_receipts_cents,refunds_cents"
          required
        />
      </label>
      <div className="checklist">
        <label>
          <input type="checkbox" name="reconciled" required />
          <span>These rows are reconciled receipts and units, not platform-attributed sales.</span>
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-footer">
        <span>Overlapping dates are replaced.</span>
        <button className="button primary" disabled={busy}>
          {busy ? 'Importing…' : 'Import ledger'}
        </button>
      </div>
    </form>
  );
}

function Explanation({ dataset, ids }: { dataset: string; ids: string[] }) {
  const [result, setResult] = useState<{
    explanation: { summary: string; risks: string[]; checks: string[] };
    provider: string;
    model: string;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{
      explanation: { summary: string; risks: string[]; checks: string[] };
      provider: string;
      model: string;
    }>('/brain/proposals/explain', { dataset, ids })
      .then(setResult)
      .catch((e) => setError(e.message));
  }, [dataset, ids]);
  if (error) return <p className="form-error">{error}</p>;
  if (!result) return <p className="form-help">Asking the model…</p>;
  return (
    <div className="detail-stack">
      <p>{result.explanation.summary}</p>
      <div className="form-section-heading">Risks</div>
      <ul className="brain-list">
        {result.explanation.risks.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <div className="form-section-heading">Checks before authorizing</div>
      <ul className="brain-list">
        {result.explanation.checks.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <p className="form-help">
        Generated by {result.provider} · {result.model}. The model saw the proposal digests and your
        unit economics only; it cannot authorize or execute anything.
      </p>
    </div>
  );
}

function ProposalDetail({ proposal: p }: { proposal: Proposal }) {
  return (
    <div className="detail-stack">
      <p>{p.reason}</p>
      <div className="economics-list">
        <div>
          <span>Change</span>
          <strong>{change(p)}</strong>
        </div>
        <div>
          <span>Expected prior state</span>
          <strong>{JSON.stringify(p.expectedPriorState)}</strong>
        </div>
        <div>
          <span>Read-back</span>
          <strong>{p.readBack ? JSON.stringify(p.readBack) : '—'}</strong>
        </div>
        <div>
          <span>Daily commitment</span>
          <strong>{money(p.maxCommitmentCents, 2)}</strong>
        </div>
        <div>
          <span>Evidence</span>
          <strong>
            {p.evidence.sourceLabel}: {number(p.evidence.matureClicks)} clicks,{' '}
            {number(p.evidence.matureOrders)} purchases, {money(p.evidence.spendCents, 2)} spend
            through {date(p.evidence.matureThrough)}
          </strong>
        </div>
        <div>
          <span>Modeled</span>
          <strong>
            {percent(p.evidence.probabilityProfitable)} profitable · CPC{' '}
            {p.evidence.cpcCents === null ? '—' : money(p.evidence.cpcCents, 2)} · affordable{' '}
            {money(p.evidence.affordableCpcCents, 2)}
          </strong>
        </div>
        <div>
          <span>Authorization</span>
          <strong>
            {p.authorization
              ? `${p.authorization.by} · policy ${p.authorization.policyVersion} · ${timeAgo(p.authorization.at)}`
              : 'none'}
          </strong>
        </div>
        <div>
          <span>Idempotency key</span>
          <strong className="mono">{p.idempotencyKey.slice(0, 24)}…</strong>
        </div>
      </div>
      <div className="form-section-heading">History</div>
      <ul className="brain-list">
        {p.history.map((h, i) => (
          <li key={i}>
            <Badge kind={statusKind(h.status)}>{h.status}</Badge> {h.note}{' '}
            <span className="subtle">{new Date(h.at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
      <p className="form-help">
        <CheckCircle2 size={13} /> Expires {new Date(p.expiresAt).toLocaleString()} ·{' '}
        <Activity size={13} /> evidence observed {timeAgo(p.evidence.observedAt)}
      </p>
    </div>
  );
}
