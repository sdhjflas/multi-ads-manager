import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { AmazonAdsConnector, amazonConfigFromEnv } from '../server/connectors/amazon.js';
import { reportConfiguration } from '../server/connectors/amazon-reports.js';
import { ConnectorError } from '../server/connectors/connector.js';

const config = {
  clientId: 'client',
  clientSecret: 'secret',
  refreshToken: 'refresh',
  profileId: '42',
  region: 'NA' as const,
  writesEnabled: true,
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const token = () => json({ access_token: 'access', expires_in: 3600 });

function connector(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation((url, init) => Promise.resolve(handler(String(url), init || {})));
  let clock = Date.parse('2026-09-22T12:00:00Z');
  const c = new AmazonAdsConnector(
    config,
    fetcher,
    () => clock,
    async () => {
      clock += 20_000;
    },
  );
  return {
    c,
    fetcher,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('Amazon Ads adapter', () => {
  it('reads config from the environment and disables writes by default', () => {
    vi.stubEnv('AMAZON_ADS_CLIENT_ID', 'a');
    vi.stubEnv('AMAZON_ADS_CLIENT_SECRET', 'b');
    vi.stubEnv('AMAZON_ADS_REFRESH_TOKEN', 'c');
    vi.stubEnv('AMAZON_ADS_REGION', 'eu');
    const parsed = amazonConfigFromEnv('7');
    expect(parsed).toEqual(
      expect.objectContaining({ region: 'EU', profileId: '7', writesEnabled: false }),
    );
    vi.unstubAllEnvs();
    expect(amazonConfigFromEnv('7')).toBeNull();
  });
  it('refreshes the token once, scopes every request to the profile, and normalizes keyword state', async () => {
    const { c, fetcher } = connector((url, init) => {
      if (url.endsWith('/auth/o2/token')) {
        expect(String(init.body)).toContain('grant_type=refresh_token');
        return token();
      }
      const headers = init.headers as Record<string, string>;
      expect(headers['Amazon-Advertising-API-Scope']).toBe('42');
      expect(headers.Authorization).toBe('Bearer access');
      if (url.endsWith('/sp/keywords/list'))
        return json({
          keywords: [
            {
              keywordId: 1,
              campaignId: 9,
              adGroupId: 5,
              keywordText: 'soap bar',
              matchType: 'EXACT',
              state: 'PAUSED',
              bid: 0.35,
            },
          ],
        });
      if (url.endsWith('/sp/campaigns/list'))
        return json({
          campaigns: [
            {
              campaignId: 9,
              name: 'C',
              state: 'ENABLED',
              budget: { budget: 12.5, budgetType: 'DAILY' },
              targetingType: 'MANUAL',
            },
          ],
        });
      return json({}, 404);
    });
    const keywords = await c.listKeywords(['9']);
    expect(keywords).toEqual([
      {
        externalId: '1',
        campaignExternalId: '9',
        adGroupExternalId: '5',
        text: 'soap bar',
        matchType: 'exact',
        state: 'paused',
        bidCents: 35,
      },
    ]);
    const campaigns = await c.listCampaigns();
    expect(campaigns[0]).toEqual({
      externalId: '9',
      name: 'C',
      state: 'enabled',
      dailyBudgetCents: 1250,
      targetingType: 'manual',
    });
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith('/auth/o2/token'))).toHaveLength(
      1,
    );
  });
  it('creates, polls, downloads, and decodes a gzip search-term report', async () => {
    let polls = 0;
    const rows = [
      {
        date: '2026-09-01',
        campaignId: 9,
        adGroupId: 5,
        keywordId: 1,
        keyword: 'soap',
        matchType: 'BROAD',
        searchTerm: 'soap bar',
        impressions: 100,
        clicks: 10,
        cost: 3.21,
        purchases14d: 1,
        sales14d: 19.99,
      },
    ];
    const { c, fetcher, advance } = connector((url, init) => {
      if (url.endsWith('/auth/o2/token')) return token();
      if (url.endsWith('/reporting/reports') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body.configuration.reportTypeId).toBe('spSearchTerm');
        expect(body.configuration.columns).toContain('purchases14d');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe(
          'application/vnd.createasyncreportrequest.v3+json',
        );
        return json({ reportId: 'r1', status: 'PENDING', url: null, failureReason: null });
      }
      if (url.endsWith('/reporting/reports/r1')) {
        polls += 1;
        return json({
          reportId: 'r1',
          startDate: '2026-09-01',
          endDate: '2026-09-01',
          configuration: reportConfiguration('searchTerm', 14),
          status: polls < 2 ? 'PROCESSING' : 'COMPLETED',
          url: polls < 2 ? null : 'https://reports.s3.amazonaws.com/r1.gz',
          generatedAt: '2026-09-22T12:00:00Z',
        });
      }
      if (url === 'https://reports.s3.amazonaws.com/r1.gz')
        return new Response(gzipSync(Buffer.from(JSON.stringify(rows))), { status: 200 });
      return json({}, 404);
    });
    await expect(c.report('searchTerm', '2026-09-01', '2026-09-01', 14)).rejects.toMatchObject({
      kind: 'pending',
    });
    advance(60000);
    await expect(c.report('searchTerm', '2026-09-01', '2026-09-01', 14)).rejects.toMatchObject({
      kind: 'pending',
    });
    advance(120000);
    const report = await c.report('searchTerm', '2026-09-01', '2026-09-01', 14);
    expect(report).toEqual([
      {
        date: '2026-09-01',
        campaignExternalId: '9',
        adGroupExternalId: '5',
        keywordExternalId: '1',
        keywordText: 'soap',
        matchType: 'broad',
        searchTerm: 'soap bar',
        impressions: 100,
        clicks: 10,
        costCents: 321,
        purchases: 1,
        salesCents: 1999,
        observedAt: '2026-09-22T12:00:00.000Z',
      },
    ]);
    expect(fetcher).toHaveBeenCalled();
    await expect(c.report('campaign', '2026-09-01', '2026-09-01', 3)).rejects.toThrow(
      /attribution/,
    );
  });
  it('classifies throttling, auth failures, and lost write responses', async () => {
    const { c } = connector((url) => {
      if (url.endsWith('/auth/o2/token')) return token();
      if (url.endsWith('/sp/campaigns/list'))
        return json({ message: 'slow down' }, 429, { 'retry-after': '1' });
      if (url.endsWith('/sp/negativeKeywords/list')) return json({}, 401);
      throw new Error('network down');
    });
    await expect(c.listCampaigns()).rejects.toMatchObject({ kind: 'throttled' });
    await expect(c.listNegativeKeywords(['9'])).rejects.toMatchObject({ kind: 'auth' });
    await expect(c.updateKeywords([{ externalId: '1', bidCents: 40 }])).rejects.toMatchObject({
      kind: 'ambiguous',
    });
    await expect(c.listAdGroups(['9'])).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('sends exact v3 mutation bodies and maps per-item results', async () => {
    const { c } = connector((url, init) => {
      if (url.endsWith('/auth/o2/token')) return token();
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/sp/keywords') && init.method === 'PUT') {
        expect(body).toEqual({
          keywords: [
            { keywordId: '1', bid: 0.4 },
            { keywordId: '2', state: 'PAUSED' },
          ],
        });
        return json({
          keywords: {
            success: [{ index: 0, keywordId: '1' }],
            error: [
              {
                index: 1,
                errors: [
                  {
                    errorType: 'entityNotFoundError',
                    errorValue: { entityNotFoundError: { message: 'gone' } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (url.endsWith('/sp/negativeKeywords') && init.method === 'POST') {
        expect(body.negativeKeywords[0]).toEqual({
          campaignId: '9',
          adGroupId: '5',
          keywordText: 'free',
          matchType: 'NEGATIVE_EXACT',
          state: 'ENABLED',
        });
        return json({
          negativeKeywords: { success: [{ index: 0, negativeKeywordId: '77' }], error: [] },
        });
      }
      if (url.endsWith('/sp/campaigns') && init.method === 'PUT') {
        expect(body.campaigns[0]).toEqual({
          campaignId: '9',
          budget: { budgetType: 'DAILY', budget: 15 },
        });
        return json({ campaigns: { success: [{ index: 0, campaignId: '9' }], error: [] } });
      }
      return json({}, 404);
    });
    const results = await c.updateKeywords([
      { externalId: '1', bidCents: 40 },
      { externalId: '2', state: 'paused' },
    ]);
    expect(results).toEqual([
      { index: 0, ok: true, externalId: '1' },
      { index: 1, ok: false, code: 'entityNotFoundError', message: 'gone' },
    ]);
    expect(
      await c.createNegativeKeywords([
        {
          campaignExternalId: '9',
          adGroupExternalId: '5',
          text: 'free',
          matchType: 'negative-exact',
        },
      ]),
    ).toEqual([{ index: 0, ok: true, externalId: '77' }]);
    expect(await c.updateCampaigns([{ externalId: '9', dailyBudgetCents: 1500 }])).toEqual([
      { index: 0, ok: true, externalId: '9' },
    ]);
    const readOnly = new AmazonAdsConnector(
      { ...config, writesEnabled: false },
      vi.fn<typeof fetch>(),
    );
    await expect(
      readOnly.updateCampaigns([{ externalId: '9', dailyBudgetCents: 1500 }]),
    ).rejects.toBeInstanceOf(ConnectorError);
  });
  it('treats incomplete or malformed write acknowledgements as ambiguous', async () => {
    const responses = [
      { keywords: { success: [{ index: 0 }], error: [] } },
      { keywords: { success: [{ index: 0, keywordId: '1' }], error: [] } },
      {
        keywords: {
          success: [
            { index: 0, keywordId: '1' },
            { index: 0, keywordId: '2' },
          ],
          error: [],
        },
      },
    ];
    const { c } = connector((url) => {
      if (url.endsWith('/auth/o2/token')) return token();
      return json(responses.shift());
    });
    await expect(c.updateKeywords([{ externalId: '1', bidCents: 40 }])).rejects.toMatchObject({
      kind: 'ambiguous',
    });
    await expect(
      c.updateKeywords([
        { externalId: '1', bidCents: 40 },
        { externalId: '2', bidCents: 40 },
      ]),
    ).rejects.toMatchObject({ kind: 'ambiguous' });
    await expect(
      c.updateKeywords([
        { externalId: '1', bidCents: 40 },
        { externalId: '2', bidCents: 40 },
      ]),
    ).rejects.toMatchObject({ kind: 'ambiguous' });
  });
});
