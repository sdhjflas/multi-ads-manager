import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { ConnectorError, type ReportKind, type ReportRow } from './connector.js';
import { dateOnly } from '../validation.js';

export const amazonId = z
  .union([z.string().regex(/^\d{1,30}$/), z.number().int().nonnegative().safe()])
  .transform(String);
const count = z.number().int().nonnegative().max(100_000_000);
const amount = z.number().finite().nonnegative().max(1_000_000);
export const reportMediaType = 'application/vnd.createasyncreportrequest.v3+json';
export interface AmazonReportJob {
  key: string;
  kind: ReportKind;
  startDate: string;
  endDate: string;
  attributionDays: number;
  status: 'creating' | 'pending' | 'complete' | 'failed' | 'uncertain';
  reportId: string | null;
  createdAt: string;
  updatedAt: string;
  generatedAt: string | null;
  nextAttemptAt: string;
  attempts: number;
  message: string;
  rows: number;
}
export interface ReportCache {
  get(key: string): { job: AmazonReportJob; rows: ReportRow[] | null } | null;
  set(job: AmazonReportJob, rows?: ReportRow[]): void;
}
export class MemoryReportCache implements ReportCache {
  private jobs = new Map<string, { job: AmazonReportJob; rows: ReportRow[] | null }>();
  get(key: string) {
    return this.jobs.get(key) || null;
  }
  set(job: AmazonReportJob, rows?: ReportRow[]) {
    this.jobs.set(job.key, { job: { ...job }, rows: rows ?? null });
  }
}

export function reportWindows(
  start: string,
  end: string,
): { startDate: string; endDate: string }[] {
  if (
    !dateOnly(start) ||
    !dateOnly(end) ||
    start > end ||
    (Date.parse(end) - Date.parse(start)) / 86400000 >= 95
  )
    throw new ConnectorError('invalid', 'Use an ordered reporting window of at most 95 days.');
  const windows = [];
  for (let cursor = Date.parse(start); cursor <= Date.parse(end); cursor += 31 * 86400000)
    windows.push({
      startDate: new Date(cursor).toISOString().slice(0, 10),
      endDate: new Date(Math.min(cursor + 30 * 86400000, Date.parse(end)))
        .toISOString()
        .slice(0, 10),
    });
  return windows;
}

export function reportConfiguration(kind: ReportKind, attributionDays: number) {
  if (![1, 7, 14, 30].includes(attributionDays))
    throw new ConnectorError(
      'unsupported',
      'Amazon reporting supports 1, 7, 14, or 30 day attribution windows.',
    );
  const common = [
    'date',
    'campaignId',
    'impressions',
    'clicks',
    'cost',
    `purchases${attributionDays}d`,
    `sales${attributionDays}d`,
  ];
  const configuration =
    kind === 'campaign'
      ? { reportTypeId: 'spCampaigns', groupBy: ['campaign'], columns: common }
      : kind === 'advertisedProduct'
        ? {
            reportTypeId: 'spAdvertisedProduct',
            groupBy: ['advertiser'],
            columns: [
              ...common,
              'adGroupId',
              'adId',
              'advertisedAsin',
              `purchasesSameSku${attributionDays}d`,
              `unitsSoldSameSku${attributionDays}d`,
              `attributedSalesSameSku${attributionDays}d`,
            ],
          }
        : {
            reportTypeId: kind === 'keyword' ? 'spTargeting' : 'spSearchTerm',
            groupBy: [kind === 'keyword' ? 'targeting' : 'searchTerm'],
            columns: [
              ...common,
              'adGroupId',
              'keywordId',
              'keyword',
              'matchType',
              ...(kind === 'searchTerm' ? ['searchTerm'] : []),
            ],
            filters: [{ field: 'keywordType', values: ['BROAD', 'PHRASE', 'EXACT'] }],
          };
  return {
    adProduct: 'SPONSORED_PRODUCTS',
    timeUnit: 'DAILY',
    format: 'GZIP_JSON',
    ...configuration,
  };
}

export const reportJobKey = (
  scope: string,
  kind: ReportKind,
  startDate: string,
  endDate: string,
  attributionDays: number,
) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        scope,
        kind,
        startDate,
        endDate,
        configuration: reportConfiguration(kind, attributionDays),
        version: 2,
      }),
    )
    .digest('hex');

export async function limitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes)
    throw new ConnectorError('invalid', 'Amazon response exceeds the size limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new ConnectorError('invalid', 'Amazon returned an empty response body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new ConnectorError('invalid', 'Amazon response exceeds the size limit.');
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return Buffer.concat(chunks);
}

export function validateDownloadUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError('invalid', 'Invalid Amazon report download address.');
  }
  // Reporting v3 returns S3 presigned URLs. Never forward Ads credentials or follow redirects.
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !/^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
  )
    throw new ConnectorError(
      'invalid',
      'Report downloads must use a direct Amazon S3 HTTPS address.',
    );
  return url.href;
}

export function decodeReport(
  raw: Buffer,
  kind: ReportKind,
  startDate: string,
  endDate: string,
  attributionDays: number,
): ReportRow[] {
  let payload: unknown;
  try {
    const bytes =
      raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: 100_000_000 }) : raw;
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ConnectorError(
      'invalid',
      'The report is invalid JSON or exceeds the decompressed size limit.',
    );
  }
  if (!Array.isArray(payload) || payload.length > 200000)
    throw new ConnectorError('invalid', 'Expected an array with at most 200,000 report rows.');
  const purchases = `purchases${attributionDays}d`,
    sales = `sales${attributionDays}d`;
  const shape = z.object({
    date: z.string().refine(dateOnly),
    campaignId: amazonId,
    impressions: count,
    clicks: count,
    cost: amount,
  });
  const keys = new Set<string>();
  return payload.map((rawRow, index) => {
    const parsed = shape.safeParse(rawRow);
    if (!parsed.success)
      throw new ConnectorError(
        'invalid',
        `Report row ${index + 1} has missing, malformed, or unsafe numeric fields.`,
      );
    const r = rawRow as Record<string, unknown>;
    if (parsed.data.date < startDate || parsed.data.date > endDate)
      throw new ConnectorError('invalid', 'A report row falls outside the requested dates.');
    const optionalId = (name: string) =>
      r[name] === undefined || r[name] === null ? null : amazonId.parse(r[name]);
    const result: ReportRow = {
      date: parsed.data.date,
      campaignExternalId: parsed.data.campaignId,
      adGroupExternalId: optionalId('adGroupId'),
      keywordExternalId: optionalId('keywordId'),
      keywordText: r.keyword === undefined ? null : z.string().max(1000).parse(r.keyword),
      matchType:
        r.matchType === undefined
          ? null
          : (z.enum(['EXACT', 'PHRASE', 'BROAD']).parse(r.matchType).toLowerCase() as
              'exact' | 'phrase' | 'broad'),
      searchTerm:
        r.searchTerm === undefined ? null : z.string().min(1).max(1000).parse(r.searchTerm),
      impressions: parsed.data.impressions as number,
      clicks: parsed.data.clicks,
      costCents: Math.round(parsed.data.cost * 100),
      purchases: count.parse(r[purchases]),
      salesCents: Math.round(amount.parse(r[sales]) * 100),
    };
    if (
      (kind === 'keyword' || kind === 'searchTerm') &&
      (!result.adGroupExternalId ||
        !result.keywordExternalId ||
        !result.keywordText ||
        !result.matchType)
    )
      throw new ConnectorError('invalid', 'Keyword reporting identity is incomplete.');
    if (kind === 'searchTerm' && !result.searchTerm)
      throw new ConnectorError('invalid', 'Search-term text is missing.');
    if (kind === 'advertisedProduct') {
      result.advertisedAsin = z
        .string()
        .regex(/^[A-Z0-9]{10}$/)
        .parse(r.advertisedAsin);
      result.adExternalId = amazonId.parse(r.adId);
      result.sameSkuPurchases = count.parse(r[`purchasesSameSku${attributionDays}d`]);
      result.sameSkuUnits = count.parse(r[`unitsSoldSameSku${attributionDays}d`]);
      result.sameSkuSalesCents = Math.round(
        amount.parse(r[`attributedSalesSameSku${attributionDays}d`]) * 100,
      );
      if (
        result.sameSkuPurchases > result.purchases ||
        result.sameSkuUnits < result.sameSkuPurchases ||
        result.sameSkuSalesCents > result.salesCents
      )
        throw new ConnectorError(
          'invalid',
          'Same-SKU purchase, unit, or sales counts do not reconcile with the total report.',
        );
    }
    const key = JSON.stringify([
      result.date,
      result.campaignExternalId,
      result.adGroupExternalId,
      result.keywordExternalId,
      result.searchTerm,
      result.adExternalId,
    ]);
    if (keys.has(key))
      throw new ConnectorError(
        'invalid',
        'The report repeats a reporting cell. No rows were imported.',
      );
    keys.add(key);
    return result;
  });
}
