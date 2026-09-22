import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store } from '../server/store.js';
import { createAccount } from '../server/brain/accounts.js';
import {
  SqliteReportCache,
  finishSyncPlan,
  reportJobs,
  syncPlan,
} from '../server/brain/report-jobs.js';
import { AmazonAdsConnector } from '../server/connectors/amazon.js';
import {
  decodeReport,
  reportConfiguration,
  reportWindows,
  validateDownloadUrl,
  limitedBody,
  MemoryReportCache,
} from '../server/connectors/amazon-reports.js';

const config = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  refreshToken: 'test-refresh',
  profileId: '42',
  region: 'NA' as const,
  writesEnabled: false,
  timezone: 'America/Los_Angeles',
};
const timestamp = Date.parse('2026-09-22T12:00:00Z');
const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const token = () => json({ access_token: 'token', expires_in: 3600 });
const row = (date = '2026-09-01') => ({
  date,
  campaignId: '9',
  impressions: 100,
  clicks: 10,
  cost: 3,
  purchases14d: 1,
  sales14d: 20,
});

describe('durable Amazon reporting', () => {
  it('resumes a 56-day report after a process restart without submitting duplicate jobs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orbit-amazon-test-'));
    const path = join(directory, 'reports.sqlite');
    let store = new Store(path),
      clock = timestamp;
    try {
      const account = createAccount(store, {
        dataset: 'workspace',
        name: 'Test account',
        connector: 'sandbox',
        profileId: 'test',
        marketplace: 'US',
        attributionDays: 14,
      });
      const plan = syncPlan(store, { ...account, timezone: config.timezone }, new Date(clock));
      const requests: Record<
        string,
        { startDate: string; endDate: string; configuration: unknown }
      > = {};
      let posts = 0;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        const address = String(url);
        if (address.endsWith('/auth/o2/token')) return token();
        if (address.endsWith('/reporting/reports')) {
          const id = `report-${++posts}`;
          requests[id] = JSON.parse(String(init?.body));
          return json({ reportId: id, status: 'PENDING' });
        }
        if (address.startsWith('https://reports.s3.amazonaws.com/')) {
          expect(init?.headers).toBeUndefined();
          expect(init?.redirect).toBe('error');
          const id = address.split('/').at(-1)!;
          return new Response(gzipSync(JSON.stringify([row(requests[id].startDate)])));
        }
        const id = address.split('/').at(-1)!;
        return json({
          ...requests[id],
          reportId: id,
          status: 'COMPLETED',
          generatedAt: new Date(timestamp).toISOString(),
          url: `https://reports.s3.amazonaws.com/${id}`,
        });
      });
      let connector = new AmazonAdsConnector(
        config,
        fetcher,
        () => clock,
        undefined,
        new SqliteReportCache(store, account.id),
        plan.generation,
      );
      await expect(
        connector.report('campaign', plan.startDate, plan.endDate, 14),
      ).rejects.toMatchObject({ kind: 'pending' });
      expect(posts).toBe(2);
      expect(
        Object.values(requests).every(
          (r) => (Date.parse(r.endDate) - Date.parse(r.startDate)) / 86400000 < 31,
        ),
      ).toBe(true);
      expect(JSON.stringify(reportJobs(store, account.id))).not.toContain('test-refresh');
      store.close();
      store = new Store(path);
      clock += 60000;
      expect(syncPlan(store, account, new Date(clock)).generation).toBe(plan.generation);
      connector = new AmazonAdsConnector(
        config,
        fetcher,
        () => clock,
        undefined,
        new SqliteReportCache(store, account.id),
        plan.generation,
      );
      const rows = await connector.report('campaign', plan.startDate, plan.endDate, 14);
      expect(rows).toHaveLength(2);
      expect(posts).toBe(2);
      expect(rows.every((r) => r.observedAt === new Date(timestamp).toISOString())).toBe(true);
      expect(reportJobs(store, account.id).every((j) => j.status === 'complete')).toBe(true);
      const calls = fetcher.mock.calls.length;
      expect(await connector.report('campaign', plan.startDate, plan.endDate, 14)).toEqual(rows);
      expect(fetcher).toHaveBeenCalledTimes(calls);
      finishSyncPlan(store, account.id);
      expect(
        (
          store.db
            .prepare('SELECT COUNT(*) AS count FROM amazon_report_jobs WHERE payload IS NOT NULL')
            .get() as { count: number }
        ).count,
      ).toBe(0);
      expect(reportJobs(store, account.id)).toHaveLength(2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('respects Retry-After dates and resumes a throttled report request', async () => {
    let clock = timestamp,
      requests = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/o2/token')) return token();
      requests++;
      return requests === 1
        ? json({}, 429, { 'retry-after': new Date(timestamp + 600000).toUTCString() })
        : json({ reportId: 'r', status: 'PENDING' });
    });
    const sleep = vi.fn(async () => {});
    const connector = new AmazonAdsConnector(config, fetcher, () => clock, sleep);
    await expect(
      connector.report('campaign', '2026-09-01', '2026-09-01', 14),
    ).rejects.toMatchObject({ kind: 'throttled', retryAfterMs: 600000 });
    clock += 599000;
    await expect(
      connector.report('campaign', '2026-09-01', '2026-09-01', 14),
    ).rejects.toMatchObject({ kind: 'pending' });
    expect(requests).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    clock += 1000;
    await expect(
      connector.report('campaign', '2026-09-01', '2026-09-01', 14),
    ).rejects.toMatchObject({ kind: 'pending' });
    expect(requests).toBe(2);
  });

  it('stops polling a report that Amazon has not finished within three hours', async () => {
    let clock = timestamp;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/auth/o2/token')) return token();
      if (init?.method === 'POST') return json({ reportId: 'slow-report', status: 'PENDING' });
      return json({
        reportId: 'slow-report',
        status: 'PROCESSING',
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        configuration: reportConfiguration('campaign', 14),
      });
    });
    const connector = new AmazonAdsConnector(config, fetcher, () => clock);
    await expect(
      connector.report('campaign', '2026-09-01', '2026-09-01', 14),
    ).rejects.toMatchObject({ kind: 'pending' });
    clock += 3 * 3_600_000;
    await expect(
      connector.report('campaign', '2026-09-01', '2026-09-01', 14),
    ).rejects.toMatchObject({ kind: 'invalid' });
    const calls = fetcher.mock.calls.length;
    await expect(connector.report('campaign', '2026-09-01', '2026-09-01', 14)).rejects.toThrow(
      /needs review/,
    );
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });

  it('recovers an Amazon duplicate ID and rejects a resumed report with a different contract', async () => {
    let clock = timestamp;
    const id = '01234567-1234-1234-1234-123456789abc';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/o2/token')) return token();
      if (String(url).endsWith('/reporting/reports'))
        return json({ detail: `Request is a duplicate of : ${id}` }, 425);
      expect(String(url)).toContain(id);
      return json({
        reportId: id,
        status: 'COMPLETED',
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        configuration: reportConfiguration('campaign', 7),
        generatedAt: new Date(timestamp).toISOString(),
        url: 'https://reports.s3.amazonaws.com/data',
      });
    });
    const connector = new AmazonAdsConnector(config, fetcher, () => clock);
    await expect(
      connector.report('campaign', '2026-09-01', '2026-09-01', 14),
    ).rejects.toMatchObject({ kind: 'pending' });
    clock += 60000;
    await expect(connector.report('campaign', '2026-09-01', '2026-09-01', 14)).rejects.toThrow(
      /does not match/,
    );
    expect(fetcher.mock.calls.some(([u]) => String(u).includes('s3.amazonaws.com'))).toBe(false);
  });

  it('holds interrupted report creation for review instead of resubmitting in the background', async () => {
    const cache = new MemoryReportCache();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/o2/token')) return token();
      throw new Error('lost response');
    });
    const connector = new AmazonAdsConnector(config, fetcher, () => timestamp, undefined, cache);
    await expect(
      connector.report('campaign', '2026-09-01', '2026-09-01', 14),
    ).rejects.toMatchObject({ kind: 'ambiguous' });
    const calls = fetcher.mock.calls.length;
    await expect(connector.report('campaign', '2026-09-01', '2026-09-01', 14)).rejects.toThrow(
      /needs review/,
    );
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
});

describe('Amazon contracts and identity', () => {
  it('collects 501 campaigns worth of keywords with bounded filters', async () => {
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/auth/o2/token')) return token();
      const filter = JSON.parse(String(init?.body)).campaignIdFilter.include as string[];
      expect(filter.length).toBeLessThanOrEqual(100);
      reads++;
      return json({
        keywords: filter.map((id) => ({
          keywordId: id,
          campaignId: id,
          adGroupId: id,
          keywordText: 'book',
          matchType: 'EXACT',
          state: 'ENABLED',
          bid: 0.25,
        })),
      });
    });
    const keywords = await new AmazonAdsConnector(config, fetcher).listKeywords(
      Array.from({ length: 501 }, (_, i) => String(i + 1)),
    );
    expect(keywords).toHaveLength(501);
    expect(reads).toBe(6);
  });
  it('rejects a list response that truncates its advertised result count', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/o2/token')) return token();
      return json({ campaigns: [], totalResults: 1 });
    });
    await expect(new AmazonAdsConnector(config, fetcher).listCampaigns()).rejects.toThrow(
      /before returning every/,
    );
  });
  it('discovers profiles without a scope header and keeps Amazon’s actual timezone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/auth/o2/token')) return token();
      expect(
        (init?.headers as Record<string, string>)['Amazon-Advertising-API-Scope'],
      ).toBeUndefined();
      return json([
        {
          profileId: 42,
          countryCode: 'US',
          currencyCode: 'USD',
          timezone: 'America/Los_Angeles',
          accountInfo: { id: 'a', type: 'vendor', name: 'Publisher' },
        },
      ]);
    });
    const profiles = await new AmazonAdsConnector(config, fetcher).listProfiles();
    expect(profiles[0]).toMatchObject({ profileId: '42', timezone: 'America/Los_Angeles' });
  });
  it('coalesces simultaneous token refreshes and fails on unknown platform states', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/o2/token')) return token();
      return json({
        campaigns: [
          {
            campaignId: '9',
            name: 'Book',
            state: 'MYSTERY',
            budget: { budget: 10, budgetType: 'DAILY' },
            targetingType: 'MANUAL',
          },
        ],
      });
    });
    const connector = new AmazonAdsConnector(config, fetcher);
    const results = await Promise.allSettled([
      connector.listCampaigns(),
      connector.listCampaigns(),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith('/auth/o2/token'))).toHaveLength(
      1,
    );
  });
  it('rejects unsafe IDs, missing money, duplicate cells, and out-of-window rows', () => {
    const decode = (rows: unknown[]) =>
      decodeReport(Buffer.from(JSON.stringify(rows)), 'campaign', '2026-09-01', '2026-09-01', 14);
    expect(() => decode([{ ...row(), campaignId: Number.MAX_SAFE_INTEGER + 1 }])).toThrow();
    expect(() => decode([{ ...row(), sales14d: undefined }])).toThrow();
    expect(() => decode([row(), row()])).toThrow(/repeats/);
    expect(() => decode([row('2026-09-02')])).toThrow(/outside/);
    // Raw purchases remain raw, even when they cannot be used by a Bernoulli model.
    expect(decode([{ ...row(), purchases14d: 12 }])[0].purchases).toBe(12);
    expect(reportWindows('2026-07-29', '2026-09-21')).toHaveLength(2);
    expect(() => reportWindows('2026-01-01', '2026-09-21')).toThrow(/95 days/);
  });
  it('only downloads bounded, direct S3 HTTPS payloads', async () => {
    for (const url of [
      'http://reports.s3.amazonaws.com/a',
      'https://localhost/a',
      'https://169.254.169.254/a',
      'https://s3.amazonaws.com.evil.test/a',
      'https://user:pass@reports.s3.amazonaws.com/a',
    ])
      expect(() => validateDownloadUrl(url)).toThrow();
    expect(
      validateDownloadUrl('https://reports.s3.eu-west-1.amazonaws.com/a?signature=test'),
    ).toContain('s3.eu-west-1.amazonaws.com');
    await expect(limitedBody(new Response('12345'), 4)).rejects.toThrow(/size limit/);
  });
});
