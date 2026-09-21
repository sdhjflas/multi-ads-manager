import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronRight, Info, X } from 'lucide-react';
import type { CampaignView, Channel, Dashboard, DecisionKind } from '../shared/types';
import { channelName, date, decisionLabel, money, number } from './lib';

export function OrbitLogo({ small = false }: { small?: boolean }) {
  return (
    <span className={`orbit-logo ${small ? 'small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <ellipse
          cx="20"
          cy="20"
          rx="15"
          ry="7"
          transform="rotate(-42 20 20)"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <circle cx="20" cy="20" r="5.5" fill="currentColor" />
      </svg>
    </span>
  );
}

export function ChannelMark({ channel }: { channel: Channel }) {
  return (
    <span
      className={`channel-mark ${channel}`}
      title={channelName[channel]}
      aria-label={channelName[channel]}
    >
      {channel === 'meta' ? '∞' : channel === 'amazon' ? 'a' : '♪'}
    </span>
  );
}

export function Badge({
  kind,
  children,
}: {
  kind: DecisionKind | 'neutral' | 'purple';
  children?: ReactNode;
}) {
  return (
    <span className={`badge ${kind}`}>
      <i />
      {children || (kind in decisionLabel ? decisionLabel[kind as DecisionKind] : kind)}
    </span>
  );
}

export function MetricCard({
  title,
  value,
  prior,
  current,
  icon,
  caption,
  accent = false,
}: {
  title: string;
  value: string;
  prior?: number | null;
  current?: number | null;
  icon: ReactNode;
  caption: string;
  accent?: boolean;
}) {
  const change =
    typeof prior === 'number' && prior !== 0 && typeof current === 'number'
      ? (current - prior) / Math.abs(prior)
      : null;
  return (
    <div className={`metric-card ${accent ? 'accent' : ''}`}>
      <div className="metric-label">
        {title}
        <span className="metric-icon">{icon}</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-bottom">
        {change !== null ? (
          <span className={change >= 0 ? 'positive trend' : 'negative trend'}>
            {change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
            {Math.abs(change * 100).toFixed(1)}%
          </span>
        ) : (
          <span className="subtle">—</span>
        )}
        <span>{caption}</span>
      </div>
    </div>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="subtle">—</span>;
  const min = Math.min(...values),
    range = Math.max(1, Math.max(...values) - min);
  return (
    <svg className="sparkline" viewBox="0 0 90 27" aria-hidden="true">
      <path
        d={values
          .map(
            (v, i) =>
              `${i ? 'L' : 'M'}${(i / (values.length - 1)) * 88 + 1},${25 - ((v - min) / range) * 22}`,
          )
          .join(' ')}
        fill="none"
        stroke={values[values.length - 1] >= 0 ? '#39a88a' : '#d5a66a'}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function smooth(points: [number, number][]) {
  return points
    .map((p, i) => {
      if (!i) return `M ${p[0]} ${p[1]}`;
      const p0 = points[Math.max(0, i - 2)],
        p1 = points[i - 1],
        p2 = p,
        p3 = points[Math.min(points.length - 1, i + 1)];
      return `C ${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6}, ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6}, ${p2[0]} ${p2[1]}`;
    })
    .join(' ');
}

export function PerformanceChart({ data }: { data: Dashboard }) {
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setHover(null), [data.days, data.dataset]);
  const selected = hover === null ? null : data.series[hover];
  const values = data.series.flatMap((d) => [d.spendCents, d.contributionCents ?? 0]);
  const max = Math.max(10000, ...values) * 1.18;
  const min = Math.min(0, ...values) * 1.18;
  const y = (v: number) => 182 - ((v - min) / (max - min)) * 162;
  const x = (i: number) => 56 + (i / Math.max(1, data.series.length - 1)) * 628;
  const profitPoints = data.series.map(
    (d, i) => [x(i), y(d.contributionCents ?? 0)] as [number, number],
  );
  const spendPoints = data.series.map((d, i) => [x(i), y(d.spendCents)] as [number, number]);
  const contributionKnown = data.summary.contributionCents !== null;
  return (
    <section className="panel performance-panel">
      <div className="panel-heading">
        <div>
          <h2>Performance over time</h2>
          <p>The relationship that matters: contribution and cost.</p>
        </div>
        <span className="small-tag">Daily · USD</span>
      </div>
      <div className="chart-legend">
        <span>
          <i className="dot green" />
          Modeled contribution
        </span>
        <span>
          <i className="dot purple" />
          Ad spend
        </span>
      </div>
      <div className="chart-wrap">
        {selected && (
          <div className="chart-tooltip">
            <strong>{date(selected.date)}</strong>
            <span>
              Contribution <b>{money(selected.contributionCents, 2)}</b>
            </span>
            <span>
              Ad spend <b>{money(selected.spendCents, 2)}</b>
            </span>
          </div>
        )}
        <svg
          viewBox="0 0 706 224"
          role="img"
          aria-label={`Daily ad spend and modeled contribution for the last ${data.days} days. Use arrow keys to inspect each day.`}
          tabIndex={0}
          onMouseLeave={() => setHover(null)}
          onFocus={() => setHover(0)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
              e.preventDefault();
              setHover(
                Math.max(
                  0,
                  Math.min(
                    data.series.length - 1,
                    (hover ?? 0) + (e.key === 'ArrowRight' ? 1 : -1),
                  ),
                ),
              );
            }
          }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setHover(
              Math.max(
                0,
                Math.min(
                  data.series.length - 1,
                  Math.round(
                    ((((e.clientX - rect.left) / rect.width) * 706 - 56) / 628) *
                      (data.series.length - 1),
                  ),
                ),
              ),
            );
          }}
        >
          <defs>
            <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#55bfa5" stopOpacity=".14" />
              <stop offset="100%" stopColor="#55bfa5" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((i) => {
            const value = min + ((max - min) * i) / 4;
            return (
              <g key={i}>
                <line
                  x1="56"
                  x2="686"
                  y1={y(value)}
                  y2={y(value)}
                  stroke="#ececf1"
                  strokeDasharray="3 4"
                />
                <text x="43" y={y(value) + 4} textAnchor="end" className="axis-label">
                  {money(value)}
                </text>
              </g>
            );
          })}
          {contributionKnown && (
            <>
              <path
                d={`${smooth(profitPoints)} L 684 ${y(0)} L 56 ${y(0)} Z`}
                fill="url(#profitFill)"
              />
              <path
                d={smooth(profitPoints)}
                fill="none"
                stroke="#45b394"
                strokeWidth="2.6"
                strokeLinecap="round"
              />
            </>
          )}
          <path
            d={smooth(spendPoints)}
            fill="none"
            stroke="#8876e5"
            strokeWidth="2.3"
            strokeLinecap="round"
          />
          {data.series
            .filter(
              (_, i) =>
                i === 0 ||
                i === data.series.length - 1 ||
                i % Math.ceil(data.series.length / 6) === 0,
            )
            .map((d) => (
              <text
                key={d.date}
                x={x(data.series.indexOf(d))}
                y="211"
                textAnchor="middle"
                className="axis-label"
              >
                {date(d.date)}
              </text>
            ))}
          {hover !== null && data.series[hover] && (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1="15"
                y2="182"
                stroke="#c7c1de"
                strokeDasharray="3 3"
              />
              <circle
                cx={x(hover)}
                cy={y(data.series[hover].spendCents)}
                r="4"
                fill="#8876e5"
                stroke="white"
                strokeWidth="2"
              />
              {contributionKnown && (
                <circle
                  cx={x(hover)}
                  cy={y(data.series[hover].contributionCents ?? 0)}
                  r="4"
                  fill="#45b394"
                  stroke="white"
                  strokeWidth="2"
                />
              )}
            </g>
          )}
        </svg>
        {selected && (
          <span className="sr-only" aria-live="polite">
            {date(selected.date)}: contribution {money(selected.contributionCents)}, spend{' '}
            {money(selected.spendCents)}
          </span>
        )}
      </div>
      <div className="chart-footnote">
        <Info size={12} />
        {data.campaigns.length
          ? 'Recent conversions are still arriving. Decisions use mature cohorts.'
          : 'Create a campaign and import a report to see your performance.'}
      </div>
    </section>
  );
}

export function AllocationChart({ campaigns }: { campaigns: CampaignView[] }) {
  const channels: Channel[] = ['meta', 'amazon', 'tiktok'];
  const colors = ['#7560de', '#b2a1ef', '#ddd5f7'];
  const totals = channels.map((channel) =>
    campaigns.filter((c) => c.channel === channel).reduce((s, c) => s + c.metrics.spendCents, 0),
  );
  const total = totals.reduce((a, b) => a + b, 0);
  let offset = 0;
  return (
    <section className="panel allocation-panel">
      <div className="panel-heading">
        <div>
          <h2>Where your budget goes</h2>
          <p>Spend by channel</p>
        </div>
      </div>
      <div className="donut-wrap">
        <svg
          viewBox="0 0 180 180"
          aria-label={`Spend by channel: ${channels.map((c, i) => `${channelName[c]} ${money(totals[i])}`).join(', ')}`}
          role="img"
        >
          <circle cx="90" cy="90" r="67" fill="none" stroke="#f0edf8" strokeWidth="20" />
          {channels.map((channel, i) => {
            const length = total ? (totals[i] / total) * 421 : 0;
            const old = offset;
            offset += length;
            return (
              <circle
                key={channel}
                cx="90"
                cy="90"
                r="67"
                fill="none"
                stroke={colors[i]}
                strokeWidth="20"
                strokeDasharray={`${Math.max(0, length - 3)} 421`}
                strokeDashoffset={-old}
                transform="rotate(-90 90 90)"
              />
            );
          })}
        </svg>
        <div className="donut-center">
          <span>Total spend</span>
          <strong>{money(total)}</strong>
          <small>
            {campaigns.filter((c) => c.metrics.spendCents > 0).length} reporting campaigns
          </small>
        </div>
      </div>
      <div className="allocation-legend">
        {channels.map((channel, i) => (
          <div key={channel}>
            <span>
              <i className="dot" style={{ background: colors[i] }} />
              {channelName[channel]}
            </span>
            <b>{money(totals[i])}</b>
            <small>{total ? Math.round((totals[i] / total) * 100) : 0}%</small>
          </div>
        ))}
      </div>
    </section>
  );
}

export function CampaignTable({
  campaigns,
  onOpen,
  compact = false,
}: {
  campaigns: CampaignView[];
  onOpen: (c: CampaignView) => void;
  compact?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className="campaign-table">
        <thead>
          <tr>
            <th>Campaign</th>
            <th>Status</th>
            <th>Ad spend</th>
            <th>Retail ROAS</th>
            <th>Est. contribution</th>
            {!compact && <th>Trend</th>}
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id}>
              <td>
                <button className="campaign-link" onClick={() => onOpen(c)}>
                  <ChannelMark channel={c.channel} />
                  <span>
                    <strong>{c.name}</strong>
                    <small>
                      {c.entityName} <span>·</span> {c.vertical === 'books' ? 'Books' : 'Products'}
                    </small>
                  </span>
                </button>
              </td>
              <td>
                <Badge kind={c.status === 'paused' ? 'neutral' : c.decision.kind}>
                  {c.status === 'paused' ? 'Paused locally' : undefined}
                </Badge>
              </td>
              <td className="numeric">{money(c.metrics.spendCents, 2)}</td>
              <td className="numeric">
                {c.metrics.roas?.toFixed(2) ?? '—'}
                {c.metrics.roas !== null && <small>×</small>}
              </td>
              <td
                className={`numeric ${(c.metrics.contributionCents ?? 0) > 0 ? 'positive' : (c.metrics.contributionCents ?? 0) < 0 ? 'negative' : ''}`}
              >
                {money(c.metrics.contributionCents, 2)}
              </td>
              {!compact && (
                <td>
                  <Sparkline values={c.sparkline} />
                </td>
              )}
              <td>
                <button
                  className="icon-button"
                  onClick={() => onOpen(c)}
                  aria-label={`View ${c.name}`}
                >
                  <ChevronRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!campaigns.length && (
        <div className="empty-inline">
          No campaigns match. Create a campaign workspace or adjust your search.
        </div>
      )}
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className={`modal ${wide ? 'wide' : ''}`}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-inner">
        <div className="modal-heading">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Count({ value }: { value: number }) {
  return <span className="count">{number(value)}</span>;
}
