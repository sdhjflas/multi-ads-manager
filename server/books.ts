import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type { Book, BookView } from '../shared/books.js';
import type { AdAccount, Campaign, Dataset, Proposal } from '../shared/types.js';
import type { ReportRow } from './connectors/connector.js';
import { Store } from './store.js';
import { AppError } from './validation.js';
import { dayAt } from './engine.js';

const cents = z.number().int().min(0).max(100_000_000);
export const bookInput = z
  .object({
    asin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{10}$/),
    isbn: z
      .string()
      .trim()
      .max(17)
      .refine(
        (v) => !v || /^(?:\d{9}[\dXx]|\d{13})$/.test(v),
        'Use a 10 or 13 digit ISBN without hyphens.',
      )
      .default(''),
    title: z.string().trim().min(1).max(300),
    publisher: z.string().trim().max(160).default(''),
    format: z.enum(['paperback', 'hardcover', 'ebook', 'audiobook']),
    retailPriceCents: cents.positive(),
    netReceiptCents: cents,
    variableCostCents: cents,
    profitReserveCents: cents,
    lossLimitCents: cents.positive(),
    dailyBudgetLimitCents: cents.positive(),
    economicsVerified: z.boolean(),
    supplyReady: z.boolean(),
  })
  .strict()
  .refine(
    (v) => v.netReceiptCents <= v.retailPriceCents,
    'Net receipts cannot exceed the retail price.',
  );
export type BookInput = z.infer<typeof bookInput>;
export const bookHeaders = [
  'asin',
  'isbn',
  'title',
  'publisher',
  'format',
  'retail_price_cents',
  'net_receipt_cents',
  'variable_cost_cents',
  'profit_reserve_cents',
  'loss_limit_cents',
  'daily_budget_limit_cents',
  'economics_verified',
  'supply_ready',
];

export function parseBooks(csv: string): BookInput[] {
  let rows: Record<string, string>[];
  try {
    rows = parse(csv, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 10000,
      columns: (names: string[]) => {
        if (
          new Set(names).size !== bookHeaders.length ||
          names.length !== bookHeaders.length ||
          names.some((n) => !bookHeaders.includes(n))
        )
          throw new Error();
        return names;
      },
    });
  } catch {
    throw new AppError('Use the exact columns in the book catalog template.');
  }
  if (!rows.length || rows.length > 2000)
    throw new AppError('Import 1 to 2,000 book formats at a time.');
  const seen = new Set<string>();
  return rows.map((r, i) => {
    const integer = (key: string) => (/^\d+$/.test(r[key] || '') ? Number(r[key]) : NaN);
    const boolean = (key: string) =>
      r[key] === 'true' ? true : r[key] === 'false' ? false : undefined;
    const parsed = bookInput.safeParse({
      asin: r.asin,
      isbn: r.isbn,
      title: r.title,
      publisher: r.publisher,
      format: r.format,
      retailPriceCents: integer('retail_price_cents'),
      netReceiptCents: integer('net_receipt_cents'),
      variableCostCents: integer('variable_cost_cents'),
      profitReserveCents: integer('profit_reserve_cents'),
      lossLimitCents: integer('loss_limit_cents'),
      dailyBudgetLimitCents: integer('daily_budget_limit_cents'),
      economicsVerified: boolean('economics_verified'),
      supplyReady: boolean('supply_ready'),
    });
    if (!parsed.success)
      throw new AppError(
        `Row ${i + 2}: ${parsed.error.issues[0].message}. Money uses whole cents; flags use true or false.`,
      );
    if (seen.has(parsed.data.asin))
      throw new AppError(`Row ${i + 2}: duplicate ASIN in this account import.`);
    seen.add(parsed.data.asin);
    return parsed.data;
  });
}

export function books(store: Store, dataset: Dataset): Book[] {
  return (
    store.db
      .prepare('SELECT body FROM book_catalog WHERE dataset=? ORDER BY asin')
      .all(dataset) as { body: string }[]
  ).map((r) => JSON.parse(r.body));
}
export function bookById(store: Store, dataset: Dataset, id: string): Book {
  const row = store.db
    .prepare('SELECT body FROM book_catalog WHERE dataset=? AND id=?')
    .get(dataset, id) as { body: string } | undefined;
  if (!row) throw new AppError('Book not found in this workspace.', 404);
  return JSON.parse(row.body);
}
export function saveBooks(store: Store, account: AdAccount, inputs: BookInput[], now = new Date()) {
  const prior = new Map(
    books(store, account.dataset)
      .filter((b) => b.accountId === account.id)
      .map((b) => [b.asin, b]),
  );
  if (prior.size + inputs.filter((b) => !prior.has(b.asin)).length > 10000)
    throw new AppError('This local release supports 10,000 book formats per account.');
  const put = store.db.prepare(
    'INSERT INTO book_catalog(id,dataset,account_id,asin,body) VALUES(?,?,?,?,?) ON CONFLICT(account_id,asin) DO UPDATE SET body=excluded.body',
  );
  return inputs.map((input) => {
    const old = prior.get(input.asin);
    if (old && old.format !== input.format)
      throw new AppError(
        'An ASIN cannot change format. Use the correct separate ASIN for each edition.',
      );
    const book: Book = {
      ...input,
      id: old?.id || randomUUID(),
      dataset: account.dataset,
      accountId: account.id,
      createdAt: old?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
    };
    put.run(book.id, book.dataset, book.accountId, book.asin, JSON.stringify(book));
    return book;
  });
}

export function productRows(store: Store, accountId: string): ReportRow[] {
  return (
    store.db
      .prepare('SELECT body FROM advertised_product_rows WHERE account_id=? ORDER BY date')
      .all(accountId) as { body: string }[]
  ).map((r) => JSON.parse(r.body));
}
/** A complete account report replaces its covered interval, including removed cells. */
export function saveProductReport(
  store: Store,
  accountId: string,
  rows: ReportRow[],
  start: string,
  end: string,
  emptyGeneratedAt: string | null = null,
) {
  const old = productRows(store, accountId).filter((r) => r.date >= start && r.date <= end);
  if (
    emptyGeneratedAt &&
    (!Number.isFinite(Date.parse(emptyGeneratedAt)) ||
      new Date(emptyGeneratedAt).toISOString() !== emptyGeneratedAt)
  )
    throw new AppError('Advertised-product generation evidence is invalid.');
  const oldest = rows.map((r) => r.observedAt || '').sort()[0] || emptyGeneratedAt || '';
  if (!oldest && old.length)
    throw new AppError(
      'An empty advertised-product report cannot replace existing book facts without generation evidence.',
    );
  if (oldest && old.some((r) => (r.observedAt || '') > oldest))
    throw new AppError('An older product report cannot replace newer book facts.');
  const completeRows = rows.map((row) => {
    if (
      !row.advertisedAsin ||
      !row.adExternalId ||
      !row.observedAt ||
      row.sameSkuUnits === undefined ||
      row.sameSkuPurchases === undefined ||
      row.sameSkuSalesCents === undefined
    )
      throw new AppError('Advertised-product report is incomplete.');
    return row as ReportRow &
      Required<
        Pick<
          ReportRow,
          | 'advertisedAsin'
          | 'adExternalId'
          | 'observedAt'
          | 'sameSkuUnits'
          | 'sameSkuPurchases'
          | 'sameSkuSalesCents'
        >
      >;
  });
  store.db
    .prepare('DELETE FROM advertised_product_rows WHERE account_id=? AND date>=? AND date<=?')
    .run(accountId, start, end);
  const put = store.db.prepare(
    'INSERT INTO advertised_product_rows(account_id,campaign_id,ad_id,date,body) VALUES(?,?,?,?,?)',
  );
  for (const row of completeRows) {
    put.run(accountId, row.campaignExternalId, row.adExternalId, row.date, JSON.stringify(row));
  }
}

export function bookViews(store: Store, dataset: Dataset, days = 56, now = new Date()): BookView[] {
  const clock = store.reportingTime(dataset, now);
  const accounts = new Map(store.accounts(dataset).map((a) => [a.id, a]));
  const reportMap = new Map<string, Map<string, ReportRow[]>>();
  for (const id of accounts.keys()) {
    const grouped = new Map<string, ReportRow[]>();
    for (const row of productRows(store, id)) {
      const list = grouped.get(row.advertisedAsin!) || [];
      list.push(row);
      grouped.set(row.advertisedAsin!, list);
    }
    reportMap.set(id, grouped);
  }
  const snapshots = new Map([...accounts.keys()].map((id) => [id, store.snapshot(id)]));
  const bindings = store.db.prepare('SELECT campaign_id,book_id FROM book_campaigns').all() as {
    campaign_id: string;
    book_id: string;
  }[];
  const bindingsByBook = new Map<string, string[]>();
  for (const binding of bindings) {
    const list = bindingsByBook.get(binding.book_id) || [];
    list.push(binding.campaign_id);
    bindingsByBook.set(binding.book_id, list);
  }
  const campaignLinks = new Map(store.links().map((l) => [l.campaignId, l]));
  return books(store, dataset).map((book) => {
    const account = accounts.get(book.accountId)!;
    const today = dayAt(clock, 0, account.timezone),
      matureThrough = dayAt(clock, -account.attributionDays - 1, account.timezone);
    const history = (reportMap.get(book.accountId)?.get(book.asin) || []).filter(
      (r) => r.date < today,
    );
    const rows = history.filter((r) => r.date >= dayAt(clock, -days, account.timezone));
    const mature = rows.filter((r) => r.date <= matureThrough);
    const riskRows = history.filter((r) => r.date >= dayAt(clock, -56, account.timezone));
    const sum = (list: ReportRow[], key: 'costCents' | 'sameSkuUnits' | 'sameSkuSalesCents') =>
      list.reduce((s, r) => s + (r[key] || 0), 0);
    const unit = book.netReceiptCents - book.variableCostCents;
    const room = unit - book.profitReserveCents;
    const matureSpendCents = sum(mature, 'costCents'),
      matureUnits = sum(mature, 'sameSkuUnits');
    const contributionCents = book.economicsVerified ? matureUnits * unit - matureSpendCents : null;
    const riskExposureCents = book.economicsVerified
      ? Math.max(
          0,
          sum(riskRows, 'costCents') -
            sum(
              riskRows.filter((r) => r.date <= matureThrough),
              'sameSkuUnits',
            ) *
              Math.max(0, room),
        )
      : null;
    const campaigns = new Set(history.map((r) => r.campaignExternalId));
    const linkedCampaignIds = bindingsByBook.get(book.id) || [];
    for (const campaignId of linkedCampaignIds) {
      const link = campaignLinks.get(campaignId);
      if (link && link.accountId === account.id) campaigns.add(link.externalCampaignId);
    }
    const dailyBudgetCents =
      snapshots
        .get(book.accountId)
        ?.campaigns.filter((c) => campaigns.has(c.externalId) && c.state === 'enabled')
        .reduce((s, c) => s + c.dailyBudgetCents, 0) || 0;
    const lastReportedAt =
      rows
        .map((r) => r.observedAt!)
        .sort()
        .at(-1) || null;
    let status: BookView['status'] = 'learning',
      reason = 'Collect mature same-ASIN conversions before increasing spend.';
    if (!book.economicsVerified) {
      status = 'unverified';
      reason = 'Verify net receipts and costs for this format.';
    } else if (room <= 0) {
      status = 'not-viable';
      reason = 'Unit economics leave no room for advertising after the profit reserve.';
    } else if (!book.supplyReady) {
      status = 'unavailable';
      reason = 'Confirm this edition is available to buy.';
    } else if (!rows.length) {
      status = 'no-data';
      reason = 'No advertised-product data for this ASIN in the selected window.';
    } else if (
      account.health.status !== 'ok' ||
      !lastReportedAt ||
      rows.some(
        (r) =>
          !r.observedAt ||
          clock.getTime() - Date.parse(r.observedAt) > account.policy.maxEvidenceAgeHours * 3600000,
      )
    ) {
      status = 'stale';
      reason = 'Wait for a complete, recent account synchronization.';
    } else if (riskExposureCents! >= book.lossLimitCents) {
      status = 'loss-limit';
      reason = 'The 56-day loss allowance is used. Recent spend gets no credit for immature sales.';
    } else if (dailyBudgetCents > book.dailyBudgetLimitCents) {
      status = 'budget-limit';
      reason = 'Combined active campaign budgets exceed this book’s ceiling.';
    } else if (contributionCents! > 0 && matureUnits > 0) {
      status = 'positive';
      reason =
        'Mature same-ASIN units cover modeled costs and ad spend. This is an estimate, not reconciled profit.';
    }
    return {
      ...book,
      accountName: account.name,
      currency: account.currency,
      timezone: account.timezone,
      campaigns: campaigns.size,
      linkedCampaignIds,
      spendCents: sum(rows, 'costCents'),
      sameAsinUnits: sum(rows, 'sameSkuUnits'),
      sameAsinSalesCents: sum(rows, 'sameSkuSalesCents'),
      matureSpendCents,
      matureUnits,
      contributionCents,
      riskExposureCents,
      remainingLossAllowanceCents:
        riskExposureCents === null ? null : Math.max(0, book.lossLimitCents - riskExposureCents),
      affordableAcquisitionCents: book.economicsVerified ? Math.max(0, room) : null,
      breakEvenAcos: book.economicsVerified && unit > 0 ? unit / book.retailPriceCents : null,
      dailyBudgetCents,
      lastReportedAt,
      matureThrough,
      status,
      reason,
    };
  });
}

/** Live optimization requires a single, explicitly mapped book and reconcilable income. */
export function bookBlockers(
  store: Store,
  account: AdAccount,
  campaign: Campaign,
  externalId: string,
  now: Date,
  context?: { views: BookView[]; rows: ReportRow[] },
): string[] {
  if (account.connector !== 'amazon-ads') return [];
  const link = store.db
    .prepare('SELECT book_id FROM book_campaigns WHERE campaign_id=?')
    .get(campaign.id) as { book_id: string } | undefined;
  if (!link) return ['Map this campaign to a verified book format in the Book portfolio.'];
  const book = bookById(store, account.dataset, link.book_id);
  if (book.accountId !== account.id)
    return ['Book and campaign belong to different advertising accounts.'];
  if (
    !book.economicsVerified ||
    !book.supplyReady ||
    book.netReceiptCents !== campaign.netReceiptCents ||
    book.variableCostCents !== campaign.variableCostCents ||
    book.profitReserveCents !== campaign.targetProfitCents ||
    book.retailPriceCents !== campaign.retailPriceCents
  )
    return ['Reconcile the campaign’s economics with its verified book format.'];
  const rows = (context?.rows || productRows(store, account.id)).filter(
    (r) => r.campaignExternalId === externalId && r.date >= dayAt(now, -56, account.timezone),
  );
  if (!rows.length || rows.some((r) => r.advertisedAsin !== book.asin))
    return [
      'This campaign does not have complete evidence for a single mapped ASIN. Split mixed-title campaigns before automating.',
    ];
  if (
    rows.some(
      (r) =>
        r.purchases !== r.sameSkuPurchases ||
        r.sameSkuUnits !== r.sameSkuPurchases ||
        r.salesCents !== r.sameSkuSalesCents,
    )
  )
    return [
      'Campaign reports include other-SKU sales or multiple units per purchase. Book estimates remain available; the keyword conversion model needs a compatible income contract.',
    ];
  const view = (context?.views || bookViews(store, account.dataset, 56, now)).find(
    (b) => b.id === book.id,
  )!;
  if (!['positive', 'learning'].includes(view.status)) return [view.reason];
  const parent = store
    .observations(campaign.id)
    .filter((r) => r.date >= dayAt(now, -56, account.timezone));
  for (const p of parent) {
    const day = rows.filter((r) => r.date === p.date);
    if (
      !day.length ||
      day.reduce((s, r) => s + r.costCents, 0) !== p.spendCents ||
      day.reduce((s, r) => s + r.purchases, 0) !== p.orders
    )
      return [
        'Reconcile advertised-product totals with the campaign report before changing delivery.',
      ];
  }
  return [];
}

export function bookCommitmentBlocker(
  store: Store,
  account: AdAccount,
  proposal: Proposal,
  now: Date,
  views?: BookView[],
  reserve = true,
): string | null {
  if (account.connector !== 'amazon-ads' || proposal.maxCommitmentCents <= 0) return null;
  const book = (views || bookViews(store, account.dataset, 56, now)).find((b) =>
    b.linkedCampaignIds.includes(proposal.campaignId),
  );
  if (!book || book.remainingLossAllowanceCents === null)
    return 'A verified book loss allowance is required.';
  const row = store.db
    .prepare(
      "SELECT COALESCE(SUM(json_extract(p.body,'$.maxCommitmentCents')),0) AS committed FROM proposals p JOIN book_campaigns b ON b.campaign_id=p.campaign_id WHERE b.book_id=? AND p.account_id=? AND p.id<>? AND p.status IN ('reserved','sending','uncertain','applied') AND substr(json_extract(p.body,'$.updatedAt'),1,10)=?",
    )
    .get(book.id, account.id, proposal.id, now.toISOString().slice(0, 10)) as { committed: number };
  const additional = (reserve ? row.committed : 0) + proposal.maxCommitmentCents;
  if (additional > book.remainingLossAllowanceCents)
    return 'This change would exceed the book’s remaining loss allowance after today’s commitments.';
  if (book.dailyBudgetCents + additional > book.dailyBudgetLimitCents)
    return 'This change would exceed the book’s combined daily budget ceiling.';
  return null;
}
