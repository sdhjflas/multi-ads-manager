import { parse } from 'csv-parse/sync';
import type { z } from 'zod';
import type { Campaign, Observation } from '../shared/types.js';
import { AppError, dateOnly, importInput } from './validation.js';
import { dayAt } from './engine.js';

const canonical = [
  'date',
  'impressions',
  'clicks',
  'orders',
  'spend_cents',
  'sales_cents',
  'refunds_cents',
];
function whole(value: unknown, label: string): number {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) throw new AppError(`${label} must be a nonnegative whole number.`);
  const number = Number(s);
  if (!Number.isSafeInteger(number) || number > 100_000_000)
    throw new AppError(`${label} is out of range.`);
  return number;
}
function money(value: unknown, label: string): number {
  const s = String(value ?? '')
    .trim()
    .replace(/^\$/, '')
    .replaceAll(',', '');
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw new AppError(`${label} must contain USD with at most two decimal places.`);
  const [dollars, decimal = ''] = s.split('.');
  return whole(String(Number(dollars) * 100 + Number(decimal.padEnd(2, '0'))), label);
}

export function parseImport(
  input: z.infer<typeof importInput>,
  campaign: Campaign,
  now = new Date(),
): Observation[] {
  if (input.dataset !== campaign.dataset || input.campaignId !== campaign.id)
    throw new AppError('Campaign and workspace do not match.');
  if (input.attributionDays !== campaign.attributionDays)
    throw new AppError(
      'Attribution window differs from the campaign. Create a separate campaign for a different reporting definition.',
    );
  if (input.format === 'amazon' && campaign.channel !== 'amazon')
    throw new AppError('Amazon exports require an Amazon campaign.');
  const exported = Date.parse(input.exportedAt);
  if (!Number.isFinite(exported) || exported > now.getTime() + 300_000)
    throw new AppError('Export time must not be in the future.');
  let data: Record<string, string>[];
  let headers: string[] = [];
  try {
    data = parse(input.csv, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      columns: (names: string[]) => {
        headers = names;
        if (new Set(names).size !== names.length) throw new Error('Duplicate headers.');
        return names;
      },
      max_record_size: 20_000,
    }) as Record<string, string>[];
  } catch {
    throw new AppError(
      'Invalid CSV. Use unique headers, comma delimiters, and quoted values containing commas.',
    );
  }
  if (!data.length || data.length > 2000)
    throw new AppError('Import between 1 and 2,000 daily rows.');
  if (headers.some((h) => /email|phone|customer|address|session|order.?id|ip.?address/i.test(h)))
    throw new AppError(
      'Only aggregate performance data is supported. Remove personal or order-level fields.',
    );
  const required =
    input.format === 'canonical'
      ? canonical
      : [
          'Date',
          'Campaign Name',
          'Impressions',
          'Clicks',
          'Spend',
          `${input.attributionDays} Day Total Orders (#)`,
          `${input.attributionDays} Day Total Sales`,
        ];
  if (required.some((key) => !headers.includes(key)))
    throw new AppError(`Missing columns. Required: ${required.join(', ')}.`);
  if (input.format === 'canonical' && headers.some((key) => !canonical.includes(key)))
    throw new AppError('The normalized template accepts only its seven documented columns.');
  const seen = new Set<string>();
  return data.map((r, i) => {
    const label = `Row ${i + 2}`;
    const isAmazon = input.format === 'amazon';
    if (isAmazon && r['Campaign Name'] !== campaign.name)
      throw new AppError(`${label}: campaign name differs from the selected campaign.`);
    let date = r[isAmazon ? 'Date' : 'date'];
    if (isAmazon && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)) {
      const [month, day, year] = date.split('/');
      date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    if (!dateOnly(date) || date >= dayAt(now) || date > dayAt(new Date(input.exportedAt)))
      throw new AppError(
        `${label}: use a completed reporting date in YYYY-MM-DD format, no later than export time.`,
      );
    if (date < dayAt(now, -730))
      throw new AppError(`${label}: this local release accepts the last two years.`);
    if (seen.has(date))
      throw new AppError(
        `${label}: duplicate campaign/date. Use a campaign-level daily report, without keyword or placement breakdowns.`,
      );
    seen.add(date);
    const result: Observation = {
      campaignId: campaign.id,
      date,
      impressions: whole(r[isAmazon ? 'Impressions' : 'impressions'], `${label} impressions`),
      clicks: whole(r[isAmazon ? 'Clicks' : 'clicks'], `${label} clicks`),
      orders: whole(
        r[isAmazon ? `${input.attributionDays} Day Total Orders (#)` : 'orders'],
        `${label} orders`,
      ),
      spendCents: isAmazon
        ? money(r.Spend, `${label} spend`)
        : whole(r.spend_cents, `${label} spend_cents`),
      salesCents: isAmazon
        ? money(r[`${input.attributionDays} Day Total Sales`], `${label} sales`)
        : whole(r.sales_cents, `${label} sales_cents`),
      refundsCents: isAmazon ? 0 : whole(r.refunds_cents, `${label} refunds_cents`),
      observedAt: input.exportedAt,
    };
    if (
      result.clicks > result.impressions ||
      result.orders > result.clicks ||
      (result.spendCents > 0 && result.clicks === 0)
    )
      throw new AppError(
        `${label}: inconsistent funnel. This model supports click-attributed purchase events, not units, views, or CPM campaigns.`,
      );
    return result;
  });
}

export const importTemplate = `${canonical.join(',')}\n`;
