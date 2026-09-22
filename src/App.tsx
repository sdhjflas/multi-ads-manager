import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity as ActivityIcon,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Boxes,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Compass,
  Database,
  Download,
  ExternalLink,
  FileUp,
  FlaskConical,
  History,
  LayoutDashboard,
  Loader2,
  Menu,
  MoreHorizontal,
  Network,
  Plus,
  Search,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingUp,
  Unplug,
  Wallet,
  X,
  Zap,
} from 'lucide-react';
import type { CampaignView, Dashboard, Dataset, Experiment } from '../shared/types';
import {
  AllocationChart,
  Badge,
  CampaignTable,
  ChannelMark,
  Count,
  Empty,
  MetricCard,
  Modal,
  OrbitLogo,
  PerformanceChart,
} from './components';
import {
  CampaignDetail,
  CampaignForm,
  ConnectionDetail,
  connections,
  ExperimentDetail,
  ExperimentForm,
  ImportForm,
} from './forms';
import { api, channelName, date, money, number, percent, timeAgo } from './lib';
import { TargetExplorer, TargetDetail } from './TargetExplorer';
import { WaveBoard, WaveDetail, WaveForm, LearningLibrary } from './Waves';
import { ReportingHub } from './Reporting';

type Page =
  | 'overview'
  | 'products'
  | 'books'
  | 'experiments'
  | 'targets'
  | 'waves'
  | 'learning'
  | 'intelligence'
  | 'reporting'
  | 'connections'
  | 'activity'
  | 'blueprint';
type ModalState =
  | { type: 'campaign' }
  | { type: 'experiment'; targetId?: string; learningId?: string }
  | { type: 'import' }
  | { type: 'target-import' }
  | {
      type:
        | 'campaign-detail'
        | 'campaign-edit'
        | 'experiment-detail'
        | 'connection'
        | 'target-detail'
        | 'wave-form'
        | 'wave-detail';
      id: string;
    }
  | null;
const nav: { id: Page; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} /> },
  { id: 'products', label: 'Product ads', icon: <ShoppingBag size={18} /> },
  { id: 'books', label: 'Amazon books', icon: <BookOpen size={18} /> },
  { id: 'experiments', label: 'Experiment lab', icon: <FlaskConical size={18} /> },
  { id: 'waves', label: 'Test waves', icon: <ChartNoAxesCombined size={18} /> },
  { id: 'learning', label: 'Learning library', icon: <BookOpen size={18} /> },
  { id: 'targets', label: 'Target explorer', icon: <Target size={18} /> },
  { id: 'intelligence', label: 'Intelligence', icon: <Sparkles size={18} /> },
  { id: 'reporting', label: 'Reporting hub', icon: <Database size={18} /> },
  { id: 'connections', label: 'Connections', icon: <Unplug size={18} /> },
  { id: 'activity', label: 'Activity log', icon: <History size={18} /> },
  { id: 'blueprint', label: 'The blueprint', icon: <Network size={18} /> },
];
const pageCopy: Record<Page, { eyebrow: string; title: string; subtitle: string }> = {
  overview: {
    eyebrow: 'YOUR ADVERTISING, CONNECTED',
    title: 'A clearer view. A smarter next move.',
    subtitle: 'One place to understand performance, test ideas, and grow with intention.',
  },
  products: {
    eyebrow: 'PRODUCT ADVERTISING',
    title: 'Find the details that drive demand.',
    subtitle: 'Creative, audience, and product economics — in the same conversation.',
  },
  books: {
    eyebrow: 'AMAZON BOOK ADVERTISING',
    title: 'Find your book’s next reader.',
    subtitle: 'Discover useful keywords. Measure publisher contribution. Build on what works.',
  },
  experiments: {
    eyebrow: 'THE EXPERIMENT LAB',
    title: 'Big libraries. Thoughtful little tests.',
    subtitle: 'Turn a hypothesis into candidates, then build the next controlled wave.',
  },
  targets: {
    eyebrow: 'WHERE THE SIGNAL LIVES',
    title: 'Find what’s working. Understand why.',
    subtitle: 'Look inside your campaigns, from an individual keyword to a creative opening.',
  },
  waves: {
    eyebrow: 'CLOSE THE LEARNING LOOP',
    title: 'Give every test a clear question.',
    subtitle: 'Freeze the plan. Measure the candidates. Carry the useful evidence forward.',
  },
  learning: {
    eyebrow: 'YOUR ADVERTISING MEMORY',
    title: 'Make the next test a better one.',
    subtitle: 'An evidence trail for what worked, what failed, and what remains uncertain.',
  },
  intelligence: {
    eyebrow: 'EVIDENCE INTO ACTION',
    title: 'Every next move needs a reason.',
    subtitle: 'Review the evidence behind each recommendation before changing your campaigns.',
  },
  connections: {
    eyebrow: 'YOUR CONNECTED WORKSPACE',
    title: 'Bring the right signals together.',
    subtitle: 'Prepare your ad accounts, business data, and optional AI provider.',
  },
  reporting: {
    eyebrow: 'THE EVIDENCE INBOX',
    title: 'Reliable reports. Traceable decisions.',
    subtitle: 'Bring campaign and target reports together, with every correction accounted for.',
  },
  activity: {
    eyebrow: 'THE WORKSPACE JOURNAL',
    title: 'A record of every meaningful move.',
    subtitle: 'Imports, experiment drafts, and operator decisions, saved as you work.',
  },
  blueprint: {
    eyebrow: 'BUILT FOR THE LONG GAME',
    title: 'A brain for better advertising.',
    subtitle: 'The architecture, research, and delivery plan behind Orbit.',
  },
};

export function App() {
  const initialPage = location.hash.slice(1) as Page;
  const [page, setPage] = useState<Page>(
    nav.some((n) => n.id === initialPage) ? initialPage : 'overview',
  );
  const [dataset, setDataset] = useState<Dataset>('demo');
  const [days, setDays] = useState('28'),
    [query, setQuery] = useState('');
  const [data, setData] = useState<Dashboard | null>(null),
    [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ModalState>(null),
    [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const vertical = page === 'products' ? 'commerce' : page === 'books' ? 'books' : 'all';
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    api<Dashboard>(
      `/dashboard?dataset=${dataset}&vertical=${vertical}&days=${days}`,
      undefined,
      'GET',
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (e.name !== 'AbortError') setLoadError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [dataset, vertical, days, revision]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const listener = () => {
      const next = location.hash.slice(1) as Page;
      if (nav.some((n) => n.id === next)) setPage(next);
    };
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  function navigate(next: Page) {
    setPage(next);
    location.hash = next;
    setQuery('');
    setStatusFilter('all');
    setMobileOpen(false);
    refresh();
    window.scrollTo({ top: 0 });
  }
  function refresh() {
    setRevision((r) => r + 1);
  }
  function saved(message: string) {
    refresh();
    setModal(null);
    setToast({ message, error: false });
  }
  async function perform(work: () => Promise<unknown>, message: string, close = false) {
    setBusy(true);
    try {
      await work();
      refresh();
      if (close) setModal(null);
      setToast({ message, error: false });
    } catch (e) {
      setToast({ message: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }
  const proposals =
    data?.campaigns.filter(
      (c) =>
        ['scale', 'reduce', 'explore'].includes(c.decision.kind) &&
        !data.reviews.some((r) => r.campaignId === c.id && r.evidenceId === c.decision.evidenceId),
    ) || [];
  const campaigns =
    data?.campaigns.filter(
      (c) =>
        `${c.name} ${c.entityName} ${c.accountName} ${channelName[c.channel]}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (statusFilter === 'all' || c.decision.kind === statusFilter),
    ) || [];
  const copy = pageCopy[page];
  const exportUrl = `/api/export?dataset=${dataset}&vertical=${vertical}&days=${days}`;
  const selectedCampaign =
    modal && 'id' in modal ? data?.campaigns.find((c) => c.id === modal.id) : undefined;
  const selectedExperiment =
    modal && 'id' in modal ? data?.experiments.find((e) => e.id === modal.id) : undefined;
  const selectedWave =
    modal?.type === 'wave-detail' ? data?.waves.find((w) => w.id === modal.id) : undefined;
  const sourceLearning =
    modal?.type === 'experiment'
      ? data?.learnings.find((l) => l.id === modal.learningId)
      : undefined;
  const selectedTarget =
    modal && (modal.type === 'target-detail' || modal.type === 'experiment')
      ? data?.targets.find((t) => t.id === ('id' in modal ? modal.id : modal.targetId))
      : undefined;
  const showImport = () => {
    setDataset('workspace');
    setModal({ type: 'import' });
  };

  return (
    <div className="app-shell">
      {mobileOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <a
          className="brand"
          href="#overview"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
        >
          <OrbitLogo />
          <span>
            orbit<span className="brand-period">.</span>
          </span>
          <span className="brand-label">ADS INTELLIGENCE</span>
        </a>
        <div className="workspace-picker">
          <span className="workspace-avatar">P</span>
          <div>
            <strong>Pathway workspace</strong>
            <select
              aria-label="Data workspace"
              value={dataset}
              onChange={(e) => {
                setDataset(e.target.value as Dataset);
                setModal(null);
              }}
            >
              <option value="demo">Demo workspace</option>
              <option value="workspace">Your workspace</option>
            </select>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-caption">COMMAND CENTER</div>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <div key={item.id}>
              {item.id === 'reporting' && <div className="nav-caption second">WORKSPACE</div>}
              <button
                className={`nav-item ${page === item.id ? 'active' : ''}`}
                aria-current={page === item.id ? 'page' : undefined}
                onClick={() => navigate(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.id === 'intelligence' && proposals.length > 0 && (
                  <span className="nav-count">{proposals.length}</span>
                )}
                {item.id === 'experiments' && <span className="new-indicator" />}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-callout">
            <div className="mini-orbit">
              <OrbitLogo small />
              <span className="tiny-star">✧</span>
            </div>
            <strong>
              Built to learn.
              <br />
              Designed to grow.
            </strong>
            <p>
              Your next great campaign
              <br />
              starts with a good question.
            </p>
            <button onClick={() => navigate('blueprint')}>
              Explore the blueprint
              <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="operator">
            <span className="operator-avatar">PS</span>
            <div>
              <strong>Pathway Studio</strong>
              <span>Local operator workspace</span>
            </div>
            <ShieldCheck size={15} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb-workspace">Workspace</span>
            <ChevronRight size={13} />
            <strong>{nav.find((n) => n.id === page)?.label}</strong>
          </div>
          <div className="topbar-actions">
            <div className="global-search">
              <Search size={15} />
              <input
                aria-label="Search campaigns and experiments"
                placeholder="Search your workspace…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query ? (
                <button
                  className="icon-button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              ) : (
                <span className="search-hint">⌕</span>
              )}
            </div>
            <span className="topbar-divider" />
            <button
              className="icon-button notification"
              aria-label="View activity log"
              onClick={() => navigate('activity')}
            >
              <Bell size={18} />
              <i />
            </button>
            <span className="profile-avatar" title="Local operator">
              P
            </span>
          </div>
        </header>
        <main className="main-content" id="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">{copy.eyebrow}</div>
              <h1>{copy.title}</h1>
              <p>{copy.subtitle}</p>
            </div>
            <div className="heading-actions">
              {['overview', 'products', 'books'].includes(page) && (
                <button className="button secondary" onClick={showImport}>
                  <FileUp size={15} />
                  Import data
                </button>
              )}
              <button className="button primary" onClick={() => setModal({ type: 'experiment' })}>
                <Plus size={16} />
                New experiment
              </button>
            </div>
          </div>
          <div className={`workspace-notice ${dataset === 'demo' ? '' : 'real-workspace'}`}>
            <span>
              <span className="notice-orb" />
              {dataset === 'demo' ? (
                <>
                  <strong>You’re exploring the demo.</strong> Fictional data
                  {data ? ` · snapshot ${date(data.reportingAt)}` : ''}. No live accounts are
                  connected.
                </>
              ) : (
                <>
                  <strong>Your workspace.</strong> Imported reports and local plans. Live ad
                  management is not enabled.
                </>
              )}
            </span>
            <button
              onClick={() => {
                if (dataset === 'demo') setDataset('workspace');
                else navigate('connections');
              }}
            >
              {dataset === 'demo' ? 'Set up your workspace' : 'View connections'}
              <ArrowRight size={14} />
            </button>
          </div>
          {loadError ? (
            <Empty
              icon={<Unplug size={28} />}
              title="The workspace couldn’t load"
              action={
                <button className="button primary" onClick={refresh}>
                  Try again
                </button>
              }
            >
              {loadError}
            </Empty>
          ) : !data || data.dataset !== dataset ? (
            <div className="loading-state">
              <Loader2 className="spin" size={28} />
              <span>Bringing your workspace into focus…</span>
            </div>
          ) : (
            <div className={loading ? 'content-loading' : ''}>
              {['overview', 'products', 'books'].includes(page) && (
                <>
                  <div className="overview-toolbar">
                    <div className="view-tabs">
                      <button
                        className={page === 'overview' ? 'active' : ''}
                        onClick={() => navigate('overview')}
                      >
                        All advertising
                      </button>
                      <button
                        className={page === 'products' ? 'active' : ''}
                        onClick={() => navigate('products')}
                      >
                        Product ads
                      </button>
                      <button
                        className={page === 'books' ? 'active' : ''}
                        onClick={() => navigate('books')}
                      >
                        Amazon books
                      </button>
                    </div>
                    <div className="range-actions">
                      <span className="updated">
                        <i />
                        Updated {timeAgo(data.generatedAt)}
                      </span>
                      <label className="date-select">
                        <CalendarDays size={14} />
                        <select
                          aria-label="Reporting period"
                          value={days}
                          onChange={(e) => setDays(e.target.value)}
                        >
                          <option value="7">Last 7 days</option>
                          <option value="28">Last 28 days</option>
                          <option value="56">Last 56 days</option>
                        </select>
                        <ChevronDown size={13} />
                      </label>
                      <a
                        className="icon-button bordered"
                        href={exportUrl}
                        aria-label="Export campaign summary"
                      >
                        <Download size={15} />
                      </a>
                    </div>
                  </div>
                  <div className="metric-grid">
                    <MetricCard
                      title="Modeled contribution"
                      value={money(data.summary.contributionCents)}
                      current={data.summary.contributionCents}
                      prior={data.comparisonComplete ? data.previous.contributionCents : null}
                      icon={<TrendingUp size={17} />}
                      caption="vs. previous period"
                      accent
                    />
                    <MetricCard
                      title="Total ad spend"
                      value={money(data.summary.spendCents)}
                      current={data.summary.spendCents}
                      prior={data.comparisonComplete ? data.previous.spendCents : null}
                      icon={<Wallet size={17} />}
                      caption="vs. previous period"
                    />
                    <MetricCard
                      title="Retail ROAS"
                      value={data.summary.roas === null ? '—' : `${data.summary.roas.toFixed(2)}×`}
                      current={data.summary.roas}
                      prior={data.comparisonComplete ? data.previous.roas : null}
                      icon={<ChartNoAxesCombined size={17} />}
                      caption="attributed sales / spend"
                    />
                    <MetricCard
                      title="Experiment candidates"
                      value={number(data.experiments.reduce((n, e) => n + e.variants.length, 0))}
                      icon={<FlaskConical size={17} />}
                      caption={`${data.experiments.length} draft experiments · ${data.experiments.reduce((n, e) => n + e.variants.filter((v) => v.state === 'shortlisted').length, 0)} shortlisted`}
                    />
                  </div>
                  <div className="chart-grid">
                    <PerformanceChart data={data} />
                    <AllocationChart campaigns={data.campaigns} />
                  </div>
                  {page === 'books' && (
                    <div className="book-insight">
                      <BookOpen size={22} />
                      <div>
                        <strong>A book’s retail sales aren’t its earnings.</strong>
                        <p>
                          Orbit uses publisher receipts less print and variable costs to estimate
                          contribution. Check each title’s break-even ACOS before raising a bid.
                        </p>
                      </div>
                      <button className="text-button" onClick={() => navigate('blueprint')}>
                        Our approach
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                  {page === 'products' && (
                    <div className="book-insight">
                      <ShoppingBag size={22} />
                      <div>
                        <strong>Connect the creative to the economics.</strong>
                        <p>
                          Keep product evidence, stock, fulfillment, and contribution limits
                          attached to every test. A strong click rate alone doesn’t make an ad
                          profitable.
                        </p>
                      </div>
                      <button className="text-button" onClick={() => navigate('experiments')}>
                        Open the lab
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                  <section className="panel campaigns-panel">
                    <div className="panel-heading">
                      <div className="title-with-count">
                        <h2>
                          {page === 'books'
                            ? 'Book campaigns'
                            : page === 'products'
                              ? 'Product campaigns'
                              : 'Your campaign portfolio'}
                        </h2>
                        <Count value={data.campaigns.length} />
                      </div>
                      <div className="table-actions">
                        <label className="filter-select">
                          <SlidersHorizontal size={13} />
                          <select
                            aria-label="Filter campaign status"
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value)}
                          >
                            <option value="all">All statuses</option>
                            <option value="scale">Scale candidates</option>
                            <option value="reduce">Needs attention</option>
                            <option value="explore">Exploring</option>
                            <option value="hold">Gathering data</option>
                            <option value="repair">Evidence needed</option>
                          </select>
                        </label>
                        <button
                          className="text-button"
                          onClick={() => setModal({ type: 'campaign' })}
                        >
                          <Plus size={14} />
                          Add campaign
                        </button>
                      </div>
                    </div>
                    <CampaignTable
                      campaigns={campaigns}
                      onOpen={(c) => setModal({ type: 'campaign-detail', id: c.id })}
                    />
                    <div className="table-footer">
                      <span>
                        Channel-attributed estimates can overlap. Contribution is before fixed
                        costs, not reconciled business profit.
                      </span>
                      <span>
                        USD
                        <ChevronDown size={11} />
                      </span>
                    </div>
                  </section>
                  <div className="bottom-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <div className="title-with-count">
                          <Sparkles size={17} className="purple-icon" />
                          <h2>Your next best moves</h2>
                          <Count value={proposals.length} />
                        </div>
                        <button className="text-button" onClick={() => navigate('intelligence')}>
                          View all
                          <ArrowRight size={13} />
                        </button>
                      </div>
                      <div className="moves-list">
                        {proposals.slice(0, 3).map((c) => (
                          <button
                            className="move-row"
                            key={c.id}
                            onClick={() => setModal({ type: 'campaign-detail', id: c.id })}
                          >
                            <span className={`move-icon ${c.decision.kind}`}>
                              {c.decision.kind === 'scale' ? (
                                <TrendingUp size={17} />
                              ) : c.decision.kind === 'reduce' ? (
                                <SlidersHorizontal size={17} />
                              ) : (
                                <FlaskConical size={17} />
                              )}
                            </span>
                            <div>
                              <strong>{c.decision.title}</strong>
                              <span>{c.entityName}</span>
                            </div>
                            <ChevronRight size={15} />
                          </button>
                        ))}
                        {!proposals.length && (
                          <div className="empty-inline">
                            New recommendations appear when there’s enough evidence.
                          </div>
                        )}
                      </div>
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <div className="title-with-count">
                          <h2>Workspace activity</h2>
                        </div>
                        <button className="text-button" onClick={() => navigate('activity')}>
                          View log
                          <ArrowRight size={13} />
                        </button>
                      </div>
                      <div className="activity-preview">
                        {data.activity.slice(0, 3).map((item) => (
                          <div key={item.id}>
                            <span className="timeline-dot" />
                            <div>
                              <strong>{item.title}</strong>
                              <span>{timeAgo(item.createdAt)}</span>
                            </div>
                          </div>
                        ))}
                        {!data.activity.length && (
                          <div className="empty-inline">
                            Your first import or experiment will appear here.
                          </div>
                        )}
                      </div>
                    </section>
                  </div>
                </>
              )}
              {page === 'experiments' && (
                <>
                  <div className="lab-summary">
                    <div>
                      <FlaskConical size={21} />
                      <span>
                        <strong>{data.experiments.length}</strong> experiments
                      </span>
                    </div>
                    <div>
                      <Boxes size={21} />
                      <span>
                        <strong>
                          {number(data.experiments.reduce((s, e) => s + e.variants.length, 0))}
                        </strong>{' '}
                        candidates
                      </span>
                    </div>
                    <div>
                      <Target size={21} />
                      <span>
                        <strong>
                          {data.experiments.reduce(
                            (s, e) =>
                              s + e.variants.filter((v) => v.state === 'shortlisted').length,
                            0,
                          )}
                        </strong>{' '}
                        shortlisted
                      </span>
                    </div>
                    <span className="lab-label">
                      <ShieldCheck size={15} />
                      Plans and measured waves
                    </span>
                  </div>
                  <div className="section-heading">
                    <h2>Your hypothesis library</h2>
                    <span>{data.experiments.length} experiments</span>
                  </div>
                  <div className="experiment-grid">
                    {data.experiments
                      .filter((e) =>
                        `${e.name} ${e.hypothesis}`.toLowerCase().includes(query.toLowerCase()),
                      )
                      .map((experiment, i) => {
                        const c = data.campaigns.find((c) => c.id === experiment.campaignId);
                        return (
                          <button
                            className="experiment-card"
                            key={experiment.id}
                            onClick={() =>
                              setModal({ type: 'experiment-detail', id: experiment.id })
                            }
                          >
                            <div className={`experiment-art art-${i % 4}`}>
                              <div className="art-grid" />
                              <span className="art-channel">
                                {c && <ChannelMark channel={c.channel} />}
                                <span>
                                  {c?.vertical === 'books'
                                    ? 'READER DISCOVERY'
                                    : 'CREATIVE EXPLORATION'}
                                </span>
                              </span>
                              <div className="experiment-diagram">
                                {[0, 1, 2, 3, 4].map((n) => (
                                  <span
                                    key={n}
                                    style={{
                                      transform: `translateY(${n % 2 ? -14 : 8}px) rotate(${(n - 2) * 5}deg)`,
                                    }}
                                  >
                                    {c?.vertical === 'books' ? (
                                      <BookOpen size={20} />
                                    ) : n % 2 ? (
                                      <Target size={20} />
                                    ) : (
                                      <Sparkles size={20} />
                                    )}
                                  </span>
                                ))}
                              </div>
                              <span className="art-label">
                                {experiment.variants.length} possibilities. One clear question.
                              </span>
                            </div>
                            <div className="experiment-body">
                              <div className="experiment-meta">
                                <Badge kind="neutral">
                                  {data.waves.some((w) => w.experimentId === experiment.id)
                                    ? 'Measurement registered'
                                    : 'Draft experiment'}
                                </Badge>
                                <span>{date(experiment.createdAt)}</span>
                              </div>
                              <h3>{experiment.name}</h3>
                              <p>{experiment.hypothesis}</p>
                              <div className="experiment-footer">
                                <span>
                                  <FlaskConical size={14} />
                                  {experiment.variants.length} candidates
                                </span>
                                <span>
                                  {
                                    experiment.variants.filter((v) => v.state === 'shortlisted')
                                      .length
                                  }{' '}
                                  / {experiment.maxConcurrent} selected
                                  <ArrowUpRight size={15} />
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                  </div>
                  {!data.experiments.length && (
                    <Empty
                      icon={<FlaskConical size={30} />}
                      title="Make room for your first hypothesis"
                      action={
                        <button
                          className="button primary"
                          onClick={() => setModal({ type: 'experiment' })}
                        >
                          <Plus size={15} />
                          New experiment
                        </button>
                      }
                    >
                      Generate a library of creative or keyword candidates, then shortlist a small
                      wave.
                    </Empty>
                  )}
                  <div className="workflow-strip">
                    {[
                      'Brief the hypothesis',
                      'Build the candidate library',
                      'Shortlist a small wave',
                      'Confirm before scaling',
                    ].map((text, i) => (
                      <div key={text}>
                        <span>0{i + 1}</span>
                        <strong>{text}</strong>
                        {i < 3 && <ChevronRight size={17} />}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {page === 'targets' && (
                <TargetExplorer
                  data={data}
                  query={query}
                  onImport={() => {
                    setDataset('workspace');
                    setModal({ type: 'target-import' });
                  }}
                  onOpen={(target) => setModal({ type: 'target-detail', id: target.id })}
                />
              )}
              {page === 'waves' && (
                <WaveBoard
                  data={data}
                  query={query}
                  onOpen={(id) => setModal({ type: 'wave-detail', id })}
                  onLab={() => navigate('experiments')}
                />
              )}
              {page === 'learning' && (
                <LearningLibrary
                  data={data}
                  query={query}
                  onWave={(id) => setModal({ type: 'wave-detail', id })}
                  onFollowUp={(learningId) => setModal({ type: 'experiment', learningId })}
                />
              )}
              {page === 'reporting' && (
                <ReportingHub
                  data={data}
                  query={query}
                  onWorkspace={() => setDataset('workspace')}
                  onCampaign={() => setModal({ type: 'campaign' })}
                />
              )}
              {page === 'intelligence' && (
                <>
                  <div className="intelligence-banner">
                    <div className="intelligence-emblem">
                      <Sparkles size={26} />
                    </div>
                    <div>
                      <h2>Clear calculations. Considered recommendations.</h2>
                      <p>
                        The contribution model reviews mature evidence. The optional AI provider
                        drafts your next experiments.
                      </p>
                    </div>
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        perform(
                          () => api('/analysis', { dataset }),
                          'Evidence review completed. Recommendations refreshed.',
                        )
                      }
                    >
                      <Sparkles size={15} />
                      {busy ? 'Reviewing…' : 'Run evidence review'}
                    </button>
                  </div>
                  <div className="section-heading">
                    <h2>Recommendations for review</h2>
                    <span>{proposals.length} open proposals</span>
                  </div>
                  <div className="recommendation-grid">
                    {data.campaigns
                      .filter((c) =>
                        `${c.name} ${c.entityName}`.toLowerCase().includes(query.toLowerCase()),
                      )
                      .map((c) => {
                        const review = data.reviews.find(
                          (r) => r.campaignId === c.id && r.evidenceId === c.decision.evidenceId,
                        );
                        return (
                          <article className="recommendation-card" key={c.id}>
                            <div className="recommendation-top">
                              <ChannelMark channel={c.channel} />
                              <span>{c.entityName}</span>
                              <Badge kind={review ? 'neutral' : c.decision.kind}>
                                {review
                                  ? review.action === 'accepted'
                                    ? 'Saved for review'
                                    : 'Dismissed'
                                  : undefined}
                              </Badge>
                            </div>
                            <h3>{c.decision.title}</h3>
                            <p>{c.decision.reason}</p>
                            <div className="evidence-facts">
                              <span>
                                <b>{number(c.decision.matureClicks)}</b> mature clicks
                              </span>
                              <span>
                                <b>{number(c.decision.matureOrders)}</b> purchases
                              </span>
                              <span>
                                <b>{percent(c.decision.probabilityProfitable)}</b> modeled
                                probability
                              </span>
                            </div>
                            <div className="recommendation-actions">
                              <button
                                className="text-button"
                                onClick={() => setModal({ type: 'campaign-detail', id: c.id })}
                              >
                                Inspect evidence
                                <ArrowRight size={14} />
                              </button>
                              {!review &&
                                ['scale', 'reduce', 'explore'].includes(c.decision.kind) && (
                                  <button
                                    className="button secondary small-button"
                                    disabled={busy}
                                    onClick={() =>
                                      perform(
                                        () =>
                                          api('/reviews', {
                                            dataset,
                                            campaignId: c.id,
                                            evidenceId: c.decision.evidenceId,
                                            action: 'dismissed',
                                          }),
                                        'Proposal dismissed and recorded.',
                                      )
                                    }
                                  >
                                    Dismiss
                                  </button>
                                )}
                            </div>
                          </article>
                        );
                      })}
                  </div>
                  {!data.campaigns.length && (
                    <Empty
                      icon={<Sparkles size={30} />}
                      title="Good recommendations start with good data"
                      action={
                        <button
                          className="button primary"
                          onClick={() => setModal({ type: 'campaign' })}
                        >
                          Create a campaign
                        </button>
                      }
                    >
                      Add a campaign, verify its economics, and import a current daily report.
                    </Empty>
                  )}
                  <div className="inline-note page-note">
                    <ShieldCheck size={19} />
                    <p>
                      These are observational screening recommendations. The model cannot promise
                      future profit. Recent reporting cohorts are excluded from performance
                      judgments, and a saved proposal never changes a platform budget.
                    </p>
                  </div>
                </>
              )}
              {page === 'connections' && (
                <>
                  <div className="connections-status">
                    <span>
                      <i className="dot amber" />0 live ad accounts connected
                    </span>
                    <span>
                      <FileUp size={15} />
                      CSV imports available now
                    </span>
                    <span>
                      <Sparkles size={15} />
                      {data.ai.configured ? 'AI provider configured' : 'Structured planner ready'}
                    </span>
                  </div>
                  <div className="connections-grid">
                    {connections
                      .filter((c) =>
                        `${c.name} ${c.description}`.toLowerCase().includes(query.toLowerCase()),
                      )
                      .map((c) => (
                        <article className="connection-card" key={c.id}>
                          <div className="connection-top">
                            <span className={`integration-mark ${c.className}`}>{c.letter}</span>
                            <Badge
                              kind={c.id === 'openai' && data.ai.configured ? 'scale' : 'neutral'}
                            >
                              {c.id === 'openai' && data.ai.configured
                                ? 'Configured · unverified'
                                : c.status}
                            </Badge>
                          </div>
                          <span className="eyebrow">{c.category}</span>
                          <h2>{c.name}</h2>
                          <p>{c.description}</p>
                          <button
                            className="button secondary"
                            onClick={() => setModal({ type: 'connection', id: c.id })}
                          >
                            View setup guide
                            <ArrowUpRight size={15} />
                          </button>
                        </article>
                      ))}
                  </div>
                  <div className="import-callout">
                    <span className="empty-icon">
                      <FileUp size={25} />
                    </span>
                    <div>
                      <h3>Your reports can start the learning.</h3>
                      <p>
                        Map your reporting sources and preview campaign or target batches while API
                        access is being prepared.
                      </p>
                    </div>
                    <button className="button primary" onClick={() => navigate('reporting')}>
                      Open Reporting hub
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </>
              )}
              {page === 'activity' && (
                <section className="panel activity-panel">
                  <div className="panel-heading">
                    <h2>Workspace history</h2>
                    <span className="small-tag">Latest 100 events</span>
                  </div>
                  <div className="full-activity">
                    {data.activity
                      .filter((a) =>
                        `${a.title} ${a.detail}`.toLowerCase().includes(query.toLowerCase()),
                      )
                      .map((item) => (
                        <div key={item.id}>
                          <span className={`activity-kind ${item.kind}`}>
                            {item.kind === 'experiment' ? (
                              <FlaskConical size={17} />
                            ) : item.kind === 'import' ? (
                              <FileUp size={17} />
                            ) : item.kind === 'decision' ? (
                              <Check size={17} />
                            ) : (
                              <ActivityIcon size={17} />
                            )}
                          </span>
                          <div>
                            <strong>{item.title}</strong>
                            <p>{item.detail}</p>
                            <span>
                              {new Date(item.createdAt).toLocaleString()} ·{' '}
                              {dataset === 'demo' ? 'Demo workspace' : 'Your workspace'}
                            </span>
                          </div>
                        </div>
                      ))}
                  </div>
                  {!data.activity.length && (
                    <Empty icon={<History size={28} />} title="A clean slate">
                      Every import, draft, and review will leave a useful trail here.
                    </Empty>
                  )}
                </section>
              )}
              {page === 'blueprint' && (
                <Blueprint onConnection={(id) => setModal({ type: 'connection', id })} />
              )}
            </div>
          )}
          <footer className="app-footer">
            <span>
              <OrbitLogo small />A little more signal. A little less guesswork.
            </span>
            <span>
              Orbit v0.3<span className="footer-dot">·</span>Local advisory mode
              <ShieldCheck size={12} />
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <InfoIcon /> : <Check size={18} />}
          <span>{toast.message}</span>
          <button
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {modal && data && data.dataset === dataset && (
        <Modal
          key={`${modal.type}${'id' in modal ? modal.id : ''}`}
          title={
            modal.type === 'campaign'
              ? 'Create a campaign workspace'
              : modal.type === 'campaign-edit'
                ? 'Review campaign setup'
                : modal.type === 'experiment'
                  ? 'Start with a good hypothesis'
                  : modal.type === 'import'
                    ? 'Bring your performance into Orbit'
                    : modal.type === 'target-import'
                      ? 'Import measured targets and creatives'
                      : modal.type === 'target-detail'
                        ? selectedTarget?.label || 'Measured target'
                        : modal.type === 'campaign-detail'
                          ? selectedCampaign?.name || 'Campaign'
                          : modal.type === 'wave-form'
                            ? 'Register a measurement wave'
                            : modal.type === 'wave-detail'
                              ? selectedWave?.name || 'Test wave'
                              : modal.type === 'experiment-detail'
                                ? selectedExperiment?.name || 'Experiment'
                                : `${connections.find((c) => c.id === modal.id)?.name} setup`
          }
          subtitle={
            modal.type === 'experiment'
              ? 'A focused question. A bounded budget. A measurable outcome.'
              : modal.type === 'campaign'
                ? 'Map an existing campaign or plan a new one. This creates a local record.'
                : undefined
          }
          onClose={() => setModal(null)}
          wide={[
            'campaign-detail',
            'experiment-detail',
            'target-detail',
            'wave-form',
            'wave-detail',
          ].includes(modal.type)}
        >
          {modal.type === 'campaign' && (
            <CampaignForm
              dataset={dataset}
              initialVertical={page === 'books' ? 'books' : 'commerce'}
              onSaved={() => saved('Campaign workspace created.')}
            />
          )}
          {modal.type === 'campaign-edit' && selectedCampaign && (
            <CampaignForm
              dataset={dataset}
              initialVertical={selectedCampaign.vertical}
              existing={selectedCampaign}
              onSaved={() => saved('Campaign setup saved. Evidence has been recalculated.')}
            />
          )}
          {modal.type === 'experiment' && (
            <ExperimentForm
              data={data}
              seedTarget={selectedTarget}
              sourceLearning={sourceLearning}
              onSaved={() => saved('Experiment created. Your candidate library is ready.')}
              onCreateCampaign={() => setModal({ type: 'campaign' })}
            />
          )}
          {modal.type === 'import' && (
            <ImportForm
              data={data}
              onSaved={() =>
                saved('Report imported. Existing dates were refreshed without duplication.')
              }
              onCreateCampaign={() => setModal({ type: 'campaign' })}
            />
          )}
          {modal.type === 'target-import' && (
            <ImportForm
              data={data}
              targetMode
              onSaved={() =>
                saved('Target report imported. Signals checked against parent campaign totals.')
              }
              onCreateCampaign={() => setModal({ type: 'campaign' })}
            />
          )}
          {modal.type === 'target-detail' && selectedTarget && (
            <TargetDetail
              target={selectedTarget}
              onTest={() => setModal({ type: 'experiment', targetId: selectedTarget.id })}
            />
          )}
          {modal.type === 'campaign-detail' && selectedCampaign && (
            <CampaignDetail
              campaign={selectedCampaign}
              busy={busy}
              onEdit={() => setModal({ type: 'campaign-edit', id: selectedCampaign.id })}
              onStatus={() =>
                perform(
                  () =>
                    api(
                      `/campaigns/${selectedCampaign.id}/status`,
                      {
                        dataset,
                        status: selectedCampaign.status === 'paused' ? 'observing' : 'paused',
                      },
                      'PATCH',
                    ),
                  'Local monitoring updated. Platform delivery is unchanged.',
                )
              }
              onReview={(action) =>
                perform(
                  () =>
                    api('/reviews', {
                      dataset,
                      campaignId: selectedCampaign.id,
                      evidenceId: selectedCampaign.decision.evidenceId,
                      action,
                    }),
                  'Proposal saved for execution review. No platform changes.',
                  true,
                )
              }
            />
          )}
          {modal.type === 'experiment-detail' && selectedExperiment && (
            <ExperimentDetail
              experiment={selectedExperiment}
              onRegister={() => setModal({ type: 'wave-form', id: selectedExperiment.id })}
              onUpdated={(updated) => {
                setData((old) =>
                  old
                    ? {
                        ...old,
                        experiments: old.experiments.map((e) =>
                          e.id === updated.id ? updated : e,
                        ),
                      }
                    : old,
                );
              }}
            />
          )}
          {modal.type === 'wave-form' && selectedExperiment && (
            <WaveForm
              data={data}
              experiment={selectedExperiment}
              onSaved={() => {
                saved(
                  'Measurement wave registered. Set up and monitor delivery in your ad console.',
                );
                navigate('waves');
              }}
            />
          )}
          {modal.type === 'wave-detail' && selectedWave && (
            <WaveDetail
              wave={selectedWave}
              recorded={data.learnings.find((l) => l.id === selectedWave.latestLearningId)}
              onSaved={saved}
            />
          )}
          {modal.type === 'connection' && <ConnectionDetail id={modal.id} />}
        </Modal>
      )}
    </div>
  );
}

function InfoIcon() {
  return <ShieldCheck size={18} />;
}

function Blueprint({ onConnection }: { onConnection: (id: string) => void }) {
  return (
    <div className="blueprint">
      <div className="blueprint-hero">
        <span className="eyebrow">THE CENTRAL IDEA</span>
        <h2>
          Maximize contribution.
          <br />
          <span>Make every experiment count.</span>
        </h2>
        <p>
          Generate broadly. Screen selectively. Confirm carefully. Allocate within each client’s
          economic and cash limits, and learn from what happens next.
        </p>
        <div className="blueprint-pills">
          <span>
            <ShoppingBag size={15} />
            Product commerce
          </span>
          <span>
            <BookOpen size={15} />
            Book advertising
          </span>
          <span>
            <Network size={15} />
            One decision framework
          </span>
        </div>
      </div>
      <div className="brain-flow">
        {[
          {
            icon: <Download size={21} />,
            title: 'Observe',
            text: 'Reports, orders, returns, and stock',
          },
          {
            icon: <CircleDollarSign size={21} />,
            title: 'Reconcile',
            text: 'True receipts, costs, and contribution',
          },
          {
            icon: <FlaskConical size={21} />,
            title: 'Experiment',
            text: 'One hypothesis, bounded test waves',
          },
          {
            icon: <ShieldCheck size={21} />,
            title: 'Decide',
            text: 'Mature evidence and explicit limits',
          },
          {
            icon: <TrendingUp size={21} />,
            title: 'Learn',
            text: 'Measured outcomes and reusable lessons',
          },
        ].map((step, i) => (
          <div key={step.title}>
            <span className="flow-icon">{step.icon}</span>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
            {i < 4 && <ArrowRight className="flow-arrow" size={18} />}
          </div>
        ))}
      </div>
      <div className="blueprint-columns">
        <section className="panel">
          <div className="panel-heading">
            <h2>Product growth engine</h2>
            <ShoppingBag size={20} />
          </div>
          <div className="blueprint-section">
            <p>
              Carry forward Enthusiast’s versioned creatives, release gates, source reporting
              contracts, and learning records.
            </p>
            <ul>
              <li>Test hook → format → audience → offer → landing page.</li>
              <li>Keep a control and record every setting that changed.</li>
              <li>Join Shopify paid orders, refunds, fulfillment, and stock.</li>
              <li>Judge screening candidates on contribution, then confirm lift.</li>
            </ul>
            <button className="text-button" onClick={() => onConnection('meta')}>
              Prepare Meta integration
              <ArrowUpRight size={14} />
            </button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Book discovery engine</h2>
            <BookOpen size={20} />
          </div>
          <div className="blueprint-section">
            <p>
              Pair Amazon Ads targeting with PBS book identity, availability, and publisher-specific
              economics.
            </p>
            <ul>
              <li>Discover with automatic, keyword, and product targeting.</li>
              <li>Harvest relevant search terms into controlled exact tests.</li>
              <li>Review waste before negative targeting; preserve discovery.</li>
              <li>Optimize royalties or net publisher contribution by format.</li>
            </ul>
            <button className="text-button" onClick={() => onConnection('amazon')}>
              Prepare Amazon Ads access
              <ArrowUpRight size={14} />
            </button>
          </div>
        </section>
      </div>
      <div className="section-heading">
        <h2>The path to controlled autonomy</h2>
        <a
          className="text-button"
          href="https://github.com/sdhjflas/multi-ads-manager/blob/main/docs/ARCHITECTURE.md"
          target="_blank"
          rel="noreferrer"
        >
          Full architecture
          <ExternalLink size={14} />
        </a>
      </div>
      <div className="roadmap">
        {[
          [
            '01',
            'The working foundation',
            'Built in this release',
            'Two portfolios, validated imports, hypothesis libraries, measured test waves, local planning reservations, evidence-linked learning, and an optional AI idea provider.',
          ],
          [
            '02',
            'Connected observation',
            'Next milestone',
            'Approved Ads API access, client authorization, scoped accounts, backfills, reporting health, and PBS / Shopify reconciliation.',
          ],
          [
            '03',
            'Controlled execution',
            'After reconciliation',
            'Preview exact bid and budget changes. Revalidate before writing, use idempotency and per-client caps, and confirm platform results.',
          ],
          [
            '04',
            'Learning at scale',
            'After pilot validation',
            'Calibrated allocation models, drift detection, marginal profit curves, causal confirmation, and bounded automation with a complete audit trail.',
          ],
        ].map(([n, title, status, detail]) => (
          <section className="roadmap-step" key={n}>
            <span className="roadmap-number">{n}</span>
            <div>
              <span className="eyebrow">{status}</span>
              <h3>{title}</h3>
              <p>{detail}</p>
            </div>
            {n === '01' ? <Check size={20} /> : <ChevronRight size={18} />}
          </section>
        ))}
      </div>
      <div className="research-card">
        <Compass size={25} />
        <div>
          <h3>Grounded in your projects. Checked against the platforms.</h3>
          <p>
            The research covers what to reuse, what to avoid, the integration boundaries, and the
            evidence required to scale.
          </p>
        </div>
        <a
          className="button secondary"
          href="https://github.com/sdhjflas/multi-ads-manager/blob/main/docs/RESEARCH.md"
          target="_blank"
          rel="noreferrer"
        >
          Read the research
          <ArrowUpRight size={15} />
        </a>
      </div>
    </div>
  );
}
