import { z } from 'zod';
import { ConnectorError, type ReportKind, type ReportRow } from './connector.js';
import {
  decodeReport,
  limitedBody,
  reportConfiguration,
  reportJobKey,
  reportMediaType,
  reportWindows,
  validateDownloadUrl,
  type AmazonReportJob,
  type ReportCache,
} from './amazon-reports.js';

type Call = (
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  media: string,
  write: boolean,
) => Promise<unknown>;
const responseSchema = z.object({
  reportId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
  url: z.string().nullable().optional(),
  generatedAt: z.string().nullable().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  configuration: z
    .object({
      adProduct: z.string(),
      reportTypeId: z.string(),
      groupBy: z.array(z.string()),
      columns: z.array(z.string()),
      timeUnit: z.string(),
      format: z.string(),
      filters: z
        .array(z.object({ field: z.string(), values: z.array(z.string()) }))
        .nullable()
        .optional(),
    })
    .optional(),
});

function verifyRemote(
  remote: z.infer<typeof responseSchema>,
  kind: ReportKind,
  startDate: string,
  endDate: string,
  attributionDays: number,
) {
  const expected = reportConfiguration(kind, attributionDays),
    config = remote.configuration;
  const same = (a: string[], b: string[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const expectedFilters = 'filters' in expected ? expected.filters : [];
  const filters = (items: { field: string; values: string[] }[] | undefined | null) =>
    JSON.stringify(
      (items || [])
        .map((f) => ({ field: f.field, values: [...f.values].sort() }))
        .sort((a, b) => a.field.localeCompare(b.field)),
    );
  if (
    remote.startDate !== startDate ||
    remote.endDate !== endDate ||
    !config ||
    config.adProduct !== expected.adProduct ||
    config.reportTypeId !== expected.reportTypeId ||
    config.timeUnit !== expected.timeUnit ||
    config.format !== expected.format ||
    !same(config.groupBy, expected.groupBy) ||
    !same(config.columns, expected.columns) ||
    filters(config.filters) !== filters(expectedFilters)
  )
    throw new ConnectorError(
      'invalid',
      'The saved Amazon report does not match the requested dates, grain, columns, or filters.',
    );
}

export async function collectReport(options: {
  scope: string;
  kind: ReportKind;
  startDate: string;
  endDate: string;
  attributionDays: number;
  cache: ReportCache;
  call: Call;
  fetcher: typeof fetch;
  now: () => number;
}): Promise<ReportRow[]> {
  const { scope, kind, attributionDays, cache, call, fetcher, now } = options;
  const result: ReportRow[] = [];
  let waiting = false;
  for (const window of reportWindows(options.startDate, options.endDate)) {
    const key = reportJobKey(scope, kind, window.startDate, window.endDate, attributionDays);
    const saved = cache.get(key);
    let job: AmazonReportJob = saved?.job ?? {
      key,
      kind,
      ...window,
      attributionDays,
      status: 'creating',
      reportId: null,
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      generatedAt: null,
      nextAttemptAt: new Date(now()).toISOString(),
      attempts: 0,
      message: 'Ready to request.',
      rows: 0,
    };
    if (job.status === 'complete' && saved?.rows) {
      result.push(...saved.rows);
      continue;
    }
    if (job.status === 'failed' || job.status === 'uncertain')
      throw new ConnectorError(
        'invalid',
        `Report ${job.key.slice(0, 10)} needs review: ${job.message}`,
      );
    if (Date.parse(job.nextAttemptAt) > now()) {
      waiting = true;
      continue;
    }
    // A crash during POST is an unknown outcome. Never silently create a second job.
    if (saved && job.status === 'creating' && !job.reportId) {
      job = {
        ...job,
        status: 'uncertain',
        message: 'Report creation was interrupted. Check Amazon for the report ID before retrying.',
        updatedAt: new Date(now()).toISOString(),
      };
      cache.set(job);
      throw new ConnectorError('ambiguous', job.message);
    }
    try {
      let remote: z.infer<typeof responseSchema>;
      if (!job.reportId) {
        job.status = 'creating';
        cache.set(job);
        remote = responseSchema.parse(
          await call(
            'POST',
            '/reporting/reports',
            {
              name: `Orbit ${kind} ${window.startDate} ${window.endDate}`,
              ...window,
              configuration: reportConfiguration(kind, attributionDays),
            },
            reportMediaType,
            true,
          ),
        );
        job.reportId = remote.reportId;
      } else {
        remote = responseSchema.parse(
          await call(
            'GET',
            `/reporting/reports/${job.reportId}`,
            undefined,
            reportMediaType,
            false,
          ),
        );
        verifyRemote(remote, kind, window.startDate, window.endDate, attributionDays);
      }
      if (remote.reportId !== job.reportId)
        throw new ConnectorError('invalid', 'Amazon returned a different report identity.');
      job.attempts++;
      job.updatedAt = new Date(now()).toISOString();
      if (remote.status === 'FAILED') {
        job.status = 'failed';
        job.message =
          'Amazon could not generate this report. Check the report configuration and account access.';
        cache.set(job);
        throw new ConnectorError('invalid', job.message);
      }
      if (remote.status !== 'COMPLETED') {
        if (now() - Date.parse(job.createdAt) >= 3 * 3_600_000) {
          job.status = 'failed';
          job.message =
            'Amazon did not finish this report within three hours. Review it before requesting another copy.';
          job.updatedAt = new Date(now()).toISOString();
          cache.set(job);
          throw new ConnectorError('invalid', job.message);
        }
        job.status = 'pending';
        job.message = 'Amazon is generating this report. It can take up to three hours.';
        job.nextAttemptAt = new Date(
          now() + Math.min(300000, 30000 * 2 ** Math.min(job.attempts, 4)),
        ).toISOString();
        cache.set(job);
        waiting = true;
        continue;
      }
      verifyRemote(remote, kind, window.startDate, window.endDate, attributionDays);
      if (
        !remote.url ||
        !remote.generatedAt ||
        !Number.isFinite(Date.parse(remote.generatedAt)) ||
        Date.parse(remote.generatedAt) > now() + 300000
      )
        throw new ConnectorError(
          'invalid',
          'Completed report is missing its download address or valid generation timestamp.',
        );
      const address = validateDownloadUrl(remote.url);
      let download: Response;
      try {
        download = await fetcher(address, {
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        });
      } catch {
        throw new ConnectorError(
          'unavailable',
          'Report download was interrupted. Its saved report ID will be polled again.',
        );
      }
      if (!download.ok)
        throw new ConnectorError(
          'unavailable',
          `Report download returned HTTP ${download.status}; its status will be checked again.`,
        );
      const rows = decodeReport(
        await limitedBody(download, 25_000_000),
        kind,
        window.startDate,
        window.endDate,
        attributionDays,
      ).map((r) => ({ ...r, observedAt: new Date(remote.generatedAt!).toISOString() }));
      job = {
        ...job,
        status: 'complete',
        generatedAt: new Date(remote.generatedAt).toISOString(),
        message: 'Validated report saved.',
        rows: rows.length,
        updatedAt: new Date(now()).toISOString(),
      };
      cache.set(job, rows);
      result.push(...rows);
    } catch (error) {
      const err =
        error instanceof ConnectorError
          ? error
          : new ConnectorError(
              'invalid',
              'Amazon report response did not match its documented contract.',
            );
      if (job.status !== 'failed') {
        const creating = !job.reportId;
        job.status = creating
          ? err.kind === 'throttled'
            ? 'pending'
            : err.kind === 'auth' || err.kind === 'invalid'
              ? 'failed'
              : 'uncertain'
          : err.kind === 'invalid'
            ? 'failed'
            : 'pending';
        job.message = err.message;
        job.updatedAt = new Date(now()).toISOString();
        job.nextAttemptAt = new Date(now() + Math.max(60000, err.retryAfterMs || 0)).toISOString();
        cache.set(job);
      }
      throw err;
    }
  }
  if (waiting)
    throw new ConnectorError(
      'pending',
      'Amazon reports are queued. Progress is saved; synchronize again after the next polling time.',
      60000,
    );
  return result;
}
