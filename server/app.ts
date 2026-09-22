import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type {
  Activity,
  Campaign,
  Dashboard,
  Experiment,
  Review,
  TestWave,
} from '../shared/types.js';
import { Store } from './store.js';
import { aiProvider, aiStatus } from './ai/provider.js';
import { generateIdeas } from './ai/tasks.js';
import { brainRoutes } from './brain/routes.js';
import { bookRoutes } from './book-routes.js';
import { ConnectorError } from './connectors/connector.js';
import { amazonConfigured } from './connectors/amazon.js';
import { campaignView, dayAt, decide, metrics, sumMetrics } from './engine.js';
import { importTemplate, parseImport } from './importer.js';
import { createExperiment, planVariants } from './planner.js';
import { getLearningViews, getWaveViews, holdForOpenWave } from './waves.js';
import { waveRoutes } from './wave-routes.js';
import { reportRoutes } from './report-routes.js';
import {
  AppError,
  campaignInput,
  datasetSchema,
  experimentInput,
  importInput,
  reviewInput,
} from './validation.js';
import {
  parseTargetImport,
  targetHeaders,
  targetImportInput,
  targetsExceedCampaign,
  targetView,
} from './targets.js';

const filters = z.object({
  dataset: datasetSchema.default('demo'),
  vertical: z.enum(['all', 'commerce', 'books']).default('all'),
  days: z.enum(['7', '28', '56']).default('28'),
});

export function createApp(store: Store) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
    );
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    // This milestone is a loopback-only single-operator app, not tenant auth.
    const host = new URL(`http://${req.headers.host || 'invalid'}`).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host))
      return res.status(403).json({ error: 'Use the local loopback address.' });
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      const validOrigins = [
        `http://localhost:5173`,
        `http://127.0.0.1:5173`,
        `http://localhost:${process.env.PORT || 4311}`,
        `http://127.0.0.1:${process.env.PORT || 4311}`,
      ];
      if (
        req.headers['x-orbit-request'] !== '1' ||
        !req.is('application/json') ||
        (origin && !validOrigins.includes(origin)) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        return res
          .status(403)
          .json({ error: 'Mutation requests must come from the local Orbit application.' });
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/health', (_req, res) =>
    res.json({
      status: 'ok',
      mode: 'local-operator',
      platformWritesEnabled: process.env.AMAZON_ADS_WRITES_ENABLED === 'true',
    }),
  );

  app.get('/api/dashboard', (req, res) => {
    const { dataset, vertical, days: dayString } = filters.parse(req.query);
    const days = Number(dayString),
      generatedAt = new Date(),
      now = store.reportingTime(dataset, generatedAt);
    const campaigns = store
      .campaigns(dataset)
      .filter((c) => vertical === 'all' || c.vertical === vertical);
    const items = campaigns.map((c) => ({ c, rows: store.observations(c.id) }));
    const ids = new Set(campaigns.map((c) => c.id));
    const config = aiStatus();
    const waves = getWaveViews(store, dataset).filter((w) => ids.has(w.campaignId));
    const views = items.map(({ c, rows }) => {
      const view = campaignView(c, rows, days, now);
      return { ...view, decision: holdForOpenWave(view.decision, waves, c.id) };
    });
    const result: Dashboard = {
      dataset,
      generatedAt: generatedAt.toISOString(),
      reportingAt: now.toISOString(),
      days,
      campaigns: views,
      waves,
      learnings: getLearningViews(store, dataset, waves).filter((l) => ids.has(l.campaignId)),
      experiments: store
        .records<Experiment>(dataset, 'experiment')
        .filter((e) => ids.has(e.campaignId)),
      activity: store.records<Activity>(dataset, 'activity', 100),
      reviews: store.records<Review>(dataset, 'review', 1000).filter((r) => ids.has(r.campaignId)),
      targets: items.flatMap(({ c, rows }) => {
        const entries = store
          .targets(c.id)
          .map((target) => ({ target, rows: store.targetRows(target.id) }))
          .filter((entry) => entry.rows.length > 0);
        const exceeds = targetsExceedCampaign(entries, rows);
        return entries.map((entry) =>
          targetView(entry.target, c, entry.rows, rows, days, exceeds, now),
        );
      }),
      summary: sumMetrics(views.map((v) => v.metrics)),
      comparisonComplete:
        items.length > 0 &&
        items.every(({ c, rows }) => {
          const dates = new Set(rows.map((row) => row.date));
          return Array.from({ length: days * 2 }, (_, i) =>
            dayAt(now, -i - 1, c.reportingTimezone),
          ).every((date) => dates.has(date));
        }),
      previous: sumMetrics(
        items.map(({ c, rows }) =>
          metrics(
            c,
            rows.filter(
              (r) =>
                r.date >= dayAt(now, -days * 2, c.reportingTimezone) &&
                r.date < dayAt(now, -days, c.reportingTimezone),
            ),
          ),
        ),
      ),
      series: Array.from({ length: days }, (_, i) => {
        const date = dayAt(now, -days + i);
        const total = sumMetrics(
          items.map(({ c, rows }) =>
            metrics(
              c,
              rows.filter((r) => r.date === dayAt(now, -days + i, c.reportingTimezone)),
            ),
          ),
        );
        return {
          date,
          spendCents: total.spendCents,
          contributionCents: total.contributionCents,
          salesCents: total.salesCents,
        };
      }),
      ai: {
        configured: config.provider !== null,
        dailyLimit: config.dailyLimit,
        requestsToday: store.aiRequests(),
      },
      integrations: {
        amazonAds: {
          configured: amazonConfigured(),
          writesEnabled: process.env.AMAZON_ADS_WRITES_ENABLED === 'true',
        },
        anthropic: config.anthropic,
        openai: config.openai,
      },
    };
    res.json(result);
  });

  app.post('/api/campaigns', (req, res) => {
    const input = campaignInput.parse(req.body);
    if (store.campaigns(input.dataset).length >= 2000)
      throw new AppError('This local release supports up to 2,000 campaign workspaces.');
    const campaign: Campaign = {
      ...input,
      id: randomUUID(),
      status: 'draft',
      currency: 'USD',
      createdAt: new Date().toISOString(),
    };
    store.transaction(() => {
      store.saveCampaign(campaign);
      store.activity(
        campaign.dataset,
        'campaign',
        'Campaign workspace created',
        `${campaign.name}. No ads were created on a platform.`,
      );
    });
    res.status(201).json(campaign);
  });

  app.patch('/api/campaigns/:id/status', (req, res) => {
    const input = z
      .object({ dataset: datasetSchema, status: z.enum(['observing', 'paused']) })
      .strict()
      .parse(req.body);
    const campaign = store.campaign(input.dataset, String(req.params.id));
    store.transaction(() => {
      store.saveCampaign({ ...campaign, status: input.status });
      store.activity(
        input.dataset,
        'campaign',
        input.status === 'paused' ? 'Local monitoring paused' : 'Local monitoring resumed',
        `${campaign.name}. Platform delivery was not changed.`,
      );
    });
    res.json({ ok: true, platformMutation: false });
  });

  app.patch('/api/campaigns/:id/setup', (req, res) => {
    const input = campaignInput.parse(req.body);
    const existing = store.campaign(input.dataset, String(req.params.id));
    if (
      (store.observations(existing.id).length ||
        store.targets(existing.id).length ||
        store.links().some((l) => l.campaignId === existing.id) ||
        store.db
          .prepare('SELECT 1 FROM report_bindings WHERE campaign_id=? LIMIT 1')
          .get(existing.id)) &&
      (input.vertical !== existing.vertical ||
        input.channel !== existing.channel ||
        input.attributionDays !== existing.attributionDays ||
        input.entityName !== existing.entityName)
    ) {
      throw new AppError(
        'The item, channel, and attribution contract are fixed after importing or registering reporting IDs. Create a separate campaign for a changed definition.',
      );
    }
    const updated = { ...existing, ...input };
    store.transaction(() => {
      store.saveCampaign(updated);
      store.activity(
        input.dataset,
        'campaign',
        'Campaign setup revised',
        `${existing.name}. Economics apply to the full reporting period; previous recommendation fingerprints are superseded.`,
      );
    });
    res.json(updated);
  });

  app.post('/api/imports', (req, res) => {
    const input = importInput.parse(req.body);
    if (input.dataset === 'demo')
      throw new AppError(
        'Import business reports into Your workspace. Demo observations stay separate.',
      );
    const campaign = store.campaign(input.dataset, input.campaignId);
    if (store.links().some((l) => l.campaignId === campaign.id))
      throw new AppError(
        'API-linked campaigns receive performance through account synchronization. Use a separate campaign for file imports.',
      );
    const rows = parseImport(input, campaign);
    store.transaction(() => {
      const refunds = new Map(store.observations(campaign.id).map((r) => [r.date, r.refundsCents]));
      store.importRows(
        input.format === 'amazon'
          ? rows.map((r) => ({ ...r, refundsCents: refunds.get(r.date) || 0 }))
          : rows,
      );
      if (campaign.status === 'draft') store.saveCampaign({ ...campaign, status: 'observing' });
      store.activity(
        input.dataset,
        'import',
        'Performance report imported',
        `${rows.length} daily rows for ${campaign.name}. Overlapping dates replaced, not added.${input.format === 'amazon' ? ' Amazon exports exclude net-receipt refund adjustments; existing corrections are preserved. Reconcile new returns using the normalized template.' : ''}`,
      );
    });
    res.status(201).json({ rows: rows.length, campaignId: campaign.id });
  });

  app.get('/api/import-template', (_req, res) =>
    res.type('text/csv').attachment('orbit-performance-template.csv').send(importTemplate),
  );

  app.get('/api/target-template', (_req, res) =>
    res
      .type('text/csv')
      .attachment('orbit-target-template.csv')
      .send(`${targetHeaders.join(',')}\n`),
  );

  app.post('/api/target-imports', (req, res) => {
    const input = targetImportInput.parse(req.body);
    if (input.dataset === 'demo')
      throw new AppError(
        'Target reports belong in Your workspace, separately from synthetic demo data.',
      );
    const campaign = store.campaign(input.dataset, input.campaignId);
    if (store.links().some((l) => l.campaignId === campaign.id))
      throw new AppError(
        'API-linked campaigns receive target performance through account synchronization.',
      );
    const entries = parseTargetImport(input, campaign);
    const current = store.targets(campaign.id);
    if (new Set([...current.map((t) => t.id), ...entries.map((e) => e.target.id)]).size > 500)
      throw new AppError('This local release supports 500 measured targets per campaign.');
    store.transaction(() => {
      store.importTargets(entries);
      store.activity(
        input.dataset,
        'import',
        'Target performance imported',
        `${entries.length} measured targets for ${campaign.name}. Candidate signals require current, compatible parent campaign reports.`,
      );
    });
    res
      .status(201)
      .json({ targets: entries.length, rows: entries.reduce((sum, e) => sum + e.rows.length, 0) });
  });

  app.post('/api/experiments', async (req, res) => {
    const input = experimentInput.parse(req.body);
    const campaign = store.campaign(input.dataset, input.campaignId);
    // Validate experiment eligibility before making any paid request.
    const learning = input.sourceLearningId
      ? getLearningViews(store, input.dataset).find((l) => l.id === input.sourceLearningId)
      : undefined;
    if (
      input.sourceLearningId &&
      (!learning ||
        learning.campaignId !== campaign.id ||
        learning.evidenceChanged ||
        learning.superseded)
    )
      throw new AppError(
        'Use a current recorded learning from this campaign. Revisit changed evidence before starting a follow-up.',
      );
    if (
      input.sourceTargetId &&
      !store.targets(campaign.id).some((t) => t.id === input.sourceTargetId)
    )
      throw new AppError('The source target does not belong to this campaign.');
    createExperiment(input, campaign, planVariants(input));
    const provider = input.provider === 'ai' ? aiProvider() : null;
    if (input.provider === 'ai') {
      if (!provider)
        throw new AppError('The AI provider has not been configured on the server.', 503);
      if (input.count > 24)
        throw new AppError(
          'AI requests support 2–24 ideas. Use the structured planner for up to 300.',
        );
      store.reserveAi(aiStatus().dailyLimit);
    }
    const variants = provider
      ? await generateIdeas(
          provider,
          input,
          campaign,
          learning
            ? {
                id: learning.id,
                hypothesis: learning.hypothesis,
                outcome: learning.result.outcome,
                finding: learning.result.reason,
                notes: learning.notes,
                candidate: learning.promisingCandidate?.value ?? null,
              }
            : undefined,
        )
      : planVariants(input);
    const experiment = createExperiment(input, campaign, variants);
    store.transaction(() => {
      store.putRecord('experiment', experiment);
      store.activity(
        input.dataset,
        'experiment',
        'New experiment drafted',
        `${experiment.name}: ${variants.length} candidates, ${experiment.maxConcurrent} at a time. No ads launched.`,
      );
    });
    res.status(201).json(experiment);
  });

  app.patch('/api/experiments/:id/variants/:variantId', (req, res) => {
    const input = z
      .object({ dataset: datasetSchema, state: z.enum(['queued', 'shortlisted']) })
      .strict()
      .parse(req.body);
    const experiment = store.record<Experiment>(input.dataset, 'experiment', String(req.params.id));
    const variant = experiment.variants.find((v) => v.id === req.params.variantId);
    if (!variant) throw new AppError('Candidate not found.', 404);
    if (variant.state === input.state) return res.json(experiment);
    if (
      input.state === 'shortlisted' &&
      experiment.variants.filter((v) => v.state === 'shortlisted').length >=
        experiment.maxConcurrent
    )
      throw new AppError(
        `This wave is limited to ${experiment.maxConcurrent} candidates. Remove one before adding another.`,
      );
    variant.state = input.state;
    store.transaction(() => {
      store.putRecord('experiment', experiment);
      store.activity(
        input.dataset,
        'experiment',
        input.state === 'shortlisted' ? 'Candidate shortlisted' : 'Candidate returned to queue',
        `${experiment.name}: ${variant.label}`,
      );
    });
    res.json(experiment);
  });

  app.post('/api/analysis', (req, res) => {
    const { dataset } = z.object({ dataset: datasetSchema }).strict().parse(req.body);
    const now = store.reportingTime(dataset);
    const waves = store.records<TestWave>(dataset, 'wave', 200);
    const decisions = store.campaigns(dataset).map((c) => ({
      campaignId: c.id,
      ...holdForOpenWave(decide(c, store.observations(c.id), now), waves, c.id),
    }));
    store.activity(
      dataset,
      'system',
      'Evidence review completed',
      `${decisions.length} campaigns evaluated using the local contribution model. ${decisions.filter((d) => d.kind === 'scale').length} capped increase proposals. No platform changes.`,
    );
    res.json({ decisions, platformMutation: false });
  });

  app.post('/api/reviews', (req, res) => {
    const input = reviewInput.parse(req.body);
    const campaign = store.campaign(input.dataset, input.campaignId);
    const decision = holdForOpenWave(
      decide(campaign, store.observations(campaign.id), store.reportingTime(input.dataset)),
      store.records<TestWave>(input.dataset, 'wave', 200),
      campaign.id,
    );
    if (input.evidenceId !== decision.evidenceId)
      throw new AppError(
        'Evidence changed. Refresh the dashboard and review the current proposal.',
        409,
      );
    const id = `${campaign.id}:${decision.evidenceId}`;
    const review: Review = { ...input, id, createdAt: new Date().toISOString() };
    store.transaction(() => {
      store.putRecord('review', review);
      store.activity(
        input.dataset,
        'decision',
        input.action === 'accepted' ? 'Proposal saved for execution review' : 'Proposal dismissed',
        `${campaign.name}: ${decision.title}. This records an operator decision; it does not change bids or budgets.`,
      );
    });
    res.json({ review, platformMutation: false });
  });

  waveRoutes(app, store);
  reportRoutes(app, store);
  brainRoutes(app, store);
  bookRoutes(app, store);

  app.get('/api/export', (req, res) => {
    const { dataset, vertical, days } = filters.parse(req.query);
    const now = store.reportingTime(dataset);
    const waves = store.records<TestWave>(dataset, 'wave', 200);
    const escape = (v: string | number | null) =>
      `"${String(v ?? '')
        .replace(/^[=+\-@\t\r]/, "'$&")
        .replaceAll('"', '""')}"`;
    const rows = store
      .campaigns(dataset)
      .filter((c) => vertical === 'all' || c.vertical === vertical)
      .map((c) => {
        const view = campaignView(c, store.observations(c.id), Number(days), now);
        return [
          c.name,
          c.channel,
          c.currency,
          view.metrics.spendCents,
          view.metrics.salesCents,
          view.metrics.contributionCents,
          holdForOpenWave(view.decision, waves, c.id).kind,
          dataset,
        ];
      });
    const csv = [
      [
        'campaign',
        'channel',
        'currency',
        'spend_cents',
        'attributed_sales_cents',
        'modeled_contribution_cents',
        'recommendation',
        'dataset',
      ],
      ...rows,
    ]
      .map((r) => r.map(escape).join(','))
      .join('\r\n');
    res.type('text/csv').attachment(`orbit-${dataset}-${days}days.csv`).send(csv);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  const publicDir = resolve('dist');
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(publicDir, 'index.html')));
  }
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof z.ZodError)
      return void res.status(400).json({
        error: error.issues
          .map((i) => `${i.path.join('.') ? `${i.path.join('.')}: ` : ''}${i.message}`)
          .join(' '),
      });
    if (error instanceof AppError)
      return void res.status(error.status).json({ error: error.message });
    if (error instanceof ConnectorError)
      return void res.status(error.kind === 'invalid' ? 400 : 503).json({ error: error.message });
    if (error instanceof SyntaxError)
      return void res.status(400).json({ error: 'Invalid JSON request.' });
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large')
      return void res.status(413).json({ error: 'Request exceeds the 2 MB limit.' });
    console.error('Orbit request failed:', error instanceof Error ? error.name : 'unknown');
    res
      .status(500)
      .json({ error: 'The operation could not be completed. No platform action was taken.' });
  };
  app.use(errors);
  return app;
}
