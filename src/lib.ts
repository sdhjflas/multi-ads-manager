import type { Channel, DecisionKind } from '../shared/types';

export const money = (cents: number | null, digits = 0) =>
  cents === null
    ? 'Unverified'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(cents / 100);
export const number = (n: number) => new Intl.NumberFormat('en-US').format(n);
export const percent = (n: number | null, digits = 1) =>
  n === null ? '—' : `${(n * 100).toFixed(digits)}%`;
export const date = (d: string) =>
  new Date(d.length === 10 ? `${d}T12:00:00Z` : d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
export const timeAgo = (d: string) => {
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(d)) / 60000));
  return min < 1
    ? 'Just now'
    : min < 60
      ? `${min}m ago`
      : min < 1440
        ? `${Math.floor(min / 60)}h ago`
        : `${Math.floor(min / 1440)}d ago`;
};
export const channelName: Record<Channel, string> = {
  meta: 'Meta Ads',
  amazon: 'Amazon Ads',
  tiktok: 'TikTok Ads',
};
export const decisionLabel: Record<DecisionKind, string> = {
  scale: 'Scale candidate',
  reduce: 'Needs attention',
  explore: 'Exploring',
  hold: 'Gathering data',
  repair: 'Evidence needed',
};

export async function api<T>(
  path: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(
    `/api${path}`,
    body === undefined
      ? { signal }
      : {
          method,
          signal,
          headers: { 'Content-Type': 'application/json', 'X-Orbit-Request': '1' },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'The request could not be completed.');
  return data as T;
}

export function dollarInput(value: FormDataEntryValue | null): number {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw new Error('Use dollar amounts with up to two decimal places.');
  return Math.round(Number(s) * 100);
}
