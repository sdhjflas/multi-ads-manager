import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Activity,
  Campaign,
  Dataset,
  Experiment,
  Observation,
  Review,
  Target,
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
      PRAGMA user_version = 2;
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
  putRecord(kind: 'experiment' | 'review' | 'activity', value: Experiment | Review | Activity) {
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
  close() {
    this.db.close();
  }
}
