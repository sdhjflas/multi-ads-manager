import { useEffect, useState, type FormEvent } from 'react';
import {
  BookOpen,
  CircleDollarSign,
  Download,
  FileUp,
  Plus,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import type { Book, BookPortfolio, BookView } from '../shared/books';
import type { AdAccount, Dataset } from '../shared/types';
import { Badge, Empty, MetricCard, Modal } from './components';
import { api, date, money, number, percent, timeAgo } from './lib';
import './books.css';

const labels: Record<BookView['status'], string> = {
  unverified: 'Verify economics',
  'not-viable': 'No ad margin',
  unavailable: 'Check availability',
  'no-data': 'Awaiting reports',
  stale: 'Refresh reports',
  'loss-limit': 'Loss allowance used',
  'budget-limit': 'Over budget ceiling',
  positive: 'Positive estimate',
  learning: 'Learning',
};
type Dialog =
  | { kind: 'edit'; book?: BookView }
  | { kind: 'import' }
  | { kind: 'detail'; book: BookView }
  | null;

export function BooksPage({
  dataset,
  query,
  onAccounts,
}: {
  dataset: Dataset;
  query: string;
  onAccounts: () => void;
}) {
  const [view, setView] = useState<BookPortfolio | null>(null),
    [error, setError] = useState('');
  const [revision, setRevision] = useState(0),
    [page, setPage] = useState(1),
    [days, setDays] = useState('56');
  const [account, setAccount] = useState('all'),
    [status, setStatus] = useState('all'),
    [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setPage(1);
    setAccount('all');
    setDialog(null);
    setView(null);
  }, [dataset]);
  useEffect(() => {
    setPage(1);
  }, [query, status, days, account]);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      dataset,
      query,
      accountId: account,
      status,
      days,
      page: String(page),
    });
    api<BookPortfolio>(`/books?${params}`, undefined, 'GET', controller.signal)
      .then((v) => {
        setView(v);
        setError('');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [dataset, query, account, status, days, page, revision]);
  const saved = (message: string) => {
    setNotice(message);
    setDialog(null);
    setRevision((r) => r + 1);
  };
  if (error)
    return (
      <Empty
        icon={<BookOpen size={28} />}
        title="The book portfolio could not load"
        action={
          <button className="button secondary" onClick={() => setRevision((r) => r + 1)}>
            Try again
          </button>
        }
      >
        {error}
      </Empty>
    );
  if (!view || view.dataset !== dataset)
    return <div className="loading-state">Loading book economics…</div>;
  return (
    <div className="books-page">
      {notice && (
        <p role="status" className="book-notice">
          {notice}
        </p>
      )}
      <div className="book-toolbar">
        <div>
          <span className="eyebrow">EVERY EDITION HAS ITS OWN ECONOMICS</span>
          <p>Net receipts, same-ASIN units, and room to learn.</p>
        </div>
        <div className="book-actions">
          <button className="button secondary" onClick={onAccounts}>
            Advertising accounts
          </button>
          {dataset === 'workspace' && (
            <>
              <button
                className="button secondary"
                disabled={!view.accounts.length}
                onClick={() => setDialog({ kind: 'import' })}
              >
                <FileUp size={15} /> Import catalog
              </button>
              <button
                className="button primary"
                disabled={!view.accounts.length}
                onClick={() => setDialog({ kind: 'edit' })}
              >
                <Plus size={15} /> Add book
              </button>
            </>
          )}
        </div>
      </div>
      <div className="metric-grid">
        <MetricCard
          title="Book formats"
          value={number(view.summary.titles)}
          icon={<BookOpen size={17} />}
          caption={`${view.summary.verified} with verified economics`}
        />
        <MetricCard
          title="Catalog ad spend"
          value={money(view.summary.spendCents)}
          icon={<CircleDollarSign size={17} />}
          caption={`Last ${days} account reporting days`}
        />
        <MetricCard
          title="Mature contribution estimate"
          value={view.summary.measuredTitles ? money(view.summary.modeledContributionCents) : '—'}
          icon={<TrendingUp size={17} />}
          caption={`${view.summary.measuredTitles} verified titles with mature spend`}
          accent
        />
        <MetricCard
          title="Needs attention"
          value={number(view.summary.needsAttention)}
          icon={<ShieldCheck size={17} />}
          caption={`${view.summary.unmappedAsins} reported ASINs outside this catalog`}
        />
      </div>
      <section className="panel">
        <div className="panel-heading book-filter-row">
          <h2>
            Book portfolio <span className="book-count">{view.total}</span>
          </h2>
          <div className="book-actions">
            <label>
              Account
              <select
                aria-label="Book account"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              >
                <option value="all">All accounts</option>
                {view.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select
                aria-label="Book status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="all">All books</option>
                <option value="attention">Needs attention</option>
                <option value="positive">Positive estimate</option>
                <option value="learning">Learning</option>
              </select>
            </label>
            <label>
              Period
              <select
                aria-label="Book reporting period"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              >
                <option value="7">7 days</option>
                <option value="28">28 days</option>
                <option value="56">56 days</option>
              </select>
            </label>
          </div>
        </div>
        {view.books.length ? (
          <>
            <div className="book-table-scroll">
              <table className="book-table">
                <thead>
                  <tr>
                    <th scope="col">Title / format</th>
                    <th scope="col">Ad spend</th>
                    <th scope="col">Same-ASIN units</th>
                    <th scope="col">Mature contribution</th>
                    <th scope="col">Loss allowance left</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {view.books.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <button
                          className="book-title"
                          onClick={() => setDialog({ kind: 'detail', book: b })}
                        >
                          {b.title}
                        </button>
                        <span className="book-meta">
                          {b.format} · {b.asin} · {b.accountName}
                        </span>
                      </td>
                      <td>{money(b.spendCents)}</td>
                      <td>
                        {number(b.sameAsinUnits)}
                        <span className="book-meta">{b.matureUnits} mature</span>
                      </td>
                      <td
                        className={
                          b.contributionCents !== null && b.contributionCents > 0 ? 'positive' : ''
                        }
                      >
                        {money(b.contributionCents)}
                        <span className="book-meta">Through {date(b.matureThrough)}</span>
                      </td>
                      <td>
                        {money(b.remainingLossAllowanceCents)}
                        <span className="book-meta">of {money(b.lossLimitCents)} / 56 days</span>
                      </td>
                      <td>
                        <Badge
                          kind={
                            b.status === 'positive'
                              ? 'scale'
                              : b.status === 'learning'
                                ? 'explore'
                                : 'hold'
                          }
                        >
                          {labels[b.status]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="book-pagination">
              <span>
                {view.total} formats · Page {view.page} of {view.pages}
              </span>
              <div className="book-actions">
                <button
                  className="button secondary"
                  disabled={view.page <= 1}
                  onClick={() => setPage(view.page - 1)}
                >
                  Previous
                </button>
                <button
                  className="button secondary"
                  disabled={view.page >= view.pages}
                  onClick={() => setPage(view.page + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        ) : (
          <Empty
            icon={<BookOpen size={30} />}
            title={
              view.summary.titles ? 'No books match these filters' : 'Build your book portfolio'
            }
          >
            {view.accounts.length
              ? 'Import up to 2,000 formats at once, or add a single book. Each ASIN keeps its own economics.'
              : 'Connect an advertising account in The brain. A simulated account lets you prepare a catalog before API access is ready.'}
          </Empty>
        )}
      </section>
      <p className="book-method">
        Contribution is mature same-ASIN units × verified net unit receipts, less variable costs and
        ad spend. It excludes other-SKU sales, estimated Kindle royalties, returns, and overhead.
        Reconcile receipts in The brain before treating this as business profit. Loss allowances use
        a fixed 56-day window and count immature spend in full.
      </p>
      {dialog?.kind === 'edit' && (
        <Modal
          title={dialog.book ? 'Edit book economics' : 'Add a book format'}
          onClose={() => setDialog(null)}
        >
          <BookForm
            accounts={view.accounts}
            book={dialog.book}
            onSaved={() =>
              saved('Book economics saved. Reconcile any linked campaigns after changing costs.')
            }
          />
        </Modal>
      )}
      {dialog?.kind === 'import' && (
        <Modal title="Import a book catalog" onClose={() => setDialog(null)}>
          <CatalogImport accounts={view.accounts} onSaved={saved} />
        </Modal>
      )}
      {dialog?.kind === 'detail' && (
        <Modal title={dialog.book.title} onClose={() => setDialog(null)} wide>
          <BookDetail
            book={dialog.book}
            onEdit={() => setDialog({ kind: 'edit', book: dialog.book })}
            onSaved={() =>
              saved(
                'Campaign and book economics reconciled. Run the brain for fresh recommendations.',
              )
            }
          />
        </Modal>
      )}
    </div>
  );
}

function BookForm({
  accounts,
  book,
  onSaved,
}: {
  accounts: AdAccount[];
  book?: Book;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    const input = {
      asin: String(f.get('asin') || book?.asin),
      isbn: String(f.get('isbn')),
      title: String(f.get('title')),
      publisher: String(f.get('publisher')),
      format: String(f.get('format') || book?.format),
      economicsVerified: f.get('economicsVerified') === 'on',
      supplyReady: f.get('supplyReady') === 'on',
    } as Record<string, unknown>;
    for (const key of [
      'retailPriceCents',
      'netReceiptCents',
      'variableCostCents',
      'profitReserveCents',
      'lossLimitCents',
      'dailyBudgetLimitCents',
    ])
      input[key] = Math.round(Number(f.get(key)) * 100);
    try {
      await api('/books', {
        dataset: 'workspace',
        accountId: book?.accountId || f.get('accountId'),
        book: input,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const moneyFields = [
    ['retailPriceCents', 'Retail price / unit', 1995],
    ['netReceiptCents', 'Net receipts / unit', 0],
    ['variableCostCents', 'Variable costs / unit', 0],
    ['profitReserveCents', 'Profit reserve / unit', 0],
    ['lossLimitCents', '56-day loss allowance', 10000],
    ['dailyBudgetLimitCents', 'Combined daily budget ceiling', 2500],
  ] as const;
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        Advertising account
        <select
          name="accountId"
          defaultValue={book?.accountId || accounts[0]?.id}
          disabled={!!book}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Book title
        <input name="title" required maxLength={300} defaultValue={book?.title} />
      </label>
      <div className="form-grid two">
        <label>
          ASIN
          <input
            name="asin"
            required
            pattern="[a-zA-Z0-9]{10}"
            maxLength={10}
            defaultValue={book?.asin}
            disabled={!!book}
          />
        </label>
        <label>
          Format
          <select name="format" defaultValue={book?.format || 'paperback'} disabled={!!book}>
            {['paperback', 'hardcover', 'ebook', 'audiobook'].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label>
          ISBN (optional)
          <input name="isbn" maxLength={13} defaultValue={book?.isbn || ''} />
        </label>
        <label>
          Publisher (optional)
          <input name="publisher" maxLength={160} defaultValue={book?.publisher || ''} />
        </label>
      </div>
      <p className="form-help">
        Use the amount your business receives after Amazon’s share. Keep printing, royalties owed,
        and other costs separate if they are not already deducted. All amounts below are USD.
      </p>
      <div className="form-grid two">
        {moneyFields.map(([key, label, initial]) => (
          <label key={key}>
            {label} ($)
            <input
              type="number"
              name={key}
              required
              min={
                ['retailPriceCents', 'lossLimitCents', 'dailyBudgetLimitCents'].includes(key)
                  ? '0.01'
                  : '0'
              }
              max="1000000"
              step="0.01"
              defaultValue={((book?.[key] ?? initial) / 100).toFixed(2)}
            />
          </label>
        ))}
      </div>
      <label className="book-check">
        <input
          type="checkbox"
          name="economicsVerified"
          defaultChecked={book?.economicsVerified || false}
        />{' '}
        I verified the net receipts and costs for this format.
      </label>
      <label className="book-check">
        <input type="checkbox" name="supplyReady" defaultChecked={book?.supplyReady || false} />{' '}
        This edition is available to buy.
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-footer">
        <span>Limits hold recommendations; Amazon controls delivery.</span>
        <button className="button primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save book'}
        </button>
      </div>
    </form>
  );
}

function CatalogImport({
  accounts,
  onSaved,
}: {
  accounts: AdAccount[];
  onSaved: (message: string) => void;
}) {
  const [csv, setCsv] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await api<{ created: number; updated: number }>('/books/import', {
        dataset: 'workspace',
        accountId: f.get('accountId'),
        csv,
      });
      onSaved(`${result.created} book formats added; ${result.updated} updated.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        Advertising account
        <select name="accountId">
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        One row per ASIN and format. Use whole cents and true / false flags. Importing an existing
        ASIN updates its economics; it does not create another book.
      </p>
      <a className="button secondary" href="/api/books/template">
        <Download size={15} /> Download CSV template
      </a>
      <label>
        Catalog CSV file
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file && file.size <= 1500000) setCsv(await file.text());
            else if (file) setError('Use a CSV smaller than 1.5 MB.');
          }}
        />
      </label>
      <label>
        Or paste catalog CSV
        <textarea required rows={9} value={csv} onChange={(e) => setCsv(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-footer">
        <span>Up to 2,000 formats per import</span>
        <button className="button primary" disabled={busy}>
          {busy ? 'Importing…' : 'Import formats'}
        </button>
      </div>
    </form>
  );
}

function BookDetail({
  book,
  onEdit,
  onSaved,
}: {
  book: BookView;
  onEdit: () => void;
  onSaved: () => void;
}) {
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (book.dataset !== 'workspace') return;
    const controller = new AbortController();
    api<{ campaigns: typeof campaigns }>(
      `/books/${book.id}/campaigns?dataset=workspace`,
      undefined,
      'GET',
      controller.signal,
    )
      .then((r) => setCampaigns(r.campaigns))
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [book.id, book.dataset]);
  async function link(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const campaignId = new FormData(e.currentTarget).get('campaignId');
    setBusy(true);
    try {
      await api(`/books/${book.id}/link`, { dataset: 'workspace', campaignId });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-stack">
      <p className="eyebrow">
        {book.asin} · {book.format} · {book.accountName}
      </p>
      <Badge kind={book.status === 'positive' ? 'scale' : 'hold'}>{labels[book.status]}</Badge>
      <p>{book.reason}</p>
      <dl className="book-detail-grid">
        <div>
          <dt>Net unit receipts</dt>
          <dd>{money(book.netReceiptCents, 2)}</dd>
        </div>
        <div>
          <dt>Variable unit costs</dt>
          <dd>{money(book.variableCostCents, 2)}</dd>
        </div>
        <div>
          <dt>Profit reserve / unit</dt>
          <dd>{money(book.profitReserveCents, 2)}</dd>
        </div>
        <div>
          <dt>Room to acquire a sale</dt>
          <dd>{money(book.affordableAcquisitionCents, 2)}</dd>
        </div>
        <div>
          <dt>Break-even ACoS</dt>
          <dd>{percent(book.breakEvenAcos)}</dd>
        </div>
        <div>
          <dt>56-day risk exposure</dt>
          <dd>{money(book.riskExposureCents)}</dd>
        </div>
        <div>
          <dt>Active campaign budgets</dt>
          <dd>{money(book.dailyBudgetCents)} / day</dd>
        </div>
        <div>
          <dt>Daily budget ceiling</dt>
          <dd>{money(book.dailyBudgetLimitCents)} / day</dd>
        </div>
      </dl>
      <p className="form-help">
        {book.timezone} reporting calendar · {book.campaigns} campaigns with recent activity ·{' '}
        {book.lastReportedAt
          ? `Reported ${timeAgo(book.lastReportedAt)}`
          : 'Awaiting advertised-product reports'}
        . Shared campaign budgets count in full for every book they contain. Daily budgets and loss
        allowances are planning controls, not guaranteed billing caps.
      </p>
      {book.dataset === 'workspace' && (
        <>
          <button className="button secondary" onClick={onEdit}>
            Edit economics
          </button>
          <form className="form-stack book-link" onSubmit={link}>
            <h3>Use these economics for a campaign</h3>
            <p>
              First link the campaign to this advertising account in The brain. Reconciliation
              updates its unit economics; reporting must still confirm a single ASIN before
              automation can proceed.
            </p>
            <label>
              Linked campaign
              <select name="campaignId" required defaultValue="">
                <option value="" disabled>
                  Select a campaign
                </option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button primary"
              disabled={busy || !campaigns.length || !book.economicsVerified}
            >
              {busy ? 'Reconciling…' : 'Reconcile campaign economics'}
            </button>
          </form>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
