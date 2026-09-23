import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AccountLink,
  Activity,
  AdAccount,
  Campaign,
  Dataset,
  ExecutionAttempt,
  Experiment,
  LedgerEntry,
  Observation,
  PlatformSnapshot,
  Proposal,
  ProposalStatus,
  Review,
  SearchTerm,
  SyncRun,
  Target,
  TestWave,
  Learning,
} from '../shared/types.js';
import { AppError } from './validation.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path = '.data/orbit.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL CHECK(dataset IN ('demo','workspace')), body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id), date TEXT NOT NULL,
        observed_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(campaign_id,date)
      );
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL, kind TEXT NOT NULL,
        created_at TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_scope ON records(dataset,kind,created_at);
      CREATE TABLE IF NOT EXISTS ai_reservations (id TEXT PRIMARY KEY, day TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS targets_campaign ON targets(campaign_id);
      CREATE TABLE IF NOT EXISTS target_observations (
        target_id TEXT NOT NULL REFERENCES targets(id), date TEXT NOT NULL,
        observed_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(target_id,date)
      );
      CREATE TABLE IF NOT EXISTS report_sources (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS report_bindings (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id), grain TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES report_sources(id), external_id TEXT NOT NULL,
        PRIMARY KEY(campaign_id,grain)
      );
      CREATE TABLE IF NOT EXISTS report_batches (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES report_sources(id),
        dedupe_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, body TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS report_batches_scope ON report_batches(dataset,created_at);
      CREATE TABLE IF NOT EXISTS report_revisions (
        batch_id TEXT NOT NULL REFERENCES report_batches(id), position INTEGER NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(batch_id,position)
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_links (
        campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
        account_id TEXT NOT NULL REFERENCES accounts(id),
        external_campaign_id TEXT NOT NULL, ad_group_external_id TEXT NOT NULL,
        UNIQUE(account_id, external_campaign_id)
      );
      CREATE TABLE IF NOT EXISTS platform_snapshots (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id), body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sandbox_state (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id), body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS search_terms (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_terms_campaign ON search_terms(campaign_id);
      CREATE TABLE IF NOT EXISTS search_term_observations (
        term_id TEXT NOT NULL REFERENCES search_terms(id), date TEXT NOT NULL,
        observed_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(term_id,date)
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
        campaign_id TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS proposals_scope ON proposals(dataset,status,created_at);
      CREATE INDEX IF NOT EXISTS proposals_account_status ON proposals(account_id,status,created_at);
      CREATE INDEX IF NOT EXISTS proposals_campaign_status ON proposals(dataset,campaign_id,status);
      CREATE TABLE IF NOT EXISTS execution_attempts (
        id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id),
        dataset TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        dataset TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger_entries (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id), date TEXT NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(campaign_id,date)
      );
      CREATE TABLE IF NOT EXISTS ai_reviews (
        key TEXT PRIMARY KEY, dataset TEXT NOT NULL, kind TEXT NOT NULL,
        created_at TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS amazon_report_jobs (
        key TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), body TEXT NOT NULL, payload TEXT
      );
      CREATE INDEX IF NOT EXISTS amazon_report_account ON amazon_report_jobs(account_id);
      CREATE TABLE IF NOT EXISTS amazon_sync_plans (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id), body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS book_catalog (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
        asin TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(account_id,asin)
      );
      CREATE INDEX IF NOT EXISTS book_catalog_scope ON book_catalog(dataset,account_id,asin);
      CREATE TABLE IF NOT EXISTS book_campaigns (
        campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id), book_id TEXT NOT NULL REFERENCES book_catalog(id)
      );
      CREATE INDEX IF NOT EXISTS book_campaigns_book ON book_campaigns(book_id);
      CREATE TABLE IF NOT EXISTS advertised_product_rows (
        account_id TEXT NOT NULL REFERENCES accounts(id), campaign_id TEXT NOT NULL, ad_id TEXT NOT NULL,
        date TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(account_id,campaign_id,ad_id,date)
      );
      CREATE TABLE IF NOT EXISTS commerce_stores (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL CHECK(dataset IN ('demo','workspace')), body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS commerce_stores_scope ON commerce_stores(dataset,id);
      CREATE TABLE IF NOT EXISTS commerce_products (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL CHECK(dataset IN ('demo','workspace')),
        store_id TEXT NOT NULL REFERENCES commerce_stores(id), sku TEXT NOT NULL, body TEXT NOT NULL,
        UNIQUE(store_id,sku)
      );
      CREATE INDEX IF NOT EXISTS commerce_products_scope ON commerce_products(dataset,store_id,sku);
      CREATE TABLE IF NOT EXISTS commerce_campaigns (
        campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
        product_id TEXT NOT NULL REFERENCES commerce_products(id)
      );
      CREATE INDEX IF NOT EXISTS commerce_campaigns_product ON commerce_campaigns(product_id);
      CREATE TABLE IF NOT EXISTS commerce_order_lines (
        store_id TEXT NOT NULL REFERENCES commerce_stores(id), order_ref TEXT NOT NULL,
        line_ref TEXT NOT NULL, sku TEXT NOT NULL, date TEXT NOT NULL, observed_at TEXT NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(store_id,order_ref,line_ref)
      );
      CREATE INDEX IF NOT EXISTS commerce_order_lines_sku ON commerce_order_lines(store_id,sku,date);
      CREATE TABLE IF NOT EXISTS commerce_ledger_batches (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL CHECK(dataset IN ('demo','workspace')),
        store_id TEXT NOT NULL REFERENCES commerce_stores(id), content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(store_id,content_hash)
      );
      CREATE INDEX IF NOT EXISTS commerce_ledger_batches_scope ON commerce_ledger_batches(dataset,store_id,created_at);
      CREATE TABLE IF NOT EXISTS commerce_ledger_revisions (
        batch_id TEXT NOT NULL REFERENCES commerce_ledger_batches(id), position INTEGER NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(batch_id,position)
      );
      PRAGMA user_version = 7;
    `);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  campaigns(dataset: Dataset): Campaign[] {
    return (
      this.db.prepare('SELECT body FROM campaigns WHERE dataset=? ORDER BY id').all(dataset) as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body));
  }
  campaign(dataset: Dataset, id: string): Campaign {
    const row = this.db
      .prepare('SELECT body FROM campaigns WHERE dataset=? AND id=?')
      .get(dataset, id) as { body: string } | undefined;
    if (!row) throw new AppError('Campaign not found in this workspace.', 404);
    return JSON.parse(row.body);
  }
  saveCampaign(c: Campaign) {
    this.db
      .prepare(
        'INSERT INTO campaigns(id,dataset,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(c.id, c.dataset, JSON.stringify(c));
  }
  observations(campaignId: string): Observation[] {
    return (
      this.db
        .prepare('SELECT body FROM observations WHERE campaign_id=? ORDER BY date')
        .all(campaignId) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  reportingTime(dataset: Dataset, now = new Date()): Date {
    // The synthetic demo is a dated snapshot. Real data always uses the actual clock.
    if (dataset !== 'demo') return now;
    const row = this.db
      .prepare(
        "SELECT MAX(o.observed_at) AS snapshot FROM observations o JOIN campaigns c ON c.id=o.campaign_id WHERE c.dataset='demo'",
      )
      .get() as { snapshot: string | null };
    return row.snapshot ? new Date(row.snapshot) : now;
  }
  importRows(rows: Observation[]) {
    const existing = this.db.prepare(
      'SELECT observed_at FROM observations WHERE campaign_id=? AND date=?',
    );
    const insert = this.db.prepare(
      'INSERT INTO observations(campaign_id,date,observed_at,body) VALUES(?,?,?,?) ON CONFLICT(campaign_id,date) DO UPDATE SET observed_at=excluded.observed_at,body=excluded.body',
    );
    for (const row of rows) {
      const old = existing.get(row.campaignId, row.date) as { observed_at: string } | undefined;
      if (old && Date.parse(old.observed_at) > Date.parse(row.observedAt))
        throw new AppError(
          'An older export cannot overwrite a newer report. No rows were imported.',
        );
      insert.run(row.campaignId, row.date, row.observedAt, JSON.stringify(row));
    }
  }
  targets(campaignId: string): Target[] {
    return (
      this.db
        .prepare('SELECT body FROM targets WHERE campaign_id=? ORDER BY id')
        .all(campaignId) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  targetRows(targetId: string): Observation[] {
    return (
      this.db
        .prepare('SELECT body FROM target_observations WHERE target_id=? ORDER BY date')
        .all(targetId) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  targetRowsForCampaign(campaignId: string): Map<string, Observation[]> {
    const grouped = new Map<string, Observation[]>();
    const rows = this.db
      .prepare(
        'SELECT o.target_id,o.body FROM target_observations o JOIN targets t ON t.id=o.target_id WHERE t.campaign_id=? ORDER BY o.target_id,o.date',
      )
      .all(campaignId) as { target_id: string; body: string }[];
    for (const row of rows) {
      const list = grouped.get(row.target_id) || [];
      list.push(JSON.parse(row.body));
      grouped.set(row.target_id, list);
    }
    return grouped;
  }
  importTargets(entries: { target: Target; rows: Observation[] }[]) {
    const get = this.db.prepare('SELECT body FROM targets WHERE id=?');
    const put = this.db.prepare(
      'INSERT INTO targets(id,campaign_id,body) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
    );
    const prior = this.db.prepare(
      'SELECT observed_at FROM target_observations WHERE target_id=? AND date=?',
    );
    const rowPut = this.db.prepare(
      'INSERT INTO target_observations(target_id,date,observed_at,body) VALUES(?,?,?,?) ON CONFLICT(target_id,date) DO UPDATE SET observed_at=excluded.observed_at,body=excluded.body',
    );
    for (const { target, rows } of entries) {
      const old = get.get(target.id) as { body: string } | undefined;
      if (old && JSON.stringify(JSON.parse(old.body)) !== JSON.stringify(target))
        throw new AppError(
          'A target ID cannot be reused for changed text, kind, or match type. Version the target.',
        );
      put.run(target.id, target.campaignId, JSON.stringify(target));
      for (const row of rows) {
        const previous = prior.get(target.id, row.date) as { observed_at: string } | undefined;
        if (previous && Date.parse(previous.observed_at) > Date.parse(row.observedAt))
          throw new AppError('An older target report cannot replace newer observations.');
        rowPut.run(target.id, row.date, row.observedAt, JSON.stringify(row));
      }
    }
  }
  records<T>(dataset: Dataset, kind: string, limit = 200): T[] {
    return (
      this.db
        .prepare(
          'SELECT body FROM records WHERE dataset=? AND kind=? ORDER BY created_at DESC LIMIT ?',
        )
        .all(dataset, kind, limit) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  record<T>(dataset: Dataset, kind: string, id: string): T {
    const row = this.db
      .prepare('SELECT body FROM records WHERE dataset=? AND kind=? AND id=?')
      .get(dataset, kind, id) as { body: string } | undefined;
    if (!row) throw new AppError('Record not found in this workspace.', 404);
    return JSON.parse(row.body);
  }
  putRecord(
    kind: 'experiment' | 'review' | 'activity' | 'wave' | 'learning',
    value: Experiment | Review | Activity | TestWave | Learning,
  ) {
    this.db
      .prepare(
        'INSERT INTO records(id,dataset,kind,created_at,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(value.id, value.dataset, kind, value.createdAt, JSON.stringify(value));
  }
  activity(
    dataset: Dataset,
    kind: Activity['kind'],
    title: string,
    detail: string,
    createdAt = new Date().toISOString(),
  ) {
    const item: Activity = { id: randomUUID(), dataset, kind, title, detail, createdAt };
    this.putRecord('activity', item);
    return item;
  }
  aiRequests(day = new Date().toISOString().slice(0, 10)): number {
    return (
      this.db.prepare('SELECT COUNT(*) as count FROM ai_reservations WHERE day=?').get(day) as {
        count: number;
      }
    ).count;
  }
  reserveAi(limit: number): string {
    return this.transaction(() => {
      const now = new Date().toISOString(),
        day = now.slice(0, 10);
      if (this.aiRequests(day) >= limit)
        throw new AppError(
          'The daily AI request allowance has been reached. Use the structured planner or wait until the next UTC day.',
          429,
        );
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO ai_reservations(id,day,created_at) VALUES(?,?,?)')
        .run(id, day, now);
      return id;
    });
  }
  // ---- The brain -----------------------------------------------------------

  accounts(dataset: Dataset): AdAccount[] {
    return (
      this.db.prepare('SELECT body FROM accounts WHERE dataset=? ORDER BY id').all(dataset) as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body));
  }
  account(dataset: Dataset, id: string): AdAccount {
    const row = this.db
      .prepare('SELECT body FROM accounts WHERE dataset=? AND id=?')
      .get(dataset, id) as { body: string } | undefined;
    if (!row) throw new AppError('Ad account not found in this workspace.', 404);
    return JSON.parse(row.body);
  }
  saveAccount(account: AdAccount) {
    this.db
      .prepare(
        'INSERT INTO accounts(id,dataset,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(account.id, account.dataset, JSON.stringify(account));
  }
  links(accountId?: string): AccountLink[] {
    const rows = (
      accountId
        ? this.db
            .prepare('SELECT * FROM account_links WHERE account_id=? ORDER BY campaign_id')
            .all(accountId)
        : this.db.prepare('SELECT * FROM account_links ORDER BY campaign_id').all()
    ) as {
      campaign_id: string;
      account_id: string;
      external_campaign_id: string;
      ad_group_external_id: string;
    }[];
    return rows.map((r) => ({
      campaignId: r.campaign_id,
      accountId: r.account_id,
      externalCampaignId: r.external_campaign_id,
      adGroupExternalId: r.ad_group_external_id,
    }));
  }
  saveLink(link: AccountLink) {
    this.db
      .prepare(
        'INSERT INTO account_links(campaign_id,account_id,external_campaign_id,ad_group_external_id) VALUES(?,?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET account_id=excluded.account_id, external_campaign_id=excluded.external_campaign_id, ad_group_external_id=excluded.ad_group_external_id',
      )
      .run(link.campaignId, link.accountId, link.externalCampaignId, link.adGroupExternalId);
  }
  snapshot(accountId: string): PlatformSnapshot | null {
    const row = this.db
      .prepare('SELECT body FROM platform_snapshots WHERE account_id=?')
      .get(accountId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  saveSnapshot(accountId: string, snapshot: PlatformSnapshot) {
    this.db
      .prepare(
        'INSERT INTO platform_snapshots(account_id,body) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET body=excluded.body',
      )
      .run(accountId, JSON.stringify(snapshot));
  }
  sandboxState<T>(accountId: string): T | null {
    const row = this.db
      .prepare('SELECT body FROM sandbox_state WHERE account_id=?')
      .get(accountId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  saveSandboxState(accountId: string, state: unknown) {
    this.db
      .prepare(
        'INSERT INTO sandbox_state(account_id,body) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET body=excluded.body',
      )
      .run(accountId, JSON.stringify(state));
  }
  searchTerms(campaignId: string): SearchTerm[] {
    return (
      this.db
        .prepare('SELECT body FROM search_terms WHERE campaign_id=? ORDER BY id')
        .all(campaignId) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  searchTermRows(termId: string): Observation[] {
    return (
      this.db
        .prepare('SELECT body FROM search_term_observations WHERE term_id=? ORDER BY date')
        .all(termId) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  searchTermRowsForCampaign(campaignId: string): Map<string, Observation[]> {
    const grouped = new Map<string, Observation[]>();
    const rows = this.db
      .prepare(
        'SELECT o.term_id,o.body FROM search_term_observations o JOIN search_terms t ON t.id=o.term_id WHERE t.campaign_id=? ORDER BY o.term_id,o.date',
      )
      .all(campaignId) as { term_id: string; body: string }[];
    for (const row of rows) {
      const list = grouped.get(row.term_id) || [];
      list.push(JSON.parse(row.body));
      grouped.set(row.term_id, list);
    }
    return grouped;
  }
  importSearchTerms(entries: { term: SearchTerm; rows: Observation[] }[]) {
    const put = this.db.prepare(
      'INSERT INTO search_terms(id,campaign_id,body) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
    );
    const prior = this.db.prepare(
      'SELECT observed_at FROM search_term_observations WHERE term_id=? AND date=?',
    );
    const rowPut = this.db.prepare(
      'INSERT INTO search_term_observations(term_id,date,observed_at,body) VALUES(?,?,?,?) ON CONFLICT(term_id,date) DO UPDATE SET observed_at=excluded.observed_at,body=excluded.body',
    );
    for (const { term, rows } of entries) {
      put.run(term.id, term.campaignId, JSON.stringify(term));
      for (const row of rows) {
        const previous = prior.get(term.id, row.date) as { observed_at: string } | undefined;
        if (previous && Date.parse(previous.observed_at) > Date.parse(row.observedAt))
          throw new AppError('An older search-term report cannot replace newer observations.');
        rowPut.run(term.id, row.date, row.observedAt, JSON.stringify(row));
      }
    }
  }
  proposals(dataset: Dataset, limit = 500): Proposal[] {
    return (
      this.db
        .prepare('SELECT body FROM proposals WHERE dataset=? ORDER BY created_at DESC LIMIT ?')
        .all(dataset, limit) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  /** Operational scans use indexed status filters and are never truncated by a UI limit. */
  accountProposals(accountId: string, statuses: readonly ProposalStatus[]): Proposal[] {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT body FROM proposals WHERE account_id=? AND status IN (${placeholders}) ORDER BY created_at DESC`,
        )
        .all(accountId, ...statuses) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  proposalCount(dataset: Dataset, campaignId: string, statuses: readonly ProposalStatus[]): number {
    if (!statuses.length) return 0;
    const placeholders = statuses.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM proposals WHERE dataset=? AND campaign_id=? AND status IN (${placeholders})`,
        )
        .get(dataset, campaignId, ...statuses) as { count: number }
    ).count;
  }
  proposal(dataset: Dataset, id: string): Proposal {
    const row = this.db
      .prepare('SELECT body FROM proposals WHERE dataset=? AND id=?')
      .get(dataset, id) as { body: string } | undefined;
    if (!row) throw new AppError('Proposal not found in this workspace.', 404);
    return JSON.parse(row.body);
  }
  proposalByKey(key: string): Proposal | null {
    const row = this.db.prepare('SELECT body FROM proposals WHERE idempotency_key=?').get(key) as
      { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  saveProposal(p: Proposal) {
    this.db
      .prepare(
        'INSERT INTO proposals(id,dataset,account_id,campaign_id,status,idempotency_key,created_at,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, body=excluded.body',
      )
      .run(
        p.id,
        p.dataset,
        p.accountId,
        p.campaignId,
        p.status,
        p.idempotencyKey,
        p.createdAt,
        JSON.stringify(p),
      );
  }
  executions(dataset: Dataset, limit = 200): ExecutionAttempt[] {
    return (
      this.db
        .prepare(
          'SELECT body FROM execution_attempts WHERE dataset=? ORDER BY created_at DESC LIMIT ?',
        )
        .all(dataset, limit) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  saveExecution(attempt: ExecutionAttempt) {
    this.db
      .prepare(
        'INSERT INTO execution_attempts(id,proposal_id,dataset,created_at,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(
        attempt.id,
        attempt.proposalId,
        attempt.dataset,
        attempt.startedAt,
        JSON.stringify(attempt),
      );
  }
  syncRuns(dataset: Dataset, limit = 50): SyncRun[] {
    return (
      this.db
        .prepare('SELECT body FROM sync_runs WHERE dataset=? ORDER BY created_at DESC LIMIT ?')
        .all(dataset, limit) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  saveSyncRun(run: SyncRun) {
    this.db
      .prepare('INSERT INTO sync_runs(id,account_id,dataset,created_at,body) VALUES(?,?,?,?,?)')
      .run(run.id, run.accountId, run.dataset, run.startedAt, JSON.stringify(run));
  }
  ledger(campaignId: string): LedgerEntry[] {
    return (
      this.db
        .prepare('SELECT body FROM ledger_entries WHERE campaign_id=? ORDER BY date')
        .all(campaignId) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  importLedger(rows: LedgerEntry[]) {
    const put = this.db.prepare(
      'INSERT INTO ledger_entries(campaign_id,date,body) VALUES(?,?,?) ON CONFLICT(campaign_id,date) DO UPDATE SET body=excluded.body',
    );
    for (const row of rows) put.run(row.campaignId, row.date, JSON.stringify(row));
  }
  aiReview<T>(key: string): T | null {
    const row = this.db.prepare('SELECT body FROM ai_reviews WHERE key=?').get(key) as
      { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  saveAiReview(key: string, dataset: Dataset, kind: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO ai_reviews(key,dataset,kind,created_at,body) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body',
      )
      .run(key, dataset, kind, new Date().toISOString(), JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
}
