import { useEffect, useState } from 'react';
import {
  ArrowRight,
  FileUp,
  FlaskConical,
  Focus,
  Info,
  Search,
  Target as TargetIcon,
} from 'lucide-react';
import type { Dashboard, TargetView } from '../shared/types';
import { Badge, ChannelMark, Empty } from './components';
import { date, money, number, percent } from './lib';

const labels: Record<TargetView['signal']['kind'], string> = {
  harvest: 'Exact-test candidate',
  confirm: 'Confirm candidate',
  'review-waste': 'Review waste',
  hold: 'Gathering data',
  repair: 'Reconcile reports',
};
const badgeKind = (kind: TargetView['signal']['kind']) =>
  kind === 'harvest' || kind === 'confirm'
    ? ('scale' as const)
    : kind === 'review-waste'
      ? ('reduce' as const)
      : kind === 'repair'
        ? ('repair' as const)
        : ('hold' as const);

export function TargetExplorer({
  data,
  query,
  onImport,
  onOpen,
}: {
  data: Dashboard;
  query: string;
  onImport: () => void;
  onOpen: (target: TargetView) => void;
}) {
  const [kind, setKind] = useState('all'),
    [signal, setSignal] = useState('all'),
    [page, setPage] = useState(0);
  useEffect(() => setPage(0), [query, kind, signal, data.dataset]);
  const matching = data.targets.filter(
    (t) =>
      `${t.label} ${t.campaignName} ${t.sourceId}`.toLowerCase().includes(query.toLowerCase()) &&
      (kind === 'all' || t.kind === kind) &&
      (signal === 'all' || t.signal.kind === signal),
  );
  const ready = data.targets.filter((t) => ['harvest', 'confirm'].includes(t.signal.kind)).length;
  const waste = data.targets
    .filter((t) => t.signal.kind === 'review-waste')
    .reduce((s, t) => s + t.metrics.spendCents, 0);
  return (
    <>
      <div className="target-summary">
        <div>
          <TargetIcon size={20} />
          <span>
            <strong>{data.targets.length}</strong> measured cells
          </span>
        </div>
        <div>
          <FlaskConical size={20} />
          <span>
            <strong>{ready}</strong> confirmation candidates
          </span>
        </div>
        <div>
          <Focus size={20} />
          <span>
            <strong>{money(waste)}</strong> spend to review
          </span>
        </div>
        <button className="button primary" onClick={onImport}>
          <FileUp size={15} />
          Import target data
        </button>
      </div>
      <section className="panel target-panel">
        <div className="panel-heading">
          <div>
            <h2>The signals inside each campaign</h2>
            <p>Keywords, product targets, and individual creative cells · last {data.days} days</p>
          </div>
          <div className="target-filters">
            <select
              aria-label="Filter target kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="all">All cell types</option>
              <option value="keyword">Keywords</option>
              <option value="product-target">Product targets</option>
              <option value="creative">Creatives</option>
            </select>
            <select
              aria-label="Filter target signal"
              value={signal}
              onChange={(e) => setSignal(e.target.value)}
            >
              <option value="all">All signals</option>
              {Object.entries(labels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="table-scroll">
          <table className="target-table">
            <thead>
              <tr>
                <th>Target / creative</th>
                <th>Match</th>
                <th>Spend</th>
                <th>Purchases</th>
                <th>Est. contribution</th>
                <th>Next move</th>
                <th>
                  <span className="sr-only">Inspect target</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {matching.slice(page * 25, page * 25 + 25).map((t) => (
                <tr key={t.id}>
                  <td>
                    <button className="campaign-link" onClick={() => onOpen(t)}>
                      <ChannelMark channel={t.channel} />
                      <span>
                        <strong>{t.label}</strong>
                        <small>{t.campaignName}</small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className="match-type">{t.matchType}</span>
                  </td>
                  <td className="numeric">{money(t.metrics.spendCents, 2)}</td>
                  <td className="numeric">{number(t.metrics.orders)}</td>
                  <td
                    className={`numeric ${(t.metrics.contributionCents ?? 0) >= 0 ? 'positive' : 'negative'}`}
                  >
                    {money(t.metrics.contributionCents, 2)}
                  </td>
                  <td>
                    <Badge kind={badgeKind(t.signal.kind)}>{labels[t.signal.kind]}</Badge>
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Inspect ${t.label} in ${t.campaignName}`}
                      onClick={() => onOpen(t)}
                    >
                      <ArrowRight size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!matching.length && (
          <Empty
            icon={<Search size={27} />}
            title={
              data.targets.length ? 'No matching targets' : 'Find the signal beneath the campaign'
            }
          >
            {data.targets.length
              ? 'Try another search or filter.'
              : 'Import measured keyword or creative-cell performance alongside its parent campaign report. A drafted candidate is not yet a measured target.'}
          </Empty>
        )}
        <div className="pagination target-pagination">
          <span>
            {matching.length ? page * 25 + 1 : 0}–{Math.min((page + 1) * 25, matching.length)} of{' '}
            {matching.length} cells
          </span>
          <div>
            <button
              className="button secondary small-button"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <button
              className="button secondary small-button"
              disabled={(page + 1) * 25 >= matching.length}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </section>
      <div className="inline-note page-note">
        <Info size={18} />
        <p>
          Target metrics are breakdowns of campaign activity; they are never added to portfolio
          totals. A promising broad keyword is a discovery clue. Inspect its actual search terms
          before an exact or negative targeting decision.
        </p>
      </div>
    </>
  );
}

export function TargetDetail({ target, onTest }: { target: TargetView; onTest: () => void }) {
  return (
    <div className="detail-stack">
      <div className="detail-identity">
        <ChannelMark channel={target.channel} />
        <div>
          <strong>{target.label}</strong>
          <span>
            {target.campaignName} · {target.matchType}
          </span>
        </div>
        <Badge kind={badgeKind(target.signal.kind)}>{labels[target.signal.kind]}</Badge>
      </div>
      <div className="detail-metrics">
        <div>
          <span>Observed retail ROAS</span>
          <strong>{target.metrics.roas?.toFixed(2) ?? '—'}×</strong>
        </div>
        <div>
          <span>Cost per purchase</span>
          <strong>{money(target.metrics.cpaCents, 2)}</strong>
        </div>
        <div>
          <span>Modeled contribution</span>
          <strong>{money(target.metrics.contributionCents)}</strong>
        </div>
      </div>
      <div className="recommendation-detail">
        <span className="eyebrow">TARGET-LEVEL EVIDENCE</span>
        <h3>{target.signal.title}</h3>
        <p>{target.signal.reason}</p>
      </div>
      <div className="detail-metrics">
        <div>
          <span>Mature clicks</span>
          <strong>{number(target.signal.matureClicks)}</strong>
        </div>
        <div>
          <span>Mature purchases</span>
          <strong>{number(target.signal.matureOrders)}</strong>
        </div>
        <div>
          <span>Model probability</span>
          <strong>{percent(target.signal.probabilityProfitable)}</strong>
        </div>
      </div>
      <p className="form-help">
        Mature through {date(target.signal.matureThrough)}. Probability is conditional on the same
        static economics and Beta(1,19) conversion model as the parent campaign. Allocation
        differences and selection bias mean this is not a randomized winner. Modeled affordable CPC:{' '}
        {money(target.signal.maxAffordableCpcCents, 2)}.
      </p>
      <div className="form-footer">
        <span>Source ID: {target.sourceId}</span>
        <button
          className="button primary"
          disabled={target.kind === 'product-target'}
          onClick={onTest}
        >
          <FlaskConical size={15} />
          Use as a test seed
        </button>
      </div>
      {target.kind === 'product-target' && (
        <p className="form-help">
          Product-target generation is not implemented. Export and verify ASIN targets in the
          platform console.
        </p>
      )}
    </div>
  );
}
