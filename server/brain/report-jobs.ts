import { randomUUID } from 'node:crypto';
import { Store } from '../store.js';
import {
  reportWindows,
  type AmazonReportJob,
  type ReportCache,
} from '../connectors/amazon-reports.js';
import type { ReportKind, ReportRow } from '../connectors/connector.js';
import type { AdAccount } from '../../shared/types.js';
import { dayAt } from '../engine.js';
import { AppError } from '../validation.js';

export class SqliteReportCache implements ReportCache {
  constructor(
    private store: Store,
    private accountId: string,
  ) {}
  get(key: string) {
    const row = this.store.db
      .prepare('SELECT body,payload FROM amazon_report_jobs WHERE key=? AND account_id=?')
      .get(key, this.accountId) as { body: string; payload: string | null } | undefined;
    return row
      ? {
          job: JSON.parse(row.body) as AmazonReportJob,
          rows: row.payload ? (JSON.parse(row.payload) as ReportRow[]) : null,
        }
      : null;
  }
  set(job: AmazonReportJob, rows?: ReportRow[]) {
    this.store.db
      .prepare(
        'INSERT INTO amazon_report_jobs(key,account_id,body,payload) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,payload=excluded.payload',
      )
      .run(job.key, this.accountId, JSON.stringify(job), rows ? JSON.stringify(rows) : null);
  }
}
export type SyncPlan = {
  generation: string;
  startDate: string;
  endDate: string;
  createdAt: string;
};
export function syncPlan(store: Store, account: AdAccount, now = new Date()): SyncPlan {
  const saved = store.db
    .prepare('SELECT body FROM amazon_sync_plans WHERE account_id=?')
    .get(account.id) as { body: string } | undefined;
  if (saved) return JSON.parse(saved.body);
  // Reconcile mature cohorts too: Amazon documents restatements up to 28 days after conversion.
  const plan: SyncPlan = {
    generation: randomUUID(),
    startDate: dayAt(now, -Math.max(56, account.attributionDays + 30), account.timezone),
    endDate: dayAt(now, -1, account.timezone),
    createdAt: now.toISOString(),
  };
  store.db
    .prepare('INSERT INTO amazon_sync_plans(account_id,body) VALUES(?,?)')
    .run(account.id, JSON.stringify(plan));
  return plan;
}
export function reportJobs(store: Store, accountId: string): AmazonReportJob[] {
  return (
    store.db
      .prepare(
        'SELECT body FROM amazon_report_jobs WHERE account_id=? ORDER BY rowid DESC LIMIT 500',
      )
      .all(accountId) as { body: string }[]
  ).map((r) => JSON.parse(r.body));
}

/** Oldest generation time across every exact window in the current sync plan. */
export function reportGenerationTime(
  store: Store,
  accountId: string,
  kind: ReportKind,
  startDate: string,
  endDate: string,
  attributionDays: number,
  planCreatedAt: string,
): string | null {
  const jobs = (
    store.db
      .prepare('SELECT body FROM amazon_report_jobs WHERE account_id=? ORDER BY rowid DESC')
      .all(accountId) as { body: string }[]
  )
    .map((r) => JSON.parse(r.body) as AmazonReportJob)
    .filter(
      (job) =>
        job.kind === kind &&
        job.attributionDays === attributionDays &&
        job.status === 'complete' &&
        job.createdAt >= planCreatedAt &&
        job.generatedAt &&
        Number.isFinite(Date.parse(job.generatedAt)),
    );
  const generated = reportWindows(startDate, endDate).map((window) =>
    jobs.find((job) => job.startDate === window.startDate && job.endDate === window.endDate),
  );
  if (generated.some((job) => !job)) return null;
  return generated.map((job) => job!.generatedAt!).sort()[0];
}

export function finishSyncPlan(store: Store, accountId: string) {
  store.db.prepare('DELETE FROM amazon_sync_plans WHERE account_id=?').run(accountId);
  // The committed observations are the durable facts. Retain compact job metadata,
  // but release repeated rolling-window payloads as soon as every grain is ingested.
  store.db
    .prepare(
      "UPDATE amazon_report_jobs SET payload=NULL WHERE account_id=? AND json_extract(body,'$.status')='complete'",
    )
    .run(accountId);
}

export function resetReportJob(store: Store, account: AdAccount, key: string, reportId?: string) {
  const cache = new SqliteReportCache(store, account.id);
  const entry = cache.get(key);
  if (!entry || !['failed', 'uncertain', 'creating'].includes(entry.job.status))
    throw new AppError('Only failed or interrupted report jobs can be resumed.');
  const retriedAt = new Date().toISOString();
  const job = {
    ...entry.job,
    reportId:
      reportId ||
      (entry.job.message.startsWith('Amazon could not generate') ? null : entry.job.reportId),
    status: 'pending' as const,
    createdAt: retriedAt,
    updatedAt: retriedAt,
    nextAttemptAt: retriedAt,
    attempts: 0,
    message: 'Operator requested another attempt with the same report contract.',
  };
  cache.set(job);
  store.saveAccount({
    ...account,
    health: { ...account.health, status: 'pending', message: 'Report retry queued.' },
  });
  store.activity(
    account.dataset,
    'system',
    'Amazon report retry requested',
    `${account.name}: ${job.kind}, ${job.startDate} through ${job.endDate}.`,
  );
  return job;
}
