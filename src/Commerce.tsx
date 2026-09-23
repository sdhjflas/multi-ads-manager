import { useEffect, useState, type FormEvent } from 'react';
import {
  Boxes,
  CircleDollarSign,
  Download,
  FileUp,
  PackageCheck,
  Plus,
  ReceiptText,
  ShieldCheck,
  ShoppingBag,
  Store as StoreIcon,
  TrendingUp,
} from 'lucide-react';
import type {
  CommerceCampaignChoice,
  CommerceLedgerBatch,
  CommerceLedgerRevision,
  CommercePortfolio,
  CommerceProduct,
  CommerceProductView,
  CommerceStore,
} from '../shared/commerce';
import type { Dataset } from '../shared/types';
import { Badge, Empty, MetricCard, Modal } from './components';
import { api, date, money, number, timeAgo } from './lib';
import './commerce.css';

const labels: Record<CommerceProductView['status'], string> = {
  unverified: 'Verify economics',
  'not-viable': 'No acquisition room',
  'media-blocked': 'Media blocked',
  'release-blocked': 'Release blocked',
  'inventory-stale': 'Refresh inventory',
  unavailable: 'Unavailable',
  'low-stock': 'Low stock',
  'no-data': 'Import paid orders',
  'stale-ledger': 'Refresh ledger',
  'loss-limit': 'Loss allowance used',
  'budget-limit': 'Over budget ceiling',
  positive: 'Positive ledger',
  learning: 'Learning',
};

type Dialog =
  | { kind: 'store' }
  | { kind: 'edit'; product?: CommerceProductView }
  | { kind: 'catalog' }
  | { kind: 'ledger' }
  | { kind: 'batch'; batch: CommerceLedgerBatch }
  | { kind: 'detail'; product: CommerceProductView }
  | null;

export function CommercePage({ dataset, query }: { dataset: Dataset; query: string }) {
  const [view, setView] = useState<CommercePortfolio | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(1);
  const [days, setDays] = useState('28');
  const [storeId, setStoreId] = useState('all');
  const [status, setStatus] = useState('all');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setPage(1);
    setStoreId('all');
    setDialog(null);
    setView(null);
  }, [dataset]);
  useEffect(() => setPage(1), [query, status, days, storeId]);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      dataset,
      query,
      storeId,
      status,
      days,
      page: String(page),
    });
    api<CommercePortfolio>(`/commerce?${params}`, undefined, 'GET', controller.signal)
      .then((value) => {
        setView(value);
        setError('');
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError') setError(reason.message);
      });
    return () => controller.abort();
  }, [dataset, query, storeId, status, days, page, revision]);

  const saved = (message: string) => {
    setNotice(message);
    setDialog(null);
    setRevision((value) => value + 1);
  };
  if (error)
    return (
      <Empty
        icon={<ShoppingBag size={28} />}
        title="The product portfolio could not load"
        action={
          <button className="button secondary" onClick={() => setRevision((value) => value + 1)}>
            Try again
          </button>
        }
      >
        {error}
      </Empty>
    );
  if (!view || view.dataset !== dataset)
    return <div className="loading-state">Loading product economics…</div>;

  const lastBatch = view.recentBatches[0];
  return (
    <div className="commerce-page">
      {notice && (
        <p role="status" className="commerce-notice">
          {notice}
        </p>
      )}
      <div className="commerce-toolbar">
        <div>
          <span className="eyebrow">REAL ORDERS · REAL COSTS · VERIFIED CAPACITY</span>
          <p>Every SKU earns the right to scale through paid receipts and release readiness.</p>
        </div>
        {dataset === 'workspace' && (
          <div className="commerce-actions">
            <button className="button secondary" onClick={() => setDialog({ kind: 'store' })}>
              <StoreIcon size={15} /> Add store
            </button>
            <button
              className="button secondary"
              disabled={!view.stores.length}
              onClick={() => setDialog({ kind: 'ledger' })}
            >
              <ReceiptText size={15} /> Import paid orders
            </button>
            <button
              className="button secondary"
              disabled={!view.stores.length}
              onClick={() => setDialog({ kind: 'catalog' })}
            >
              <FileUp size={15} /> Import catalog
            </button>
            <button
              className="button primary"
              disabled={!view.stores.length}
              onClick={() => setDialog({ kind: 'edit' })}
            >
              <Plus size={15} /> Add SKU
            </button>
          </div>
        )}
      </div>

      <div className="metric-grid">
        <MetricCard
          title="Product SKUs"
          value={number(view.summary.skus)}
          icon={<ShoppingBag size={17} />}
          caption={`${view.summary.saleReady} ready for sale`}
        />
        <MetricCard
          title="Paid net receipts"
          value={money(view.summary.ledgerNetReceiptsCents)}
          icon={<ReceiptText size={17} />}
          caption={`Last ${days} store reporting days`}
        />
        <MetricCard
          title="Ledger contribution"
          value={view.summary.measuredSkus ? money(view.summary.ledgerContributionCents) : '—'}
          icon={<TrendingUp size={17} />}
          caption={`${view.summary.measuredSkus} SKUs with paid orders`}
          accent
        />
        <MetricCard
          title="Needs attention"
          value={number(view.summary.needsAttention)}
          icon={<ShieldCheck size={17} />}
          caption={`${number(view.summary.sellableUnits)} verified sellable units`}
        />
      </div>

      <section className="panel">
        <div className="panel-heading commerce-filter-row">
          <div>
            <h2>
              Product portfolio <span className="commerce-count">{view.total}</span>
            </h2>
            <p>
              {lastBatch
                ? `Ledger import processed ${timeAgo(lastBatch.createdAt)} · ${lastBatch.sourceName}`
                : 'No paid-order ledger has been imported.'}
            </p>
          </div>
          <div className="commerce-actions">
            <label>
              Store
              <select
                aria-label="Commerce store"
                value={storeId}
                onChange={(event) => setStoreId(event.target.value)}
              >
                <option value="all">All stores</option>
                {view.stores.map((commerceStore) => (
                  <option key={commerceStore.id} value={commerceStore.id}>
                    {commerceStore.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select
                aria-label="Product status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="all">All products</option>
                <option value="attention">Needs attention</option>
                <option value="positive">Positive ledger</option>
                <option value="learning">Learning</option>
              </select>
            </label>
            <label>
              Period
              <select
                aria-label="Product reporting period"
                value={days}
                onChange={(event) => setDays(event.target.value)}
              >
                <option value="7">7 days</option>
                <option value="28">28 days</option>
                <option value="56">56 days</option>
              </select>
            </label>
          </div>
        </div>
        {view.products.length ? (
          <>
            <div className="commerce-table-scroll">
              <table className="commerce-table">
                <thead>
                  <tr>
                    <th scope="col">Product / SKU</th>
                    <th scope="col">Sellable capacity</th>
                    <th scope="col">Paid units</th>
                    <th scope="col">Ad spend</th>
                    <th scope="col">Ledger contribution</th>
                    <th scope="col">Loss allowance left</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {view.products.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <button
                          className="commerce-title"
                          onClick={() => setDialog({ kind: 'detail', product })}
                        >
                          {product.name}
                        </button>
                        <span className="commerce-meta">
                          {product.variantName ? `${product.variantName} · ` : ''}
                          {product.sku} · {product.storeName}
                        </span>
                      </td>
                      <td>
                        {product.sellableUnits === null
                          ? 'Unverified'
                          : number(product.sellableUnits)}
                        <span className="commerce-meta">
                          {product.inventoryMode} · {product.campaigns} linked campaign
                          {product.campaigns === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td>
                        {number(product.ledgerUnits)}
                        <span className="commerce-meta">
                          {product.reconciledPaidUnits} reconciled to attributed orders
                        </span>
                      </td>
                      <td>{money(product.adSpendCents)}</td>
                      <td className={product.ledgerContributionCents! > 0 ? 'positive' : ''}>
                        {money(product.ledgerContributionCents)}
                        <span className="commerce-meta">
                          {money(product.ledgerNetReceiptsCents)} net receipts
                        </span>
                      </td>
                      <td>
                        {money(product.remainingLossAllowanceCents)}
                        <span className="commerce-meta">
                          of {money(product.lossLimitCents)} / 56 days
                        </span>
                      </td>
                      <td>
                        <Badge
                          kind={
                            product.status === 'positive'
                              ? 'scale'
                              : product.status === 'learning'
                                ? 'explore'
                                : 'hold'
                          }
                        >
                          {labels[product.status]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="commerce-pagination">
              <span>
                {view.total} SKUs · Page {view.page} of {view.pages}
              </span>
              <div className="commerce-actions">
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
            icon={<ShoppingBag size={30} />}
            title={
              view.summary.skus ? 'No products match these filters' : 'Build your product portfolio'
            }
            action={
              dataset === 'workspace' && !view.stores.length ? (
                <button className="button primary" onClick={() => setDialog({ kind: 'store' })}>
                  <Plus size={15} /> Add a store
                </button>
              ) : undefined
            }
          >
            {view.stores.length
              ? 'Import up to 2,000 SKUs at once or add one product variant. Unknown costs remain blocked.'
              : 'Register a store identity before adding products or paid-order evidence.'}
          </Empty>
        )}
      </section>

      {view.recentBatches.length > 0 && (
        <section className="panel commerce-import-history">
          <div className="panel-heading">
            <div>
              <h2>Paid-order import history</h2>
              <p>Atomic batches and their accepted before/after corrections.</p>
            </div>
            <ReceiptText size={20} />
          </div>
          <div className="commerce-table-scroll">
            <table className="commerce-table">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Order period</th>
                  <th scope="col">Rows</th>
                  <th scope="col">Changes</th>
                  <th scope="col">Processed</th>
                </tr>
              </thead>
              <tbody>
                {view.recentBatches.slice(0, 10).map((batch) => (
                  <tr key={batch.id}>
                    <td>
                      <button
                        className="commerce-title"
                        onClick={() => setDialog({ kind: 'batch', batch })}
                      >
                        {batch.sourceName}
                      </button>
                    </td>
                    <td>
                      {batch.startDate} to {batch.endDate}
                    </td>
                    <td>{number(batch.rows)}</td>
                    <td>
                      {batch.inserted} added · {batch.corrected} corrected
                      <span className="commerce-meta">{batch.unchanged} unchanged</span>
                    </td>
                    <td>{timeAgo(batch.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="commerce-method">
        Ledger contribution is paid net receipts after discounts, refunds, and chargebacks, less the
        verified per-unit cost stack and linked ad spend. Platform-attributed orders receive credit
        only up to paid ledger units for the same mature day. This reconciliation prevents
        impossible order totals; it does not prove incremental lift.
      </p>

      {dialog?.kind === 'store' && (
        <Modal title="Register a commerce store" onClose={() => setDialog(null)}>
          <StoreForm
            onSaved={() => saved('Commerce store registered. Add its SKU catalog next.')}
          />
        </Modal>
      )}
      {dialog?.kind === 'edit' && (
        <Modal
          title={dialog.product ? 'Edit product economics' : 'Add a product SKU'}
          onClose={() => setDialog(null)}
          wide
        >
          <ProductForm
            stores={view.stores}
            product={dialog.product}
            onSaved={() =>
              saved(
                'Product saved. Reconcile linked campaigns after changing economics or readiness.',
              )
            }
          />
        </Modal>
      )}
      {dialog?.kind === 'catalog' && (
        <Modal title="Import a product catalog" onClose={() => setDialog(null)} wide>
          <CatalogImport stores={view.stores} onSaved={saved} />
        </Modal>
      )}
      {dialog?.kind === 'ledger' && (
        <Modal title="Import paid order evidence" onClose={() => setDialog(null)} wide>
          <LedgerImport stores={view.stores} onSaved={saved} />
        </Modal>
      )}
      {dialog?.kind === 'batch' && (
        <Modal title="Paid-order import audit" onClose={() => setDialog(null)} wide>
          <LedgerBatchDetail dataset={dataset} batch={dialog.batch} />
        </Modal>
      )}
      {dialog?.kind === 'detail' && (
        <Modal title={dialog.product.name} onClose={() => setDialog(null)} wide>
          <ProductDetail
            dataset={dataset}
            product={dialog.product}
            editable={dataset === 'workspace'}
            onEdit={() => setDialog({ kind: 'edit', product: dialog.product })}
            onSaved={() => saved('Campaign and SKU economics reconciled.')}
          />
        </Modal>
      )}
    </div>
  );
}

function LedgerBatchDetail({ dataset, batch }: { dataset: Dataset; batch: CommerceLedgerBatch }) {
  const [revisionPage, setRevisionPage] = useState(1);
  const [revisionView, setRevisionView] = useState<{
    revisions: CommerceLedgerRevision[];
    total: number;
    page: number;
    pages: number;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setRevisionView(null);
    api<{
      revisions: CommerceLedgerRevision[];
      total: number;
      page: number;
      pages: number;
    }>(
      `/commerce/ledger/batches/${batch.id}/revisions?dataset=${dataset}&page=${revisionPage}`,
      undefined,
      'GET',
      controller.signal,
    )
      .then((value) => {
        setRevisionView(value);
        setError('');
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError') setError(reason.message);
      });
    return () => controller.abort();
  }, [batch.id, dataset, revisionPage]);
  const revisions = revisionView?.revisions;
  return (
    <div className="commerce-detail">
      <div className="commerce-detail-header">
        <div>
          <span className="eyebrow">{batch.sourceName}</span>
          <p>
            {batch.startDate} to {batch.endDate} · processed {timeAgo(batch.createdAt)}
          </p>
        </div>
        <Badge kind={batch.corrected ? 'explore' : 'hold'}>
          {batch.corrected ? `${batch.corrected} corrected` : 'No corrections'}
        </Badge>
      </div>
      <dl className="commerce-detail-grid">
        <div>
          <dt>Rows</dt>
          <dd>{number(batch.rows)}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>{number(batch.inserted)}</dd>
        </div>
        <div>
          <dt>Corrected</dt>
          <dd>{number(batch.corrected)}</dd>
        </div>
        <div>
          <dt>Unchanged</dt>
          <dd>{number(batch.unchanged)}</dd>
        </div>
      </dl>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : !revisions ? (
        <div className="loading-state">Loading accepted changes…</div>
      ) : revisions.length ? (
        <>
          <div className="commerce-table-scroll">
            <table className="commerce-table">
              <thead>
                <tr>
                  <th scope="col">Order line</th>
                  <th scope="col">SKU / date</th>
                  <th scope="col">Before</th>
                  <th scope="col">Accepted value</th>
                  <th scope="col">Observed</th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((revision) => (
                  <tr key={`${revision.after.orderRef}:${revision.after.lineRef}`}>
                    <td>
                      {revision.after.orderRef}
                      <span className="commerce-meta">{revision.after.lineRef}</span>
                    </td>
                    <td>
                      {revision.after.sku}
                      <span className="commerce-meta">{revision.after.date}</span>
                    </td>
                    <td>
                      {revision.before ? money(revision.before.netReceiptsCents) : 'New line'}
                    </td>
                    <td>
                      {money(revision.after.netReceiptsCents)}
                      <span className="commerce-meta">{revision.after.units} paid units</span>
                    </td>
                    <td>{date(revision.after.observedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {revisionView && revisionView.pages > 1 && (
            <div className="commerce-pagination">
              <span>
                {revisionView.total} accepted changes · Page {revisionView.page} of{' '}
                {revisionView.pages}
              </span>
              <div className="commerce-actions">
                <button
                  className="button secondary"
                  disabled={revisionView.page <= 1}
                  onClick={() => setRevisionPage(revisionView.page - 1)}
                >
                  Previous
                </button>
                <button
                  className="button secondary"
                  disabled={revisionView.page >= revisionView.pages}
                  onClick={() => setRevisionPage(revisionView.page + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="form-help">
          Every row matched the stored value, so this batch has no accepted line revisions.
        </p>
      )}
      <p className="commerce-privacy-caption">
        Orbit stores source references and aggregate financial fields from the exact template. No
        customer identity belongs in this audit trail.
      </p>
    </div>
  );
}

function StoreForm({ onSaved }: { onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api('/commerce/stores', {
        dataset: 'workspace',
        store: {
          name: String(form.get('name')),
          provider: 'manual',
          timezone: String(form.get('timezone')),
          maxDataAgeHours: Number(form.get('maxDataAgeHours')),
        },
      });
      onSaved();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        Store name
        <input name="name" required maxLength={160} placeholder="Enthusiast Supply Co" />
      </label>
      <div className="form-grid two">
        <label>
          Reporting timezone
          <input name="timezone" required defaultValue="America/New_York" />
        </label>
        <label>
          Maximum ledger age (hours)
          <input name="maxDataAgeHours" type="number" min="1" max="720" defaultValue="72" />
        </label>
      </div>
      <p className="form-help">
        This creates a manual aggregate source contract. Shopify authorization will attach to the
        same store identity later; tokens and customer details never belong in this form.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-footer">
        <span>USD only in this local release.</span>
        <button className="button primary" disabled={busy}>
          {busy ? 'Saving…' : 'Register store'}
        </button>
      </div>
    </form>
  );
}

const economicsFields = [
  ['retailPriceCents', 'Retail price'],
  ['plannedNetReceiptCents', 'Planned net receipts'],
  ['unitCostCents', 'Unit cost'],
  ['inboundFreightCents', 'Inbound freight'],
  ['dutiesAndFeesCents', 'Duties and fees'],
  ['packagingCostCents', 'Packaging'],
  ['paymentFeeAllowanceCents', 'Payment fee allowance'],
  ['outboundFulfillmentCents', 'Outbound fulfillment'],
  ['returnAllowanceCents', 'Return allowance'],
  ['warrantyAllowanceCents', 'Warranty allowance'],
  ['supportAllowanceCents', 'Support allowance'],
  ['profitReserveCents', 'Profit reserve'],
  ['lossLimitCents', '56-day loss allowance'],
  ['dailyBudgetLimitCents', 'Combined daily budget ceiling'],
] as const satisfies readonly [keyof CommerceProduct, string][];

const approvalFields = [
  ['economicsVerified', 'Complete economics verified'],
  ['commercialRightsApproved', 'Commercial rights approved'],
  ['productEvidenceApproved', 'Exact-SKU product evidence approved'],
  ['claimsApproved', 'Claims approved'],
  ['trackingVerified', 'Paid-order tracking and consent verified'],
  ['fulfillmentReady', 'Fulfillment and returns route ready'],
  ['releaseApproved', 'Final product release approved'],
  ['routeVerified', 'Inventory or supplier route verified'],
  ['preorderTermsApproved', 'Preorder terms approved'],
] as const satisfies readonly [keyof CommerceProduct, string][];

function ProductForm({
  stores,
  product,
  onSaved,
}: {
  stores: CommerceStore[];
  product?: CommerceProduct;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dollars = (key: keyof CommerceProduct) => {
    const value = product?.[key];
    return typeof value === 'number' ? (value / 100).toFixed(2) : '';
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nullableMoney = (key: string) => {
      const value = String(form.get(key) || '').trim();
      return value ? Math.round(Number(value) * 100) : null;
    };
    const nullableInteger = (key: string) => {
      const value = String(form.get(key) || '').trim();
      return value ? Number(value) : null;
    };
    const inventoryVerifiedAt = String(form.get('inventoryVerifiedAt') || '').trim();
    const input: Record<string, unknown> = {
      productRef: String(form.get('productRef') || product?.productRef),
      sku: String(form.get('sku') || product?.sku),
      name: String(form.get('name')),
      variantName: String(form.get('variantName')),
      externalVariantId: String(form.get('externalVariantId')),
      inventoryMode: String(form.get('inventoryMode')),
      inventoryVerifiedAt: inventoryVerifiedAt ? new Date(inventoryVerifiedAt).toISOString() : null,
      inventoryMaxAgeHours: Number(form.get('inventoryMaxAgeHours')),
    };
    for (const [key] of economicsFields) input[key] = nullableMoney(key);
    for (const key of [
      'availableUnits',
      'committedUnits',
      'quarantinedUnits',
      'supplierCapacityUnits',
      'preorderCapacityUnits',
      'safetyStockUnits',
      'reorderPointUnits',
    ])
      input[key] = nullableInteger(key);
    for (const [key] of approvalFields) input[key] = form.get(key) === 'on';
    setBusy(true);
    setError('');
    try {
      await api('/commerce/products', {
        dataset: 'workspace',
        storeId: product?.storeId || String(form.get('storeId')),
        product: input,
      });
      onSaved();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack commerce-product-form" onSubmit={submit}>
      <fieldset>
        <legend>Stable product identity</legend>
        <div className="form-grid two">
          <label>
            Store
            <select
              name="storeId"
              defaultValue={product?.storeId || stores[0]?.id}
              disabled={!!product}
            >
              {stores.map((commerceStore) => (
                <option key={commerceStore.id} value={commerceStore.id}>
                  {commerceStore.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Inventory mode
            <select name="inventoryMode" defaultValue={product?.inventoryMode || 'stocked'}>
              <option value="stocked">Stocked and inspected</option>
              <option value="supplier-direct">Supplier direct</option>
              <option value="preorder">Preorder</option>
            </select>
          </label>
          <label>
            Product reference
            <input
              name="productRef"
              required
              maxLength={160}
              defaultValue={product?.productRef}
              disabled={!!product}
            />
          </label>
          <label>
            SKU
            <input
              name="sku"
              required
              maxLength={160}
              defaultValue={product?.sku}
              disabled={!!product}
            />
          </label>
          <label>
            Product name
            <input name="name" required maxLength={240} defaultValue={product?.name} />
          </label>
          <label>
            Variant name
            <input name="variantName" maxLength={160} defaultValue={product?.variantName} />
          </label>
          <label>
            External variant ID (optional)
            <input
              name="externalVariantId"
              maxLength={200}
              defaultValue={product?.externalVariantId}
            />
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Per-unit economics</legend>
        <p className="form-help">
          Leave an unknown value blank. Orbit will keep the SKU blocked instead of treating it as
          zero.
        </p>
        <div className="form-grid three commerce-money-grid">
          {economicsFields.map(([key, label]) => (
            <label key={key}>
              {label} ($)
              <input
                name={key}
                type="number"
                min="0"
                max="1000000"
                step="0.01"
                defaultValue={dollars(key)}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Inventory and capacity</legend>
        <div className="form-grid three">
          {[
            ['availableUnits', 'Accepted available units'],
            ['committedUnits', 'Committed units'],
            ['quarantinedUnits', 'Quarantined units'],
            ['supplierCapacityUnits', 'Supplier-direct capacity'],
            ['preorderCapacityUnits', 'Preorder capacity'],
            ['safetyStockUnits', 'Safety stock'],
            ['reorderPointUnits', 'Reorder point'],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                name={key}
                type="number"
                min="0"
                step="1"
                defaultValue={
                  typeof product?.[key as keyof CommerceProduct] === 'number'
                    ? String(product[key as keyof CommerceProduct])
                    : ''
                }
              />
            </label>
          ))}
          <label>
            Inventory verified at
            <input
              name="inventoryVerifiedAt"
              type="datetime-local"
              defaultValue={product?.inventoryVerifiedAt?.slice(0, 16) || ''}
            />
          </label>
          <label>
            Refresh required after (hours)
            <input
              name="inventoryMaxAgeHours"
              type="number"
              min="1"
              max="2160"
              defaultValue={product?.inventoryMaxAgeHours || 168}
            />
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Evidence and release approvals</legend>
        <div className="commerce-check-grid">
          {approvalFields.map(([key, label]) => (
            <label className="commerce-check" key={key}>
              <input type="checkbox" name={key} defaultChecked={Boolean(product?.[key])} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-footer">
        <span>Approvals describe verified evidence; saving them does not launch ads.</span>
        <button className="button primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save product'}
        </button>
      </div>
    </form>
  );
}

function CsvInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <>
      <label>
        {label}
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) file.text().then(onChange);
          }}
        />
      </label>
      <label>
        CSV contents
        <textarea
          rows={10}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </>
  );
}

function CatalogImport({
  stores,
  onSaved,
}: {
  stores: CommerceStore[];
  onSaved: (message: string) => void;
}) {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await api<{ created: number; updated: number }>('/commerce/products/import', {
        dataset: 'workspace',
        storeId: String(form.get('storeId')),
        csv,
      });
      onSaved(`${result.created} SKUs created and ${result.updated} updated.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="commerce-import-heading">
        <p>
          Use blank numeric cells for unknown evidence. Existing SKU identities update atomically.
        </p>
        <a className="button secondary" href="/api/commerce/products/template" download>
          <Download size={15} /> Download template
        </a>
      </div>
      <label>
        Store
        <select name="storeId" defaultValue={stores[0]?.id}>
          {stores.map((commerceStore) => (
            <option key={commerceStore.id} value={commerceStore.id}>
              {commerceStore.name}
            </option>
          ))}
        </select>
      </label>
      <CsvInput value={csv} onChange={setCsv} label="Product catalog CSV" />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-footer">
        <span>Up to 2,000 SKUs per import.</span>
        <button className="button primary" disabled={busy || !csv.trim()}>
          {busy ? 'Importing…' : 'Import catalog'}
        </button>
      </div>
    </form>
  );
}

function LedgerImport({
  stores,
  onSaved,
}: {
  stores: CommerceStore[];
  onSaved: (message: string) => void;
}) {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await api<{ inserted: number; corrected: number; unchanged: number }>(
        '/commerce/ledger/import',
        {
          dataset: 'workspace',
          storeId: String(form.get('storeId')),
          sourceName: String(form.get('sourceName')),
          csv,
        },
      );
      onSaved(
        `${result.inserted} paid lines added, ${result.corrected} corrected, and ${result.unchanged} unchanged.`,
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="commerce-import-heading">
        <p>
          Import paid, non-test order lines only. Net receipts already include discounts, refunds,
          and chargebacks and exclude sales tax.
        </p>
        <a className="button secondary" href="/api/commerce/ledger/template" download>
          <Download size={15} /> Download template
        </a>
      </div>
      <div className="form-grid two">
        <label>
          Store
          <select name="storeId" defaultValue={stores[0]?.id}>
            {stores.map((commerceStore) => (
              <option key={commerceStore.id} value={commerceStore.id}>
                {commerceStore.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source name
          <input
            name="sourceName"
            required
            maxLength={160}
            placeholder="Shopify paid orders · Sep 22"
          />
        </label>
      </div>
      <CsvInput value={csv} onChange={setCsv} label="Paid-order ledger CSV" />
      <div className="commerce-privacy-note">
        <ShieldCheck size={18} />
        <p>
          Do not include names, email, phone, addresses, payment details, customer IDs, or session
          IDs. The exact template rejects extra columns.
        </p>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-footer">
        <span>
          Newer observed_at values may correct an existing order line; every change keeps a
          revision.
        </span>
        <button className="button primary" disabled={busy || !csv.trim()}>
          {busy ? 'Reconciling…' : 'Reconcile ledger'}
        </button>
      </div>
    </form>
  );
}

function ProductDetail({
  dataset,
  product,
  editable,
  onEdit,
  onSaved,
}: {
  dataset: Dataset;
  product: CommerceProductView;
  editable: boolean;
  onEdit: () => void;
  onSaved: () => void;
}) {
  const [campaigns, setCampaigns] = useState<CommerceCampaignChoice[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ campaigns: CommerceCampaignChoice[] }>(
      `/commerce/products/${product.id}/campaigns?dataset=${dataset}`,
      undefined,
      'GET',
    )
      .then(({ campaigns: values }) => {
        setCampaigns(values);
        setCampaignId(values[0]?.id || '');
      })
      .catch((reason) => setError(reason.message));
  }, [dataset, product.id]);
  async function link() {
    setBusy(true);
    setError('');
    try {
      await api(`/commerce/products/${product.id}/link`, {
        dataset: 'workspace',
        campaignId,
      });
      onSaved();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="commerce-detail">
      <div className="commerce-detail-header">
        <div>
          <span className="eyebrow">{product.sku}</span>
          <p>
            {product.variantName || 'Default variant'} · {product.storeName}
          </p>
        </div>
        {editable && (
          <button className="button secondary" onClick={onEdit}>
            Edit product
          </button>
        )}
      </div>
      <dl className="commerce-detail-grid">
        <div>
          <dt>Paid net receipts</dt>
          <dd>{money(product.ledgerNetReceiptsCents)}</dd>
        </div>
        <div>
          <dt>Ledger contribution</dt>
          <dd>{money(product.ledgerContributionCents)}</dd>
        </div>
        <div>
          <dt>Affordable acquisition</dt>
          <dd>{money(product.affordableAcquisitionCents)}</dd>
        </div>
        <div>
          <dt>Sellable capacity</dt>
          <dd>{product.sellableUnits === null ? '—' : number(product.sellableUnits)}</dd>
        </div>
        <div>
          <dt>Paid / attributed units</dt>
          <dd>
            {product.ledgerUnits} / {product.attributedOrders}
          </dd>
        </div>
        <div>
          <dt>Reconciled paid units</dt>
          <dd>{product.reconciledPaidUnits}</dd>
        </div>
        <div>
          <dt>Linked daily budgets</dt>
          <dd>{money(product.dailyBudgetCents)}</dd>
        </div>
        <div>
          <dt>Inventory verified</dt>
          <dd>{product.inventoryVerifiedAt ? date(product.inventoryVerifiedAt) : '—'}</dd>
        </div>
      </dl>
      <div className="commerce-detail-columns">
        <section>
          <h3>Cost stack</h3>
          <dl className="commerce-cost-list">
            {economicsFields.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{money(product[key] as number | null)}</dd>
              </div>
            ))}
            <div className="total">
              <dt>Total variable cost</dt>
              <dd>{money(product.unitVariableCostCents)}</dd>
            </div>
          </dl>
        </section>
        <section>
          <h3>Readiness</h3>
          <div className="commerce-readiness-badges">
            <Badge kind={product.readiness.mediaReady ? 'scale' : 'hold'}>
              {product.readiness.mediaReady ? 'Media ready' : 'Media blocked'}
            </Badge>
            <Badge kind={product.readiness.inventoryReady ? 'scale' : 'hold'}>
              {product.readiness.inventoryReady ? 'Inventory ready' : 'Inventory blocked'}
            </Badge>
            <Badge kind={product.readiness.saleReady ? 'scale' : 'hold'}>
              {product.readiness.saleReady ? 'Sale ready' : 'Sale blocked'}
            </Badge>
          </div>
          {product.readiness.blockers.length ? (
            <ul className="commerce-blockers">
              {product.readiness.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : (
            <p className="commerce-ready-note">
              <PackageCheck size={18} /> All current product gates pass.
            </p>
          )}
          <p className="form-help">{product.reason}</p>
        </section>
      </div>
      {editable && (
        <section className="commerce-link">
          <h3>Campaign identity and economics</h3>
          <p>
            One campaign can belong to one SKU. Reconcile again after changing costs, tracking,
            release, or inventory evidence.
          </p>
          {campaigns.length ? (
            <div className="commerce-actions">
              <select
                aria-label="Product campaign"
                value={campaignId}
                onChange={(event) => setCampaignId(event.target.value)}
              >
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name} · {campaign.channel}
                    {campaign.mappedProductId ? ' · linked' : ''}
                  </option>
                ))}
              </select>
              <button className="button primary" disabled={busy || !campaignId} onClick={link}>
                {busy ? 'Reconciling…' : 'Link or reconcile campaign'}
              </button>
            </div>
          ) : (
            <p className="form-help">Create a Meta or TikTok product campaign workspace first.</p>
          )}
        </section>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
