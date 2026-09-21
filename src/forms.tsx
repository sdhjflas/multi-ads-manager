import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileUp,
  FlaskConical,
  Info,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type {
  CampaignView,
  Dashboard,
  Dataset,
  Experiment,
  Vertical,
  TargetView,
  LearningView,
} from '../shared/types';
import { Badge, ChannelMark, Empty } from './components';
import { api, channelName, date, dollarInput, money, number, percent } from './lib';

function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <div className="form-error" role="alert">
      {error}
    </div>
  ) : null;
}
function Submit({ busy, children }: { busy: boolean; children: string }) {
  return (
    <button className="button primary" type="submit" disabled={busy}>
      {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}{' '}
      {busy ? 'Working…' : children}
    </button>
  );
}

export function CampaignForm({
  dataset,
  initialVertical,
  onSaved,
  existing,
}: {
  dataset: Dataset;
  initialVertical: Vertical;
  onSaved: () => void;
  existing?: CampaignView;
}) {
  const [vertical, setVertical] = useState<Vertical>(existing?.vertical || initialVertical);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const books = vertical === 'books';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(event.currentTarget);
    try {
      const body = {
        dataset,
        name: f.get('name'),
        vertical,
        channel: books ? 'amazon' : f.get('channel'),
        entityName: f.get('entityName'),
        accountName: f.get('accountName'),
        retailPriceCents: dollarInput(f.get('retailPrice')),
        netReceiptCents: dollarInput(f.get('netReceipt')),
        variableCostCents: dollarInput(f.get('variableCost')),
        targetProfitCents: dollarInput(f.get('targetProfit')),
        dailyBudgetCents: dollarInput(f.get('dailyBudget')),
        totalLearningBudgetCents: dollarInput(f.get('totalBudget')),
        attributionDays: Number(f.get('attributionDays')),
        economicsVerified: f.get('economicsVerified') === 'on',
        trackingVerified: f.get('trackingVerified') === 'on',
        supplyReady: f.get('supplyReady') === 'on',
      };
      await api(
        existing ? `/campaigns/${existing.id}/setup` : '/campaigns',
        body,
        existing ? 'PATCH' : 'POST',
      );
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="form-stack">
      <div className="segmented wide-segment" aria-label="Campaign type">
        <button
          type="button"
          className={!books ? 'selected' : ''}
          onClick={() => setVertical('commerce')}
        >
          Product advertising
        </button>
        <button
          type="button"
          className={books ? 'selected' : ''}
          onClick={() => setVertical('books')}
        >
          Amazon books
        </button>
      </div>
      <div className="form-grid">
        <label className="span-2">
          Campaign name
          <input
            name="name"
            defaultValue={existing?.name}
            required
            maxLength={160}
            placeholder={
              books
                ? 'Exact name from your Amazon report'
                : 'e.g. Sequential indicators · first test'
            }
          />
        </label>
        <label>
          {books ? 'Book title / format' : 'Product'}
          <input
            name="entityName"
            defaultValue={existing?.entityName}
            required
            maxLength={160}
            placeholder={books ? 'Title · paperback' : 'Product name'}
          />
        </label>
        <label>
          Client / account
          <input
            name="accountName"
            defaultValue={existing?.accountName}
            required
            maxLength={160}
            placeholder="Internal account label"
          />
        </label>
        <label>
          Advertising channel
          <select
            name="channel"
            key={vertical}
            defaultValue={existing?.channel || (books ? 'amazon' : 'meta')}
          >
            {books ? (
              <option value="amazon">Amazon Sponsored Products</option>
            ) : (
              <>
                <option value="meta">Meta Ads</option>
                <option value="tiktok">TikTok Ads</option>
              </>
            )}
          </select>
        </label>
        <label>
          Click attribution window
          <select
            name="attributionDays"
            key={`${vertical}-attribution`}
            defaultValue={existing?.attributionDays || (books ? 14 : 7)}
          >
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="1">1 day</option>
          </select>
        </label>
      </div>
      <div className="form-section-heading">
        <h3>Know the economics first</h3>
        <span>USD · per purchase event</span>
      </div>
      <p className="form-help">
        {books
          ? 'Use the publisher’s net receipts or author royalty after distribution deductions. Retail sales and Amazon’s shipped COGS are not publisher earnings.'
          : 'Use net receipts after discounts and payment deductions. Include fulfillment, product costs, and expected return costs below.'}{' '}
        These assumptions apply to the full imported period.
      </p>
      <div className="form-grid">
        {[
          ['retailPrice', books ? 'Retail book price' : 'Retail price', existing?.retailPriceCents],
          [
            'netReceipt',
            books ? 'Publisher net receipts' : 'Net receipts',
            existing?.netReceiptCents,
          ],
          [
            'variableCost',
            books ? 'Print + other variable costs' : 'Product + fulfillment costs',
            existing?.variableCostCents,
          ],
          ['targetProfit', 'Profit reserve per purchase', existing?.targetProfitCents],
          ['dailyBudget', 'Daily planning budget', existing?.dailyBudgetCents],
          ['totalBudget', 'Total learning allowance', existing?.totalLearningBudgetCents],
        ].map(([name, title, value]) => (
          <label key={String(name)}>
            {title}
            <span className="currency-input">
              <span>$</span>
              <input
                name={String(name)}
                type="number"
                min={name === 'retailPrice' ? '0.01' : '0'}
                step="0.01"
                max="1000000"
                required
                defaultValue={typeof value === 'number' ? (value / 100).toFixed(2) : undefined}
                placeholder="0.00"
              />
            </span>
          </label>
        ))}
      </div>
      <div className="checklist">
        <label>
          <input
            type="checkbox"
            name="economicsVerified"
            defaultChecked={existing?.economicsVerified}
          />
          <span>I have verified these economics for the reporting period.</span>
        </label>
        <label>
          <input
            type="checkbox"
            name="trackingVerified"
            defaultChecked={existing?.trackingVerified}
          />
          <span>
            Reports use daily click attribution in USD / UTC, with purchase events rather than
            units.
          </span>
        </label>
        <label>
          <input type="checkbox" name="supplyReady" defaultChecked={existing?.supplyReady} />
          <span>
            {books
              ? 'This title is available and eligible for advertising.'
              : 'Inventory, fulfillment, claims, and product evidence are ready.'}
          </span>
        </label>
      </div>
      <ErrorMessage error={error} />
      <div className="form-footer">
        <span>
          <ShieldCheck size={14} />
          Planning only. No platform changes.
        </span>
        <Submit busy={busy}>{existing ? 'Save setup' : 'Create workspace'}</Submit>
      </div>
    </form>
  );
}

export function ExperimentForm({
  data,
  onSaved,
  onCreateCampaign,
  seedTarget,
  sourceLearning,
}: {
  data: Dashboard;
  onSaved: () => void;
  onCreateCampaign: () => void;
  seedTarget?: TargetView;
  sourceLearning?: LearningView;
}) {
  const [campaignId, setCampaignId] = useState(
    sourceLearning?.campaignId || seedTarget?.campaignId || data.campaigns[0]?.id || '',
  );
  const [variable, setVariable] = useState(
    sourceLearning
      ? sourceLearning.promisingCandidate?.variable ||
          data.experiments.find((e) => e.id === sourceLearning.experimentId)?.variable ||
          (sourceLearning.vertical === 'books' ? 'keyword' : 'hook')
      : seedTarget
        ? seedTarget.kind === 'creative'
          ? 'hook'
          : 'keyword'
        : data.campaigns[0]?.vertical === 'books'
          ? 'keyword'
          : 'hook',
  );
  const [provider, setProvider] = useState('structured-planner');
  const [count, setCount] = useState(36),
    [concurrent, setConcurrent] = useState(3);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const campaign = data.campaigns.find((c) => c.id === campaignId);
  if (!campaign)
    return (
      <Empty
        icon={<FlaskConical size={26} />}
        title="Every experiment starts with an item"
        action={
          <button className="button primary" onClick={onCreateCampaign}>
            <Plus size={16} />
            Create a campaign
          </button>
        }
      >
        Add your product or book, its economics, and a learning allowance first.
      </Empty>
    );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(event.currentTarget);
    try {
      await api('/experiments', {
        dataset: data.dataset,
        campaignId,
        name: f.get('name'),
        hypothesis: f.get('hypothesis'),
        variable,
        seedTerms: String(f.get('seeds'))
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
        count,
        maxConcurrent: concurrent,
        budgetCents: dollarInput(f.get('budget')),
        provider,
        ...(seedTarget?.campaignId === campaignId ? { sourceTargetId: seedTarget.id } : {}),
        ...(sourceLearning?.campaignId === campaignId
          ? { sourceLearningId: sourceLearning.id }
          : {}),
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
      {sourceLearning?.campaignId === campaignId && (
        <div className="learning-source">
          <strong>Building on: {sourceLearning.waveName}</strong>
          {sourceLearning.result.title}. This new experiment keeps a link to the recorded evidence.
          {provider === 'openai' &&
            ' The saved finding and your notes will be included in the AI request.'}
        </div>
      )}
      <label>
        Campaign
        <select
          value={campaignId}
          onChange={(e) => {
            setCampaignId(e.target.value);
            setVariable(
              data.campaigns.find((c) => c.id === e.target.value)?.vertical === 'books'
                ? 'keyword'
                : 'hook',
            );
          }}
        >
          {data.campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Experiment name
        <input
          name="name"
          defaultValue={
            sourceLearning
              ? `${sourceLearning.waveName.slice(0, 100)} · follow-up`
              : seedTarget
                ? `${seedTarget.label.slice(0, 100)} · confirmation`
                : ''
          }
          placeholder="Give this test a memorable name"
          required
          maxLength={160}
        />
      </label>
      <label>
        Your hypothesis
        <textarea
          name="hypothesis"
          defaultValue={
            sourceLearning
              ? `Following the recorded result “${sourceLearning.result.title}”, test a focused change with a stable baseline and verify mature contribution. Prior question: ${sourceLearning.hypothesis}`.slice(
                  0,
                  1200,
                )
              : seedTarget
                ? `The observed candidate “${seedTarget.label}” may acquire purchases within our contribution ceiling. Compare it with a stable control and verify mature outcomes.`
                : ''
          }
          required
          minLength={10}
          maxLength={1200}
          rows={2}
          placeholder={
            campaign.vertical === 'books'
              ? 'Specific reader-intent keywords will acquire readers below our contribution ceiling.'
              : 'A detail-led opening will attract more qualified buyers than the current creative.'
          }
        />
      </label>
      <div className="form-grid">
        <label>
          One variable to explore
          <select value={variable} onChange={(e) => setVariable(e.target.value)}>
            {campaign.vertical === 'books' ? (
              <option value="keyword">Keyword + match type</option>
            ) : (
              <>
                <option value="hook">Opening hook</option>
                <option value="headline">Headline</option>
                <option value="audience">Audience hypothesis</option>
              </>
            )}
          </select>
        </label>
        <label>
          Idea source
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              if (e.target.value === 'openai') setCount(Math.min(count, 24));
            }}
          >
            <option value="structured-planner">Structured planner · no API cost</option>
            <option value="openai" disabled={!data.ai.configured}>
              OpenAI
              {data.ai.configured
                ? ` · ${data.ai.dailyLimit - data.ai.requestsToday} requests left today`
                : ' · configure in Connections'}
            </option>
          </select>
        </label>
      </div>
      <label>
        {campaign.vertical === 'books'
          ? 'Relevant topics / reader interests'
          : 'Product angles / themes'}
        <input
          name="seeds"
          defaultValue={
            sourceLearning?.promisingCandidate?.label.slice(0, 100) || seedTarget?.label || ''
          }
          required
          maxLength={2500}
          placeholder={
            campaign.vertical === 'books'
              ? 'nature writing, slow living, outdoor adventure'
              : 'product details, installation process, daily driving'
          }
        />
        <small>
          Comma-separated. Supply genuine attributes; candidates remain unverified drafts.
        </small>
      </label>
      <div className="form-grid three">
        <label>
          Up to
          <input
            type="number"
            min="2"
            max={provider === 'openai' ? '24' : '300'}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            required
          />
          <small>Distinct candidates</small>
        </label>
        <label>
          Wave size
          <input
            type="number"
            min="1"
            max={Math.min(10, count)}
            value={concurrent}
            onChange={(e) => setConcurrent(Number(e.target.value))}
            required
          />
          <small>Shortlisted at a time</small>
        </label>
        <label>
          Learning budget
          <span className="currency-input">
            <span>$</span>
            <input
              name="budget"
              type="number"
              min="0.01"
              step="0.01"
              max={campaign.totalLearningBudgetCents / 100}
              required
              placeholder="300.00"
            />
          </span>
          <small>Within {money(campaign.totalLearningBudgetCents)} allowance</small>
        </label>
      </div>
      <div className="inline-note">
        <Sparkles size={18} />
        <p>
          Build a library, then test in small waves. The planner returns only distinct combinations
          supported by your inputs. Hold the offer, landing page, and measurement settings fixed.
        </p>
      </div>
      <ErrorMessage error={error} />
      <div className="form-footer">
        <span>Creates a draft. No ads launched.</span>
        <Submit busy={busy}>
          {provider === 'openai' ? 'Generate AI draft' : 'Build experiment'}
        </Submit>
      </div>
    </form>
  );
}

export function ImportForm({
  data,
  onSaved,
  onCreateCampaign,
  targetMode = false,
}: {
  data: Dashboard;
  onSaved: () => void;
  onCreateCampaign: () => void;
  targetMode?: boolean;
}) {
  const [campaignId, setCampaignId] = useState(data.campaigns[0]?.id || '');
  const [format, setFormat] = useState(targetMode ? 'targets' : 'canonical'),
    [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const campaign = data.campaigns.find((c) => c.id === campaignId);
  if (!campaign)
    return (
      <Empty
        icon={<FileUp size={26} />}
        title="Create a campaign before importing"
        action={
          <button className="button primary" onClick={onCreateCampaign}>
            <Plus size={16} />
            Create campaign
          </button>
        }
      >
        Reports are mapped to one campaign and one reporting definition.
      </Empty>
    );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(event.currentTarget);
    try {
      await api(targetMode ? '/target-imports' : '/imports', {
        dataset: data.dataset,
        campaignId,
        format,
        csv,
        currency: 'USD',
        timezone: 'UTC',
        attributionDays: campaign!.attributionDays,
        exportedAt: new Date(String(f.get('exportedAt'))).toISOString(),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  return (
    <form onSubmit={submit} className="form-stack">
      <label>
        Campaign
        <select
          value={campaignId}
          onChange={(e) => {
            setCampaignId(e.target.value);
            setFormat(targetMode ? 'targets' : 'canonical');
          }}
        >
          {data.campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="form-grid">
        <label>
          Report format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {targetMode ? (
              <option value="targets">Normalized target / creative CSV</option>
            ) : (
              <>
                <option value="canonical">Orbit normalized CSV</option>
                {campaign.channel === 'amazon' && [7, 14].includes(campaign.attributionDays) && (
                  <option value="amazon">Amazon daily campaign CSV (English)</option>
                )}
              </>
            )}
          </select>
        </label>
        <label>
          Report exported at (your local time)
          <input name="exportedAt" type="datetime-local" defaultValue={localNow} required />
        </label>
      </div>
      <div className="inline-note">
        <Info size={18} />
        <p>
          {targetMode
            ? 'One row per target ID and completed UTC date. Keep target text and match type stable. Use kind=keyword or product-target for books, and creative for product ads. Import matching campaign totals first; target totals cannot exceed them. Include explicit zero days.'
            : format === 'amazon'
              ? `Use a daily, single-campaign Sponsored Products report with “${campaign.attributionDays} Day Total Orders (#)” and “${campaign.attributionDays} Day Total Sales”. Match the campaign name exactly. Refund adjustments are absent from this export; reconcile them separately.`
              : 'One row per completed UTC date. Amounts are integer cents; refunds_cents means reductions to your net receipts. Import purchase events, not units. Refreshed dates replace earlier rows.'}
        </p>
      </div>
      <label className="file-drop">
        <FileUp size={25} />
        <strong>Choose a CSV report</strong>
        <span>Aggregate data only · up to 1 MB</span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 1_000_000) return setError('File exceeds 1 MB.');
            setCsv(await file.text());
            setError('');
          }}
        />
      </label>
      <label>
        Or paste the CSV
        <textarea
          className="code-input"
          rows={5}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder="date,impressions,clicks,orders,spend_cents,sales_cents,refunds_cents"
          required
          maxLength={1000000}
        />
      </label>
      <label className="check-row">
        <input type="checkbox" required />
        <span>
          I verified USD, UTC daily cohorts, and a {campaign.attributionDays}-day click window. This
          contains no personal data.
        </span>
      </label>
      <ErrorMessage error={error} />
      <div className="form-footer">
        <a
          href={targetMode ? '/api/target-template' : '/api/import-template'}
          className="text-button"
        >
          <Download size={14} />
          Download template
        </a>
        <Submit busy={busy}>{targetMode ? 'Import target report' : 'Import report'}</Submit>
      </div>
    </form>
  );
}

export function CampaignDetail({
  campaign: c,
  onReview,
  onEdit,
  onStatus,
  busy,
}: {
  campaign: CampaignView;
  onReview: (action: 'accepted' | 'dismissed') => void;
  onEdit: () => void;
  onStatus: () => void;
  busy: boolean;
}) {
  return (
    <div className="detail-stack">
      <div className="detail-identity">
        <ChannelMark channel={c.channel} />
        <div>
          <strong>{c.entityName}</strong>
          <span>
            {c.accountName} · {channelName[c.channel]}
          </span>
        </div>
        <Badge kind={c.decision.kind} />
      </div>
      <div className="detail-metrics">
        <div>
          <span>Retail ROAS</span>
          <strong>{c.metrics.roas?.toFixed(2) ?? '—'}×</strong>
        </div>
        <div>
          <span>Break-even ROAS</span>
          <strong>{c.breakEvenRoas?.toFixed(2) ?? '—'}×</strong>
        </div>
        <div>
          <span>Break-even ACOS</span>
          <strong>{percent(c.breakEvenAcos)}</strong>
        </div>
      </div>
      <h3>The economics behind the recommendation</h3>
      <div className="economics-list">
        {[
          ['Retail price', c.retailPriceCents],
          [c.vertical === 'books' ? 'Publisher net receipts' : 'Net receipts', c.netReceiptCents],
          ['Variable costs', -c.variableCostCents],
          ['Contribution before advertising', c.unitContributionCents],
          ['Profit reserve per purchase', c.targetProfitCents],
          ['Modeled affordable CPC', c.decision.maxAffordableCpcCents],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <span>{label}</span>
            <strong>{money(value as number | null, 2)}</strong>
          </div>
        ))}
      </div>
      <div className="recommendation-detail">
        <span className="eyebrow">NEXT BEST MOVE</span>
        <h3>{c.decision.title}</h3>
        <p>{c.decision.reason}</p>
        {c.decision.suggestedDailyBudgetCents !== null && (
          <div className="budget-change">
            <span>{money(c.dailyBudgetCents)} / day</span>
            <ArrowRight size={18} />
            <strong>{money(c.decision.suggestedDailyBudgetCents)} / day</strong>
            <Badge kind="purple">Proposed</Badge>
          </div>
        )}
        {c.decision.blockers.length > 0 && (
          <ul>
            {c.decision.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="detail-metrics">
        <div>
          <span>Mature clicks</span>
          <strong>{number(c.decision.matureClicks)}</strong>
        </div>
        <div>
          <span>Mature purchases</span>
          <strong>{number(c.decision.matureOrders)}</strong>
        </div>
        <div>
          <span>Model probability*</span>
          <strong>{percent(c.decision.probabilityProfitable)}</strong>
        </div>
      </div>
      <p className="form-help">
        *Probability of covering acquisition cost and the profit reserve under a Beta(1,19)
        click-conversion model, using cohorts through {date(c.decision.matureThrough)}. It assumes
        stable click cost, one purchase per converting click, and stable margins. It is not causal
        proof or a guarantee. Contribution is estimated before fixed costs.
      </p>
      <div className="detail-actions">
        <button className="button secondary" onClick={onEdit}>
          Edit setup
        </button>
        <button className="button secondary" disabled={busy} onClick={onStatus}>
          {c.status === 'paused' ? 'Resume monitoring' : 'Pause monitoring'}
        </button>
        <button
          className="button primary"
          disabled={busy || c.decision.kind === 'repair' || c.decision.kind === 'hold'}
          onClick={() => onReview('accepted')}
        >
          <Check size={15} />
          Save proposal
        </button>
      </div>
      <p className="micro-note">
        All actions here affect local planning and monitoring. Change live campaigns in the platform
        console.
      </p>
    </div>
  );
}

export function ExperimentDetail({
  experiment,
  onUpdated,
  onRegister,
}: {
  experiment: Experiment;
  onUpdated: (e: Experiment) => void;
  onRegister: () => void;
}) {
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const matches = experiment.variants.filter((v) =>
    v.value.toLowerCase().includes(search.toLowerCase()),
  );
  const selected = experiment.variants.filter((v) => v.state === 'shortlisted').length;
  const inFlight = useRef(false);
  async function toggle(id: string, state: 'queued' | 'shortlisted') {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      onUpdated(
        await api<Experiment>(
          `/experiments/${experiment.id}/variants/${id}`,
          { dataset: experiment.dataset, state: state === 'queued' ? 'shortlisted' : 'queued' },
          'PATCH',
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function exportVariants() {
    const cell = (v: string) => `"${v.replace(/^[=+\-@\t\r]/, "'$&").replaceAll('"', '""')}"`;
    const csv = [
      ['id', 'variable', 'value', 'hypothesis', 'state'],
      ...experiment.variants.map((v) => [v.id, v.variable, v.value, v.hypothesis, v.state]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `orbit-experiment-${experiment.id.slice(0, 8)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="detail-stack">
      <div className="inline-note">
        <FlaskConical size={20} />
        <p>{experiment.hypothesis}</p>
      </div>
      <div className="detail-metrics">
        <div>
          <span>Candidate library</span>
          <strong>{experiment.variants.length}</strong>
        </div>
        <div>
          <span>Next wave</span>
          <strong>
            {selected}
            <small> / {experiment.maxConcurrent}</small>
          </strong>
        </div>
        <div>
          <span>Learning budget</span>
          <strong>{money(experiment.budgetCents)}</strong>
        </div>
      </div>
      <div className="candidate-toolbar">
        <div className="search-field">
          <Search size={15} />
          <input
            placeholder="Search candidates…"
            aria-label="Search candidates"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <button className="button secondary small-button" onClick={exportVariants}>
          <Download size={14} />
          Export
        </button>
      </div>
      <button className="button primary setup-download" onClick={onRegister} disabled={!selected}>
        <FlaskConical size={16} />
        Register measurement wave
      </button>
      <ErrorMessage error={error} />
      <div className="candidate-list">
        {matches.slice(page * 10, page * 10 + 10).map((v) => (
          <div className={`candidate ${v.state === 'shortlisted' ? 'shortlisted' : ''}`} key={v.id}>
            <span className="candidate-number">{v.id.replace('v-', '')}</span>
            <div>
              <strong>{v.value}</strong>
              <span>
                {experiment.variable === 'keyword'
                  ? 'Keyword hypothesis · verify relevance'
                  : `${experiment.variable} · draft for review`}
              </span>
            </div>
            <button
              className={`button small-button ${v.state === 'shortlisted' ? 'selected-button' : 'secondary'}`}
              disabled={busy || (selected >= experiment.maxConcurrent && v.state !== 'shortlisted')}
              onClick={() => toggle(v.id, v.state)}
            >
              {v.state === 'shortlisted' ? <Check size={14} /> : <Plus size={14} />}
              {v.state === 'shortlisted' ? 'Selected' : 'Shortlist'}
            </button>
          </div>
        ))}
      </div>
      {!matches.length && <div className="empty-inline">No candidates match your search.</div>}
      <div className="pagination">
        <span>
          {matches.length ? page * 10 + 1 : 0}–{Math.min(page * 10 + 10, matches.length)} of{' '}
          {matches.length}
        </span>
        <div>
          <button
            className="button secondary small-button"
            onClick={() => setPage((p) => p - 1)}
            disabled={page === 0}
          >
            Previous
          </button>
          <button
            className="button secondary small-button"
            onClick={() => setPage((p) => p + 1)}
            disabled={(page + 1) * 10 >= matches.length}
          >
            Next
          </button>
        </div>
      </div>
      <p className="form-help">
        {experiment.provider === 'openai'
          ? 'AI-generated hypotheses'
          : 'Template-generated hypotheses'}{' '}
        · candidate library. Register a measurement wave to link the shortlist to reporting IDs and
        a local planning reservation. Confirm a promising result in a controlled experiment before
        broader scaling.
      </p>
    </div>
  );
}

export const connections = [
  {
    id: 'amazon',
    name: 'Amazon Ads',
    letter: 'a',
    className: 'amazon',
    category: 'BOOK ADVERTISING',
    description: 'Keywords, product targets, bids, and Sponsored Products reporting.',
    status: 'API access required',
    steps: [
      'Apply for Amazon Ads API access as a third-party application managing client campaigns.',
      'Register the application and authorized redirect URLs. Obtain each client’s separate authorization.',
      'Discover the correct advertiser profile and marketplace; confirm book and ad-product eligibility.',
      'Validate reporting and reconciliation before adding any bid or budget writes.',
    ],
    link: 'https://advertising.amazon.com/about-api',
    linkText: 'Amazon Ads API application',
    note: 'Pathway currently uses the advertising console. Daily CSV reporting is available in this build; OAuth and API synchronization are planned.',
  },
  {
    id: 'meta',
    name: 'Meta Ads',
    letter: '∞',
    className: 'meta',
    category: 'PRODUCT ADVERTISING',
    description: 'Creative performance, ad sets, delivery, and conversion insights.',
    status: 'Not connected',
    steps: [
      'Create a Meta business application and verify access to the intended ad account.',
      'Request the appropriate Marketing API permissions and complete the required review.',
      'Pin attribution settings and map platform campaign, ad set, and creative identifiers.',
      'Start with Insights collection and reconcile with Shopify paid orders and refunds.',
    ],
    link: 'https://developers.facebook.com/docs/marketing-api/',
    linkText: 'Meta Marketing API documentation',
    note: 'Normalized aggregate report imports work now. Automated Insights synchronization and campaign writes are planned.',
  },
  {
    id: 'shopify',
    name: 'Shopify',
    letter: 's',
    className: 'shopify',
    category: 'COMMERCE & ECONOMICS',
    description: 'Paid orders, refunds, product costs, and fulfillment readiness.',
    status: 'Not connected',
    steps: [
      'Install a scoped custom app for the authorized store.',
      'Subscribe to paid-order, transaction, refund, and inventory events.',
      'Verify webhook signatures and deduplicate retries before storing events.',
      'Reconcile paid orders and refunds into a separate business ledger, preserving consent boundaries.',
    ],
    link: 'https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/enterprise-oms-integration',
    linkText: 'Shopify integration documentation',
    note: 'Enthusiast’s production commerce path is Shopify. Its release and evidence gates need to be preserved in the adapter.',
  },
  {
    id: 'pbs',
    name: 'PBS HQ',
    letter: 'P',
    className: 'pbs',
    category: 'PUBLISHER OPERATIONS',
    description: 'Book identity, stock, settled sales, and publisher economics.',
    status: 'Adapter planned',
    steps: [
      'Map publisher, book, ISBN/EAN, ASIN, format, and marketplace explicitly.',
      'Consume authorized PBS reporting through a scoped read-only adapter.',
      'Keep all-vendor demand, consignment sell-through, and advertising attribution separate.',
      'Use documented publisher net receipts and costs; reconcile estimated earnings to settlements.',
    ],
    link: 'https://github.com/sdhjflas/multi-ads-manager/blob/main/docs/RESEARCH.md',
    linkText: 'Read the integration findings',
    note: 'PBS HQ’s existing SP-API authorization does not grant Amazon Ads API access. No private PBS data is included in this build.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    letter: '✳',
    className: 'openai',
    category: 'CREATIVE INTELLIGENCE',
    description: 'Structured, reviewable experiment ideas from your brief.',
    status: 'Optional provider',
    steps: [
      'Set OPENAI_API_KEY and an available structured-output model in OPENAI_MODEL in the server .env file.',
      'Set AI_DAILY_REQUEST_LIMIT to your preferred request allowance and restart the server.',
      'Choose OpenAI in the experiment builder. Each request creates at most 24 candidates and allows 4,000 output tokens.',
      'Review every idea for relevance and accurate claims. Model output never authorizes platform actions.',
    ],
    link: 'https://developers.openai.com/api/docs/guides/structured-outputs',
    linkText: 'Structured Outputs documentation',
    note: 'Credentials remain on the server. Requests are explicitly initiated, sent with store:false, and are not automatically retried. The request allowance is not a dollar spending cap.',
  },
  {
    id: 'tiktok',
    name: 'TikTok Ads',
    letter: '♪',
    className: 'tiktok',
    category: 'PRODUCT ADVERTISING',
    description: 'Short-form creative, hooks, and audience experiments.',
    status: 'Adapter planned',
    steps: [
      'Obtain TikTok for Business application access and advertiser authorization.',
      'Map impressions, clicks, video diagnostics, and purchases with fixed definitions.',
      'Use exclusive split-test arms for confirmation, with a predeclared budget and decision window.',
      'Reconcile conversions before moving a screened creative into a larger allocation.',
    ],
    link: 'https://ads.tiktok.com/help/article/split-testing?lang=en',
    linkText: 'TikTok split testing',
    note: 'Normalized CSV reporting works now. API collection and platform experiment execution are planned.',
  },
];

export function ConnectionDetail({ id }: { id: string }) {
  const connection = connections.find((c) => c.id === id)!;
  return (
    <div className="detail-stack">
      <div className="inline-note">
        <Info size={20} />
        <p>{connection.note}</p>
      </div>
      <ol className="setup-steps">
        {connection.steps.map((step, i) => (
          <li key={step}>
            <span>{i + 1}</span>
            <p>{step}</p>
          </li>
        ))}
      </ol>
      {id === 'openai' && (
        <pre className="env-example">
          OPENAI_API_KEY=your-server-key{'\n'}OPENAI_MODEL=your-selected-model{'\n'}
          AI_DAILY_REQUEST_LIMIT=5
        </pre>
      )}
      <div className="form-footer">
        <span>
          <CheckCircle2 size={14} />
          No credentials needed for local planning
        </span>
        <a className="button primary" href={connection.link} target="_blank" rel="noreferrer">
          Documentation
          <ExternalLink size={14} />
        </a>
      </div>
    </div>
  );
}
