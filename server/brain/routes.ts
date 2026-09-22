import type { Express } from 'express';
import { z } from 'zod';
import { Store } from '../store.js';
import { AppError, datasetSchema } from '../validation.js';
import {
  accountInput,
  connectorFor,
  createAccount,
  policyInput,
  versionPolicy,
  accountNow,
} from './accounts.js';
import { syncAccount } from './sync.js';
import {
  authorizeProposal,
  executeProposal,
  reconcileProposal,
  rejectProposal,
  runBrain,
  setKillSwitch,
} from './execution.js';
import { brainScope, brainView, ledgerHeaders, ledgerInput, parseLedger } from './view.js';
import { analyzeAccount } from './policy.js';
import { aiProvider, aiStatus } from '../ai/provider.js';
import { explainProposals, reviewSearchTerms } from '../ai/tasks.js';
import { AmazonAdsConnector, amazonConfigFromEnv } from '../connectors/amazon.js';
import { reportJobs, resetReportJob } from './report-jobs.js';

const scoped = z.object({ dataset: datasetSchema }).strict();

export function brainRoutes(app: Express, store: Store) {
  app.get('/api/brain', (req, res) => {
    const { dataset, days } = brainScope.parse(req.query);
    res.json(brainView(store, dataset, Number(days)));
  });

  app.post('/api/brain/amazon/profiles', async (req, res) => {
    z.object({ dataset: z.literal('workspace') })
      .strict()
      .parse(req.body);
    const config = amazonConfigFromEnv('');
    if (!config)
      throw new AppError('Configure approved Amazon Ads API credentials on the server first.', 503);
    res.json({
      region: config.region,
      profiles: await new AmazonAdsConnector(config).listProfiles(),
    });
  });

  app.post('/api/brain/accounts', async (req, res) => {
    const input = accountInput.parse(req.body);
    const config = input.connector === 'amazon-ads' ? amazonConfigFromEnv(input.profileId) : null;
    if (input.connector === 'amazon-ads' && input.dataset !== 'workspace')
      throw new AppError('Connect live profiles in Your workspace.');
    const profile = config
      ? (await new AmazonAdsConnector(config).listProfiles()).find(
          (p) => p.profileId === input.profileId,
        )
      : undefined;
    res.status(201).json(store.transaction(() => createAccount(store, input, new Date(), profile)));
  });

  app.get('/api/brain/accounts/:id/reports', (req, res) => {
    const { dataset } = scoped.parse(req.query);
    const account = store.account(dataset, String(req.params.id));
    res.json({ jobs: reportJobs(store, account.id) });
  });
  app.post('/api/brain/accounts/:id/reports/:key/retry', (req, res) => {
    const key = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(req.params.key);
    const { dataset, reportId } = scoped
      .extend({
        reportId: z
          .string()
          .regex(/^[a-zA-Z0-9-]{1,100}$/)
          .optional(),
      })
      .parse(req.body);
    const account = store.account(dataset, String(req.params.id));
    res.json(resetReportJob(store, account, key, reportId));
  });

  app.patch('/api/brain/accounts/:id/policy', (req, res) => {
    const { dataset, policy } = scoped.extend({ policy: policyInput }).parse(req.body);
    const account = store.account(dataset, String(req.params.id));
    const next = { ...account, policy: versionPolicy(policy) };
    if (
      next.policy.mode === 'bounded' &&
      account.connector === 'amazon-ads' &&
      process.env.AMAZON_ADS_WRITES_ENABLED !== 'true'
    )
      throw new AppError(
        'Bounded mode on a live account requires AMAZON_ADS_WRITES_ENABLED=true on the server.',
      );
    store.transaction(() => {
      store.saveAccount(next);
      if (next.policy.version !== account.policy.version)
        store.db
          .prepare(
            "UPDATE proposals SET status='cancelled',body=json_set(body,'$.status','cancelled','$.updatedAt',?,'$.history[#]',json_object('at',?,'status','cancelled','note','Account policy changed; generate a new proposal.')) WHERE account_id=? AND status IN ('proposed','authorized')",
          )
          .run(new Date().toISOString(), new Date().toISOString(), account.id);
      store.activity(
        dataset,
        'system',
        'Operating policy updated',
        `${account.name}: mode ${next.policy.mode}, policy ${next.policy.version}. Previous authorizations remain tied to their policy version.`,
      );
    });
    res.json(next);
  });

  app.post('/api/brain/accounts/:id/links', (req, res) => {
    const input = scoped
      .extend({
        campaignId: z.string().min(1).max(160),
        externalCampaignId: z.string().min(1).max(160),
        adGroupExternalId: z.string().min(1).max(160),
      })
      .strict()
      .parse(req.body);
    const account = store.account(input.dataset, String(req.params.id));
    const campaign = store.campaign(input.dataset, input.campaignId);
    if (campaign.channel !== account.provider)
      throw new AppError('The campaign channel must match the account provider.');
    if (campaign.attributionDays !== account.attributionDays)
      throw new AppError('The campaign click window must match the account attribution window.');
    const snapshot = store.snapshot(account.id);
    if (!snapshot) throw new AppError('Synchronize the account before linking a campaign.');
    const prior = store.links().find((l) => l.campaignId === campaign.id);
    if (
      prior &&
      (prior.accountId !== account.id ||
        prior.externalCampaignId !== input.externalCampaignId ||
        prior.adGroupExternalId !== input.adGroupExternalId)
    )
      throw new AppError(
        'This campaign already has a reporting identity. Create a new local campaign for a different account, campaign, or ad group.',
      );
    const binding = store.db
      .prepare('SELECT campaign_id FROM report_bindings WHERE campaign_id=?')
      .get(campaign.id);
    if (binding)
      throw new AppError(
        'This campaign receives reporting-hub imports. Create a separate campaign for API reporting.',
      );
    if (!prior && (store.observations(campaign.id).length || store.targets(campaign.id).length))
      throw new AppError(
        'Link a new campaign with no imported history so reporting sources cannot be mixed.',
      );
    if (snapshot && !snapshot.campaigns.some((c) => c.externalId === input.externalCampaignId))
      throw new AppError(
        'That platform campaign is not in the latest snapshot. Synchronize first.',
      );
    if (
      snapshot &&
      !snapshot.adGroups.some(
        (g) =>
          g.externalId === input.adGroupExternalId &&
          g.campaignExternalId === input.externalCampaignId,
      )
    )
      throw new AppError('That ad group does not belong to the selected platform campaign.');
    const clash = store
      .links(account.id)
      .find(
        (l) => l.externalCampaignId === input.externalCampaignId && l.campaignId !== campaign.id,
      );
    if (clash)
      throw new AppError('That platform campaign is already linked to another local campaign.');
    store.transaction(() => {
      store.saveCampaign({ ...campaign, reportingTimezone: account.timezone });
      store.saveLink({
        campaignId: campaign.id,
        accountId: account.id,
        externalCampaignId: input.externalCampaignId,
        adGroupExternalId: input.adGroupExternalId,
      });
      store.activity(
        input.dataset,
        'campaign',
        'Campaign linked to platform',
        `${campaign.name} ↔ ${input.externalCampaignId}. Synchronize to collect performance.`,
      );
    });
    res.status(201).json({ ok: true });
  });

  app.post('/api/brain/accounts/:id/sync', async (req, res) => {
    const { dataset } = scoped.parse(req.body);
    const account = store.account(dataset, String(req.params.id));
    const run = await syncAccount(store, account, connectorFor(store, account));
    res.json(run);
  });

  app.post('/api/brain/accounts/:id/run', async (req, res) => {
    const { dataset, sync } = scoped.extend({ sync: z.boolean().default(true) }).parse(req.body);
    const account = store.account(dataset, String(req.params.id));
    const summary = await runBrain(store, account, connectorFor(store, account), new Date(), {
      sync,
    });
    res.json(summary);
  });

  app.post('/api/brain/accounts/:id/kill', (req, res) => {
    const { dataset, on } = scoped.extend({ on: z.boolean() }).parse(req.body);
    const account = store.account(dataset, String(req.params.id));
    res.json(setKillSwitch(store, account, on));
  });

  app.post('/api/brain/proposals/:id/authorize', (req, res) => {
    const { dataset } = scoped.parse(req.body);
    const proposal = store.proposal(dataset, String(req.params.id));
    const account = store.account(dataset, proposal.accountId);
    res.json(authorizeProposal(store, account, proposal.id, 'operator'));
  });
  app.post('/api/brain/proposals/:id/reject', (req, res) => {
    const { dataset, reason } = scoped
      .extend({ reason: z.string().trim().min(3).max(500) })
      .parse(req.body);
    const proposal = store.proposal(dataset, String(req.params.id));
    const account = store.account(dataset, proposal.accountId);
    res.json(rejectProposal(store, account, proposal.id, reason));
  });
  app.post('/api/brain/proposals/:id/execute', async (req, res) => {
    const { dataset } = scoped.parse(req.body);
    const proposal = store.proposal(dataset, String(req.params.id));
    const account = store.account(dataset, proposal.accountId);
    const outcome = await executeProposal(
      store,
      account,
      connectorFor(store, account),
      proposal.id,
    );
    res.json(outcome);
  });
  app.post('/api/brain/proposals/:id/reconcile', async (req, res) => {
    const { dataset } = scoped.parse(req.body);
    const proposal = store.proposal(dataset, String(req.params.id));
    const account = store.account(dataset, proposal.accountId);
    res.json(await reconcileProposal(store, account, connectorFor(store, account), proposal.id));
  });

  app.post('/api/brain/proposals/explain', async (req, res) => {
    const { dataset, ids } = scoped
      .extend({ ids: z.array(z.string().uuid()).min(1).max(20) })
      .parse(req.body);
    const provider = aiProvider();
    if (!provider)
      throw new AppError(
        'Configure ANTHROPIC_API_KEY (or OPENAI_API_KEY and OPENAI_MODEL) on the server first.',
        503,
      );
    const proposals = ids.map((id) => store.proposal(dataset, id));
    const campaignIds = new Set(proposals.map((p) => p.campaignId));
    if (campaignIds.size !== 1)
      throw new AppError('Explain proposals from one campaign at a time.');
    const campaign = store.campaign(dataset, proposals[0].campaignId);
    store.reserveAi(aiStatus().dailyLimit);
    res.json({
      explanation: await explainProposals(provider, store, campaign, proposals),
      provider: provider.name,
      model: provider.model,
    });
  });

  app.post('/api/brain/search-terms/review', async (req, res) => {
    const { dataset, campaignId } = scoped
      .extend({ campaignId: z.string().min(1).max(160) })
      .parse(req.body);
    const provider = aiProvider();
    if (!provider)
      throw new AppError(
        'Configure ANTHROPIC_API_KEY (or OPENAI_API_KEY and OPENAI_MODEL) on the server first.',
        503,
      );
    const campaign = store.campaign(dataset, campaignId);
    const account = store
      .accounts(dataset)
      .find((a) => store.links(a.id).some((l) => l.campaignId === campaignId));
    if (!account) throw new AppError('Link this campaign to a connected account first.');
    const analysis = analyzeAccount(store, account, accountNow(store, dataset)).find(
      (a) => a.campaign.id === campaignId,
    );
    const terms = (analysis?.terms || [])
      .filter((t) => t.signal !== 'blocked')
      .slice(0, 60)
      .map((t) => t.term);
    if (!terms.length)
      throw new AppError(
        'No search terms are available to review yet. Synchronize the account first.',
      );
    store.reserveAi(aiStatus().dailyLimit);
    const reviews = await reviewSearchTerms(provider, store, campaign, terms);
    res.json({ reviewed: reviews.size, provider: provider.name });
  });

  app.get('/api/brain/ledger-template', (_req, res) =>
    res
      .type('text/csv')
      .attachment('orbit-ledger-template.csv')
      .send(`${ledgerHeaders.join(',')}\n`),
  );
  app.post('/api/brain/ledger', (req, res) => {
    const input = ledgerInput.parse(req.body);
    const campaign = store.campaign(input.dataset, input.campaignId);
    const rows = parseLedger(campaign, input.csv);
    store.transaction(() => {
      store.importLedger(rows);
      store.activity(
        input.dataset,
        'import',
        'Business ledger imported',
        `${rows.length} reconciled days for ${campaign.name}. Ledger receipts stay separate from platform attribution.`,
      );
    });
    res.status(201).json({ rows: rows.length });
  });
}
