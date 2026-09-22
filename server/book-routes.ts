import type { Express } from 'express';
import { z } from 'zod';
import type { BookPortfolio } from '../shared/books.js';
import { Store } from './store.js';
import { AppError, datasetSchema } from './validation.js';
import {
  bookById,
  bookHeaders,
  bookInput,
  books,
  bookViews,
  parseBooks,
  productRows,
  saveBooks,
} from './books.js';

export function bookRoutes(app: Express, store: Store) {
  app.get('/api/books/:id/campaigns', (req, res) => {
    const { dataset } = z.object({ dataset: datasetSchema }).strict().parse(req.query);
    const book = bookById(store, dataset, String(req.params.id));
    const linked = new Set(store.links(book.accountId).map((l) => l.campaignId));
    res.json({
      campaigns: store
        .campaigns(dataset)
        .filter((c) => c.vertical === 'books' && linked.has(c.id))
        .map((c) => ({ id: c.id, name: c.name })),
    });
  });
  app.get('/api/books', (req, res) => {
    const input = z
      .object({
        dataset: datasetSchema,
        days: z.enum(['7', '28', '56']).default('56'),
        query: z.string().max(300).default(''),
        accountId: z.string().max(160).default('all'),
        status: z.enum(['all', 'attention', 'positive', 'learning']).default('all'),
        page: z.coerce.number().int().min(1).max(10000).default(1),
      })
      .strict()
      .parse(req.query);
    const accounts = store.accounts(input.dataset);
    const all = bookViews(store, input.dataset, Number(input.days)).filter(
      (b) => input.accountId === 'all' || b.accountId === input.accountId,
    );
    const attention = (b: (typeof all)[number]) => !['positive', 'learning'].includes(b.status);
    const filtered = all.filter(
      (b) =>
        `${b.title} ${b.asin} ${b.isbn} ${b.publisher}`
          .toLowerCase()
          .includes(input.query.toLowerCase()) &&
        (input.status === 'all' ||
          (input.status === 'attention' ? attention(b) : b.status === input.status)),
    );
    const pages = Math.max(1, Math.ceil(filtered.length / 50)),
      page = Math.min(input.page, pages);
    let unmappedAsins = 0;
    for (const account of accounts.filter(
      (a) => input.accountId === 'all' || a.id === input.accountId,
    )) {
      const mapped = new Set(all.filter((b) => b.accountId === account.id).map((b) => b.asin));
      unmappedAsins += new Set(
        productRows(store, account.id)
          .filter((r) => !mapped.has(r.advertisedAsin!))
          .map((r) => r.advertisedAsin),
      ).size;
    }
    const result: BookPortfolio = {
      dataset: input.dataset,
      days: Number(input.days),
      accounts,
      books: filtered.slice((page - 1) * 50, page * 50),
      total: filtered.length,
      page,
      pages,
      summary: {
        titles: all.length,
        verified: all.filter((b) => b.economicsVerified).length,
        needsAttention: all.filter(attention).length,
        spendCents: all.reduce((s, b) => s + b.spendCents, 0),
        modeledContributionCents: all.reduce((s, b) => s + (b.contributionCents || 0), 0),
        measuredTitles: all.filter(
          (b) => b.economicsVerified && b.lastReportedAt && b.matureSpendCents > 0,
        ).length,
        unmappedAsins,
      },
    };
    res.json(result);
  });
  app.get('/api/books/template', (_req, res) =>
    res
      .type('text/csv')
      .attachment('orbit-book-catalog.csv')
      .send(bookHeaders.join(',') + '\n'),
  );
  app.post('/api/books/import', (req, res) => {
    const input = z
      .object({
        dataset: z.literal('workspace'),
        accountId: z.string().min(1),
        csv: z.string().min(1).max(1_500_000),
      })
      .strict()
      .parse(req.body);
    const account = store.account(input.dataset, input.accountId);
    const parsed = parseBooks(input.csv);
    const existing = new Set(
      books(store, input.dataset)
        .filter((b) => b.accountId === account.id)
        .map((b) => b.asin),
    );
    store.transaction(() => {
      saveBooks(store, account, parsed);
      store.activity(
        input.dataset,
        'import',
        'Book catalog imported',
        `${parsed.length} formats for ${account.name}. Existing ASINs updated; changed economics must be reconciled with linked campaigns.`,
      );
    });
    res.status(201).json({
      created: parsed.filter((b) => !existing.has(b.asin)).length,
      updated: parsed.filter((b) => existing.has(b.asin)).length,
    });
  });
  app.post('/api/books', (req, res) => {
    const { dataset, accountId, book } = z
      .object({ dataset: z.literal('workspace'), accountId: z.string().min(1), book: bookInput })
      .strict()
      .parse(req.body);
    const account = store.account(dataset, accountId);
    res.status(201).json(
      store.transaction(() => {
        const [saved] = saveBooks(store, account, [book]);
        store.activity(
          dataset,
          'campaign',
          'Book economics saved',
          `${saved.title} · ${saved.asin}. Modeled economics apply across the reporting period.`,
        );
        return saved;
      }),
    );
  });
  app.post('/api/books/:id/link', (req, res) => {
    const { dataset, campaignId } = z
      .object({ dataset: z.literal('workspace'), campaignId: z.string().min(1).max(160) })
      .strict()
      .parse(req.body);
    const book = bookById(store, dataset, String(req.params.id));
    const campaign = store.campaign(dataset, campaignId);
    const account = store.account(dataset, book.accountId);
    const link = store.links(account.id).find((l) => l.campaignId === campaign.id);
    if (!link || campaign.vertical !== 'books')
      throw new AppError(
        'First link this book campaign to the same advertising account in The brain.',
      );
    if (
      !book.economicsVerified ||
      book.netReceiptCents <= book.variableCostCents + book.profitReserveCents
    )
      throw new AppError(
        'Verify that this format leaves room for advertising before linking optimization.',
      );
    const previous = store.db
      .prepare('SELECT book_id FROM book_campaigns WHERE campaign_id=?')
      .get(campaign.id) as { book_id: string } | undefined;
    if (previous && previous.book_id !== book.id)
      throw new AppError(
        'A campaign’s book identity is fixed. Create a new campaign for a different ASIN.',
      );
    store.transaction(() => {
      store.db
        .prepare(
          'INSERT INTO book_campaigns(campaign_id,book_id) VALUES(?,?) ON CONFLICT(campaign_id) DO NOTHING',
        )
        .run(campaign.id, book.id);
      store.saveCampaign({
        ...campaign,
        retailPriceCents: book.retailPriceCents,
        netReceiptCents: book.netReceiptCents,
        variableCostCents: book.variableCostCents,
        targetProfitCents: book.profitReserveCents,
        economicsVerified: book.economicsVerified,
        supplyReady: book.supplyReady,
      });
      store.activity(
        dataset,
        'campaign',
        'Book and campaign economics reconciled',
        `${campaign.name} uses ${book.title} · ${book.asin}. Existing proposal evidence must be re-evaluated.`,
      );
    });
    res.json({ ok: true });
  });
}
