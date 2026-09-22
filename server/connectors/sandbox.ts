import type {
  KeywordMatch,
  Observation,
  PlatformAdGroup,
  PlatformCampaign,
  PlatformKeyword,
  PlatformNegativeKeyword,
  PlatformState,
} from '../../shared/types.js';
import {
  ConnectorError,
  normalizeTerm,
  type CampaignUpdate,
  type Connector,
  type KeywordCreate,
  type KeywordUpdate,
  type MutationResult,
  type NegativeCreate,
  type ReportKind,
  type ReportRow,
} from './connector.js';

/**
 * A deterministic simulated Sponsored Products account. It supports the whole
 * connector surface, including writes, so the brain's sync → evaluate →
 * authorize → execute → read-back loop can be exercised end to end without a
 * live advertising account. Performance is derived from a supplied daily
 * campaign history and split into keyword and search-term cells so the parts
 * never exceed the parent totals.
 */
export interface SandboxTerm {
  term: string;
  share: number;
  conversionWeight: number;
}
export interface SandboxKeyword {
  externalId: string;
  text: string;
  matchType: KeywordMatch;
  state: PlatformState;
  bidCents: number;
  shares: { clicks: number; spend: number; orders: number };
  terms: SandboxTerm[];
  createdDate: string | null;
  pausedDate: string | null;
}
export interface SandboxCampaign {
  externalId: string;
  name: string;
  state: PlatformState;
  dailyBudgetCents: number;
  targetingType: 'auto' | 'manual';
  adGroup: { externalId: string; name: string; defaultBidCents: number };
  keywords: SandboxKeyword[];
  negatives: {
    externalId: string;
    text: string;
    matchType: 'negative-exact' | 'negative-phrase';
    state: PlatformState;
  }[];
}
export type SandboxFault = {
  kind: 'timeout' | 'throttled' | 'ambiguous' | 'unavailable';
  remaining: number;
};
export interface SandboxState {
  campaigns: SandboxCampaign[];
  nextId: number;
  fault: SandboxFault | null;
  mutations: { at: string; type: string; payload: unknown }[];
}

export interface SandboxOptions {
  history: (campaignExternalId: string) => Observation[];
  persist: (state: SandboxState) => void;
  today: () => string;
  writesEnabled?: boolean;
}

/** Floor every share except the last, which takes the remainder. */
export function splitWhole(value: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  // Weights that already sum to one are applied directly so cells match the
  // seeded demo split exactly instead of drifting on floating-point division.
  const total = sum === 0 ? 1 : Math.abs(sum - 1) < 1e-9 ? 1 : sum;
  const parts = weights.slice(0, -1).map((w) => Math.floor((value * w) / total));
  const used = parts.reduce((a, b) => a + b, 0);
  parts.push(Math.max(0, value - used));
  return parts;
}

export class SandboxConnector implements Connector {
  readonly kind = 'sandbox' as const;
  readonly writesEnabled: boolean;
  constructor(
    public state: SandboxState,
    private options: SandboxOptions,
  ) {
    this.writesEnabled = options.writesEnabled ?? true;
  }
  /** Faults that stop a request before it reaches the account. */
  private faultBefore() {
    const fault = this.state.fault;
    if (!fault || fault.remaining <= 0 || fault.kind === 'ambiguous') return;
    fault.remaining -= 1;
    this.options.persist(this.state);
    const messages = {
      timeout: 'The simulated platform did not answer within the time limit.',
      throttled: 'The simulated platform is rate limiting requests.',
      unavailable: 'The simulated platform is unavailable.',
    };
    throw new ConnectorError(
      fault.kind,
      messages[fault.kind],
      fault.kind === 'throttled' ? 1000 : null,
    );
  }
  /** A fault that loses the response after the change was applied. */
  private faultAfter() {
    const fault = this.state.fault;
    if (!fault || fault.remaining <= 0 || fault.kind !== 'ambiguous') return;
    fault.remaining -= 1;
    this.options.persist(this.state);
    throw new ConnectorError(
      'ambiguous',
      'The simulated platform accepted the request but the response was lost.',
    );
  }
  private id(prefix: string) {
    const id = `${prefix}-${String(this.state.nextId).padStart(6, '0')}`;
    this.state.nextId += 1;
    return id;
  }
  async listCampaigns(): Promise<PlatformCampaign[]> {
    this.faultBefore();
    return this.state.campaigns.map((c) => ({
      externalId: c.externalId,
      name: c.name,
      state: c.state,
      dailyBudgetCents: c.dailyBudgetCents,
      targetingType: c.targetingType,
    }));
  }
  async listAdGroups(ids: string[]): Promise<PlatformAdGroup[]> {
    this.faultBefore();
    return this.state.campaigns
      .filter((c) => ids.includes(c.externalId))
      .map((c) => ({
        externalId: c.adGroup.externalId,
        campaignExternalId: c.externalId,
        name: c.adGroup.name,
        state: c.state,
        defaultBidCents: c.adGroup.defaultBidCents,
      }));
  }
  async listKeywords(ids: string[]): Promise<PlatformKeyword[]> {
    this.faultBefore();
    return this.state.campaigns
      .filter((c) => ids.includes(c.externalId))
      .flatMap((c) =>
        c.keywords.map((k) => ({
          externalId: k.externalId,
          campaignExternalId: c.externalId,
          adGroupExternalId: c.adGroup.externalId,
          text: k.text,
          matchType: k.matchType,
          state: k.state,
          bidCents: k.bidCents,
        })),
      );
  }
  async listNegativeKeywords(ids: string[]): Promise<PlatformNegativeKeyword[]> {
    this.faultBefore();
    return this.state.campaigns
      .filter((c) => ids.includes(c.externalId))
      .flatMap((c) =>
        c.negatives.map((n) => ({
          externalId: n.externalId,
          campaignExternalId: c.externalId,
          adGroupExternalId: c.adGroup.externalId,
          text: n.text,
          matchType: n.matchType,
          state: n.state,
        })),
      );
  }
  async report(kind: ReportKind, startDate: string, endDate: string): Promise<ReportRow[]> {
    this.faultBefore();
    const rows: ReportRow[] = [];
    for (const campaign of this.state.campaigns) {
      const history = this.options
        .history(campaign.externalId)
        .filter((r) => r.date >= startDate && r.date <= endDate);
      for (const day of history) {
        if (kind === 'campaign') {
          rows.push({
            date: day.date,
            campaignExternalId: campaign.externalId,
            adGroupExternalId: null,
            keywordExternalId: null,
            keywordText: null,
            matchType: null,
            searchTerm: null,
            impressions: day.impressions,
            clicks: day.clicks,
            costCents: day.spendCents,
            purchases: day.orders,
            salesCents: day.salesCents,
          });
          continue;
        }
        const active = campaign.keywords.map((k) => ({
          k,
          live:
            (k.createdDate === null || k.createdDate <= day.date) &&
            (k.pausedDate === null || k.pausedDate > day.date),
        }));
        const clicks = splitWhole(
          day.clicks,
          active.map(({ k, live }) => (live ? k.shares.clicks : 0)),
        );
        const impressions = splitWhole(
          day.impressions,
          active.map(({ k, live }) => (live ? k.shares.clicks : 0)),
        );
        const spend = splitWhole(
          day.spendCents,
          active.map(({ k, live }) => (live ? k.shares.spend : 0)),
        );
        const orders = splitWhole(
          day.orders,
          active.map(({ k, live }) => (live ? k.shares.orders : 0)),
        );
        const unitSale = day.orders > 0 ? day.salesCents / day.orders : 0;
        active.forEach(({ k }, i) => {
          const cell = {
            impressions: impressions[i],
            clicks: Math.min(clicks[i], impressions[i]),
            costCents: spend[i],
            purchases: Math.min(orders[i], clicks[i]),
          };
          if (kind === 'keyword') {
            rows.push({
              date: day.date,
              campaignExternalId: campaign.externalId,
              adGroupExternalId: campaign.adGroup.externalId,
              keywordExternalId: k.externalId,
              keywordText: k.text,
              matchType: k.matchType,
              searchTerm: null,
              ...cell,
              salesCents: Math.round(cell.purchases * unitSale),
            });
            return;
          }
          if (!k.terms.length) return;
          const termClicks = splitWhole(
            cell.clicks,
            k.terms.map((t) => t.share),
          );
          const termImpressions = splitWhole(
            cell.impressions,
            k.terms.map((t) => t.share),
          );
          const termSpend = splitWhole(
            cell.costCents,
            k.terms.map((t) => t.share),
          );
          const termOrders = splitWhole(
            cell.purchases,
            k.terms.map((t) => t.share * t.conversionWeight),
          );
          k.terms.forEach((t, j) => {
            const purchases = Math.min(termOrders[j], termClicks[j]);
            rows.push({
              date: day.date,
              campaignExternalId: campaign.externalId,
              adGroupExternalId: campaign.adGroup.externalId,
              keywordExternalId: k.externalId,
              keywordText: k.text,
              matchType: k.matchType,
              searchTerm: t.term,
              impressions: termImpressions[j],
              clicks: Math.min(termClicks[j], termImpressions[j]),
              costCents: termSpend[j],
              purchases,
              salesCents: Math.round(purchases * unitSale),
            });
          });
        });
      }
    }
    return rows;
  }
  private record(type: string, payload: unknown) {
    this.state.mutations.push({ at: new Date().toISOString(), type, payload });
    this.options.persist(this.state);
  }
  private writable() {
    if (!this.writesEnabled)
      throw new ConnectorError('unsupported', 'Writes are disabled for this connector.');
    this.faultBefore();
  }
  async createKeywords(items: KeywordCreate[]): Promise<MutationResult[]> {
    this.writable();
    const results: MutationResult[] = [];
    items.forEach((item, index) => {
      const campaign = this.state.campaigns.find((c) => c.externalId === item.campaignExternalId);
      if (!campaign || campaign.adGroup.externalId !== item.adGroupExternalId) {
        results.push({
          index,
          ok: false,
          code: 'NOT_FOUND',
          message: 'Unknown campaign or ad group.',
        });
        return;
      }
      const text = normalizeTerm(item.text);
      if (
        campaign.keywords.some(
          (k) => normalizeTerm(k.text) === text && k.matchType === item.matchType,
        )
      ) {
        results.push({
          index,
          ok: false,
          code: 'DUPLICATE_VALUE',
          message: 'Keyword already exists.',
        });
        return;
      }
      if (item.bidCents < 2 || item.bidCents > 100_000) {
        results.push({ index, ok: false, code: 'INVALID_BID', message: 'Bid is out of range.' });
        return;
      }
      // A harvested exact keyword takes over the search term it came from.
      const shares = { clicks: 0, spend: 0, orders: 0 };
      for (const source of campaign.keywords) {
        const term = source.terms.find((t) => normalizeTerm(t.term) === text);
        if (!term) continue;
        const fraction = term.share / (source.terms.reduce((s, t) => s + t.share, 0) || 1);
        const weightTotal = source.terms.reduce((s, t) => s + t.share * t.conversionWeight, 0) || 1;
        const orderFraction = (term.share * term.conversionWeight) / weightTotal;
        shares.clicks += source.shares.clicks * fraction;
        shares.spend += source.shares.spend * fraction;
        shares.orders += source.shares.orders * orderFraction;
        source.shares = {
          clicks: source.shares.clicks * (1 - fraction),
          spend: source.shares.spend * (1 - fraction),
          orders: source.shares.orders * (1 - orderFraction),
        };
        source.terms = source.terms.filter((t) => t !== term);
      }
      const keyword: SandboxKeyword = {
        externalId: this.id('kw'),
        text: item.text.trim(),
        matchType: item.matchType,
        state: 'enabled',
        bidCents: item.bidCents,
        shares,
        terms: [{ term: item.text.trim(), share: 1, conversionWeight: 1 }],
        createdDate: this.options.today(),
        pausedDate: null,
      };
      campaign.keywords.push(keyword);
      results.push({ index, ok: true, externalId: keyword.externalId });
    });
    this.record('createKeywords', items);
    this.faultAfter();
    return results;
  }
  async updateKeywords(items: KeywordUpdate[]): Promise<MutationResult[]> {
    this.writable();
    const results: MutationResult[] = [];
    items.forEach((item, index) => {
      const keyword = this.state.campaigns
        .filter((c) => !item.campaignExternalId || c.externalId === item.campaignExternalId)
        .flatMap((c) => c.keywords)
        .find((k) => k.externalId === item.externalId);
      if (!keyword) {
        results.push({ index, ok: false, code: 'NOT_FOUND', message: 'Unknown keyword.' });
        return;
      }
      if (item.bidCents !== undefined) {
        if (item.bidCents < 2 || item.bidCents > 100_000) {
          results.push({ index, ok: false, code: 'INVALID_BID', message: 'Bid is out of range.' });
          return;
        }
        keyword.bidCents = item.bidCents;
      }
      if (item.state !== undefined) {
        keyword.state = item.state;
        keyword.pausedDate = item.state === 'enabled' ? null : this.options.today();
      }
      results.push({ index, ok: true, externalId: keyword.externalId });
    });
    this.record('updateKeywords', items);
    this.faultAfter();
    return results;
  }
  async createNegativeKeywords(items: NegativeCreate[]): Promise<MutationResult[]> {
    this.writable();
    const results: MutationResult[] = [];
    items.forEach((item, index) => {
      const campaign = this.state.campaigns.find((c) => c.externalId === item.campaignExternalId);
      if (!campaign || campaign.adGroup.externalId !== item.adGroupExternalId) {
        results.push({
          index,
          ok: false,
          code: 'NOT_FOUND',
          message: 'Unknown campaign or ad group.',
        });
        return;
      }
      const text = normalizeTerm(item.text);
      if (campaign.negatives.some((n) => normalizeTerm(n.text) === text)) {
        results.push({
          index,
          ok: false,
          code: 'DUPLICATE_VALUE',
          message: 'Negative keyword already exists.',
        });
        return;
      }
      const negative = {
        externalId: this.id('neg'),
        text: item.text.trim(),
        matchType: item.matchType,
        state: 'enabled' as const,
      };
      campaign.negatives.push(negative);
      // The excluded term stops receiving traffic from tomorrow onward.
      for (const keyword of campaign.keywords) {
        const term = keyword.terms.find((t) => normalizeTerm(t.term) === text);
        if (!term) continue;
        const fraction = term.share / (keyword.terms.reduce((s, t) => s + t.share, 0) || 1);
        keyword.shares = {
          clicks: keyword.shares.clicks * (1 - fraction),
          spend: keyword.shares.spend * (1 - fraction),
          orders: keyword.shares.orders,
        };
        keyword.terms = keyword.terms.filter((t) => t !== term);
      }
      results.push({ index, ok: true, externalId: negative.externalId });
    });
    this.record('createNegativeKeywords', items);
    this.faultAfter();
    return results;
  }
  async updateCampaigns(items: CampaignUpdate[]): Promise<MutationResult[]> {
    this.writable();
    const results: MutationResult[] = [];
    items.forEach((item, index) => {
      const campaign = this.state.campaigns.find((c) => c.externalId === item.externalId);
      if (!campaign) {
        results.push({ index, ok: false, code: 'NOT_FOUND', message: 'Unknown campaign.' });
        return;
      }
      if (item.dailyBudgetCents !== undefined) {
        if (item.dailyBudgetCents < 100) {
          results.push({
            index,
            ok: false,
            code: 'INVALID_BUDGET',
            message: 'Budget below the platform minimum.',
          });
          return;
        }
        campaign.dailyBudgetCents = item.dailyBudgetCents;
      }
      if (item.state !== undefined) campaign.state = item.state;
      results.push({ index, ok: true, externalId: campaign.externalId });
    });
    this.record('updateCampaigns', items);
    this.faultAfter();
    return results;
  }
}

/**
 * A synthetic book advertiser. Keyword identities match the demo target cells
 * so synced keyword facts line up with the existing target explorer and test
 * waves. Search terms are invented; none refer to a real title.
 */
export function sandboxSpec(
  campaigns: { externalId: string; name: string; dailyBudgetCents: number }[],
): SandboxState {
  let next = 1;
  const id = (prefix: string) => `${prefix}-${String(next++).padStart(6, '0')}`;
  const termSets: SandboxTerm[][] = [
    [
      { term: 'nature writing', share: 0.3, conversionWeight: 1.3 },
      { term: 'nature essays', share: 0.2, conversionWeight: 1.4 },
      { term: 'books about nature', share: 0.16, conversionWeight: 1.1 },
      { term: 'free nature wallpapers', share: 0.14, conversionWeight: 0 },
      { term: 'nature documentary streaming', share: 0.12, conversionWeight: 0 },
      { term: 'nature journal notebook', share: 0.08, conversionWeight: 0.4 },
    ],
    [{ term: 'books about slow living', share: 1, conversionWeight: 1 }],
    [
      { term: 'outdoor essays', share: 0.45, conversionWeight: 1.2 },
      { term: 'hiking memoir', share: 0.3, conversionWeight: 1.5 },
      { term: 'outdoor gear reviews', share: 0.25, conversionWeight: 0 },
    ],
  ];
  return {
    nextId: 1000,
    fault: null,
    mutations: [],
    campaigns: campaigns.map((c) => ({
      externalId: c.externalId,
      name: c.name,
      state: 'enabled',
      dailyBudgetCents: c.dailyBudgetCents,
      targetingType: 'manual',
      adGroup: { externalId: id('ag'), name: `${c.name} · ad group`, defaultBidCents: 45 },
      negatives: [],
      keywords: (
        [
          ['sample-cell-1', 'nature writing', 'broad', 42, [0.4, 0.32, 0.65]],
          ['sample-cell-2', 'books about slow living', 'exact', 55, [0.35, 0.35, 0.25]],
          ['sample-cell-3', 'outdoor essays', 'phrase', 38, [0.25, 0.33, 0.1]],
        ] as const
      ).map(([externalId, text, matchType, bidCents, [clicks, spend, orders]], i) => ({
        externalId,
        text,
        matchType,
        state: 'enabled' as const,
        bidCents,
        shares: { clicks, spend, orders },
        terms: termSets[i].map((t) => ({ ...t })),
        createdDate: null,
        pausedDate: null,
      })),
    })),
  };
}
