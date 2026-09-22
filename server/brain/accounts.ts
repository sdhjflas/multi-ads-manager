import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AdAccount, Dataset, Policy } from '../../shared/types.js';
import { actionClasses } from '../../shared/types.js';
import { Store } from '../store.js';
import { AppError, datasetSchema } from '../validation.js';
import type { Connector } from '../connectors/connector.js';
import { SandboxConnector, sandboxSpec, type SandboxState } from '../connectors/sandbox.js';
import { AmazonAdsConnector, amazonConfigFromEnv } from '../connectors/amazon.js';
import { dayAt } from '../engine.js';
import { SqliteReportCache, syncPlan } from './report-jobs.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const policyInput = z
  .object({
    mode: z.enum(['observe', 'recommend', 'supervised', 'bounded']),
    killSwitch: z.boolean(),
    autoSync: z.boolean(),
    aiReview: z.boolean(),
    allowedClasses: z.array(z.enum(actionClasses as [string, ...string[]])).max(7),
    maxBidCents: z.number().int().min(2).max(100_000),
    maxBidStepPct: z.number().int().min(1).max(50),
    maxDailyBudgetCents: z.number().int().min(100).max(100_000_000),
    maxBudgetStepPct: z.number().int().min(1).max(50),
    maxDailyCommitmentCents: z.number().int().min(0).max(100_000_000),
    cooldownHours: z.number().int().min(0).max(720),
    maxActionsPerRun: z.number().int().min(1).max(100),
    maxEvidenceAgeHours: z.number().int().min(1).max(168),
    harvestMinClicks: z.number().int().min(1).max(100_000),
    harvestMinOrders: z.number().int().min(1).max(10_000),
    negativeMinClicks: z.number().int().min(1).max(100_000),
    negativeMaxProbability: z.number().min(0).max(1),
    bidMinClicks: z.number().int().min(1).max(100_000),
  })
  .strict();
export type PolicyInput = z.infer<typeof policyInput>;

export function versionPolicy(input: PolicyInput): Policy {
  return {
    ...input,
    allowedClasses: input.allowedClasses as Policy['allowedClasses'],
    version: hash(input).slice(0, 16),
  };
}

export function defaultPolicy(overrides: Partial<PolicyInput> = {}): Policy {
  return versionPolicy({
    mode: 'recommend',
    killSwitch: false,
    autoSync: true,
    aiReview: true,
    allowedClasses: ['negative', 'bid-down', 'pause'],
    maxBidCents: 300,
    maxBidStepPct: 20,
    maxDailyBudgetCents: 20_000,
    maxBudgetStepPct: 20,
    maxDailyCommitmentCents: 5_000,
    cooldownHours: 72,
    maxActionsPerRun: 10,
    maxEvidenceAgeHours: 48,
    harvestMinClicks: 15,
    harvestMinOrders: 2,
    negativeMinClicks: 20,
    negativeMaxProbability: 0.1,
    bidMinClicks: 50,
    ...overrides,
  });
}

export const accountInput = z
  .object({
    dataset: datasetSchema,
    name: z.string().trim().min(1).max(160),
    connector: z.enum(['sandbox', 'amazon-ads']),
    profileId: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_.:-]{1,120}$/),
    marketplace: z.string().trim().min(2).max(40).default('US'),
    attributionDays: z.number().int().min(1).max(30).default(14),
  })
  .strict();

export function createAccount(
  store: Store,
  input: z.infer<typeof accountInput>,
  now = new Date(),
  verifiedProfile?: Awaited<ReturnType<AmazonAdsConnector['listProfiles']>>[number],
): AdAccount {
  if (store.accounts(input.dataset).length >= 20)
    throw new AppError('This local release supports 20 connected accounts per workspace.');
  if (input.connector === 'amazon-ads' && !amazonConfigFromEnv(input.profileId))
    throw new AppError(
      'Set AMAZON_ADS_CLIENT_ID, AMAZON_ADS_CLIENT_SECRET, and AMAZON_ADS_REFRESH_TOKEN on the server before connecting an Amazon Ads profile.',
      503,
    );
  if (input.connector === 'amazon-ads' && ![1, 7, 14, 30].includes(input.attributionDays))
    throw new AppError('Amazon Ads reporting supports 1, 7, 14, or 30 day attribution.');
  if (
    input.connector === 'amazon-ads' &&
    (input.dataset !== 'workspace' ||
      !verifiedProfile ||
      verifiedProfile.profileId !== input.profileId ||
      verifiedProfile.currencyCode !== 'USD')
  )
    throw new AppError(
      'Live accounts require a verified USD Amazon Ads profile in Your workspace.',
    );
  if (
    input.connector === 'amazon-ads' &&
    store
      .accounts(input.dataset)
      .some((a) => a.connector === input.connector && a.profileId === input.profileId)
  )
    throw new AppError('This profile is already registered. Reuse its existing account.');
  const account: AdAccount = {
    id: randomUUID(),
    dataset: input.dataset,
    provider: 'amazon',
    connector: input.connector,
    name: input.name,
    profileId: input.profileId,
    marketplace: verifiedProfile?.countryCode || input.marketplace,
    currency: 'USD',
    timezone: verifiedProfile?.timezone || 'UTC',
    ...(verifiedProfile
      ? {
          region: amazonConfigFromEnv(input.profileId)!.region,
          verifiedAt: now.toISOString(),
          accountType: verifiedProfile.accountInfo.type,
        }
      : {}),
    attributionDays: input.attributionDays,
    policy: defaultPolicy({
      mode: input.connector === 'sandbox' ? 'supervised' : 'observe',
      // Live search terms stay local until the operator explicitly enables AI review.
      aiReview: input.connector === 'sandbox',
    }),
    health: {
      status: 'never',
      message: 'Not synchronized yet.',
      lastAttemptAt: null,
      lastSuccessAt: null,
      watermarkDate: null,
      coverage: { campaigns: 0, keywords: 0, negatives: 0, searchTerms: 0 },
    },
    createdAt: now.toISOString(),
  };
  store.saveAccount(account);
  if (input.connector === 'sandbox') {
    // A fresh sandbox advertiser starts with three campaigns awaiting links.
    store.saveSandboxState(
      account.id,
      sandboxSpec([
        {
          externalId: `sbx-${account.id.slice(0, 8)}-1`,
          name: 'Sandbox campaign A',
          dailyBudgetCents: 4000,
        },
        {
          externalId: `sbx-${account.id.slice(0, 8)}-2`,
          name: 'Sandbox campaign B',
          dailyBudgetCents: 3500,
        },
        {
          externalId: `sbx-${account.id.slice(0, 8)}-3`,
          name: 'Sandbox campaign C',
          dailyBudgetCents: 2500,
        },
      ]),
    );
  }
  store.activity(
    account.dataset,
    'system',
    'Ad account connected',
    `${account.name} (${account.connector === 'sandbox' ? 'simulated account' : 'Amazon Ads profile ' + account.profileId}). Mode: ${account.policy.mode}. No platform changes.`,
  );
  return account;
}

/** The reporting clock for an account: real time, or the demo snapshot. */
export const accountNow = (store: Store, dataset: Dataset, now = new Date()) =>
  store.reportingTime(dataset, now);

export function connectorFor(store: Store, account: AdAccount, now = new Date()): Connector {
  if (account.connector === 'sandbox') {
    const state = store.sandboxState<SandboxState>(account.id);
    if (!state) throw new AppError('Sandbox state is missing for this account.', 500);
    const links = store.links(account.id);
    return new SandboxConnector(state, {
      history: (externalId) => {
        const link = links.find((l) => l.externalCampaignId === externalId);
        const local = link ? store.observations(link.campaignId) : [];
        if (local.length) return local;
        // Unlinked or freshly linked sandbox campaigns replay a synthetic history.
        return syntheticHistory(externalId, accountNow(store, account.dataset, now));
      },
      persist: (next) => store.saveSandboxState(account.id, next),
      today: () => dayAt(accountNow(store, account.dataset, now)),
    });
  }
  const config = amazonConfigFromEnv(account.profileId);
  if (!config) throw new AppError('Amazon Ads credentials are not configured on the server.', 503);
  if (account.region && config.region !== account.region)
    throw new AppError(
      'The server region changed. Restore the account’s registered region before synchronizing.',
    );
  if (!account.verifiedAt || !account.region)
    throw new AppError(
      'Verify the Amazon Ads profile and its timezone before using this connection.',
    );
  const plan = syncPlan(store, account, now);
  return new AmazonAdsConnector(
    { ...config, timezone: account.timezone },
    fetch,
    Date.now,
    undefined,
    new SqliteReportCache(store, account.id),
    plan.generation,
  );
}

function syntheticHistory(seed: string, now: Date) {
  let rng = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 2147483647, 7) || 7;
  const random = () => {
    rng = (rng * 16807) % 2147483647;
    return (rng - 1) / 2147483646;
  };
  return Array.from({ length: 56 }, (_, i) => {
    const clicks = Math.round(40 + random() * 40);
    const orders = Math.round(clicks * (0.04 + random() * 0.06));
    return {
      campaignId: seed,
      date: dayAt(now, -(56 - i)),
      impressions: clicks * 35,
      clicks,
      orders,
      spendCents: Math.round(clicks * (30 + random() * 20)),
      salesCents: orders * 1995,
      refundsCents: 0,
      observedAt: now.toISOString(),
    };
  });
}
