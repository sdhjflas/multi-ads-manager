import { z } from 'zod';
import type { SourceConnection } from '../../shared/connections.js';
import { ConnectorError } from '../connectors/connector.js';
import { boundedJson, safeFetch } from './http.js';
import type { ProviderObserver, ProviderSyncResult } from './provider.js';

export interface PbsCredential {
  baseUrl: string;
  accessToken: string;
  publisherCode: string;
}

const period = z.object({ label: z.string(), from: z.string(), to: z.string() });
const titlesResponse = z.object({
  pub_code: z.string(),
  period,
  titles: z.array(
    z.object({
      bk_num: z.string(),
      isbn: z.string(),
      isbn13: z.string().optional().default(''),
      title: z.string(),
      author: z.string(),
      format: z.string(),
      ebook_ind: z.boolean(),
      price: z.number().nullable(),
      units_sold_through: z.number().int(),
      units_returned: z.number().int(),
      net_sales: z.number(),
      net_sales_earned: z.number().nullable().optional(),
      units_on_hand: z.number().int(),
      units_consigned_out: z.number().int(),
      amazon_at_vendor: z.number().int().optional().default(0),
      ingram_at_vendor: z.number().int().optional().default(0),
      months_of_stock: z.number().nullable(),
      has_companion_format: z.boolean(),
    }),
  ),
  count: z.number().int().nonnegative(),
});
const statementsResponse = z.object({
  pub_code: z.string(),
  publisher_name: z.string().optional().default(''),
  statements: z.array(
    z.object({
      period: z.string().regex(/^\d{4}-\d{2}$/),
      label: z.string(),
      net_sales: z.number(),
      payments: z.number(),
      entry_count: z.number().int().nonnegative(),
      in_progress: z.boolean(),
    }),
  ),
});
const statementBundle = z
  .object({
    pub_code: z.string(),
    period: z.object({
      month: z.string(),
      label: z.string(),
      from: z.string(),
      to: z.string(),
      in_progress: z.boolean(),
    }),
    earnings_by_title: z.array(
      z.object({
        bk_num: z.string(),
        isbn: z.string(),
        title: z.string(),
        net_sales: z.number(),
        units_sold_through: z.number().int(),
      }),
    ),
    period_payments: z.array(z.record(z.string(), z.unknown())),
    payment_total: z.number().optional().default(0),
    reserve_held: z.number().optional().default(0),
    inventory_snapshot: z.object({ as_of: z.string() }).passthrough(),
    account_summary: z.record(z.string(), z.unknown()).optional(),
    billing: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export class PbsObserver implements ProviderObserver {
  private readonly base: URL;
  private readonly code: string;
  constructor(
    private credential: PbsCredential,
    private fetcher: typeof fetch = fetch,
  ) {
    this.base = new URL(credential.baseUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname);
    if ((!loopback && this.base.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(this.base.protocol)))
      throw new ConnectorError('invalid', 'PBS API must use HTTPS, except for a loopback development server.');
    if (this.base.username || this.base.password || this.base.search || this.base.hash)
      throw new ConnectorError('invalid', 'PBS API base URL cannot contain credentials, query, or fragment.');
    this.code = credential.publisherCode.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,32}$/.test(this.code))
      throw new ConnectorError('invalid', 'PBS publisher code is invalid.');
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const base = this.base.toString().endsWith('/') ? this.base : new URL(`${this.base}/`);
    const url = new URL(path.replace(/^\//, ''), base);
    if (url.origin !== this.base.origin)
      throw new ConnectorError('invalid', 'PBS API path escaped its configured origin.');
    const response = await safeFetch(
      this.fetcher,
      url,
      { headers: { Authorization: `Bearer ${this.credential.accessToken}` } },
      'PBS HQ',
      (host) => host === this.base.hostname,
    );
    const parsed = schema.safeParse(await boundedJson(response, 'PBS HQ', 20_000_000));
    if (!parsed.success)
      throw new ConnectorError('invalid', 'PBS HQ returned an unexpected response contract.');
    return parsed.data;
  }

  async collect(_connection: SourceConnection, _since: string | null): Promise<ProviderSyncResult> {
    const code = encodeURIComponent(this.code);
    const [catalog, statementList] = await Promise.all([
      this.get(`api/publishers/${code}/titles?preset=last_90_days&sort=title`, titlesResponse),
      this.get(`api/publishers/${code}/statements`, statementsResponse),
    ]);
    if (catalog.pub_code.toUpperCase() !== this.code || statementList.pub_code.toUpperCase() !== this.code)
      throw new ConnectorError('invalid', 'PBS HQ returned a different publisher scope.');
    const recent = [...statementList.statements]
      .sort((a, b) => b.period.localeCompare(a.period))
      .slice(0, 3);
    const bundles = await Promise.all(
      recent.map((row) =>
        this.get(`api/publishers/${code}/statements/${encodeURIComponent(row.period)}`, statementBundle),
      ),
    );
    const now = new Date().toISOString();
    const books = catalog.titles.map((book) => ({
      kind: 'book',
      externalId: book.bk_num,
      observedAt: now,
      value: book,
    }));
    const statements = bundles.map((bundle) => ({
      kind: 'settlement',
      externalId: bundle.period.month,
      observedAt: now,
      value: bundle,
    }));
    const sourceAsOf = bundles.map((bundle) => bundle.inventory_snapshot.as_of).sort().at(-1) || catalog.period.to;
    return {
      identity: {
        externalAccountId: this.code,
        externalAccountName: statementList.publisher_name || this.code,
        currency: 'USD',
        timezone: 'America/New_York',
        region: 'US',
      },
      objects: { book: books, settlement: statements },
      counts: {
        accounts: 1,
        books: books.length,
        settlements: statements.length,
      },
      watermark: recent[0]?.period || catalog.period.to,
      sourceAsOf,
      warnings:
        statementList.statements.length > bundles.length
          ? ['The three newest settlement bundles were refreshed; older statements remain available in PBS HQ.']
          : [],
    };
  }
}
