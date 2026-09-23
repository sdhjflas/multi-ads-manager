import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sourceProviders, type ConnectionJob } from '../shared/connections.js';
import { ConnectionOAuth } from './connections/oauth.js';
import type { ConnectionService } from './connections/service.js';
import type { ShopifyCredential } from './connections/shopify.js';
import { AppError, datasetSchema } from './validation.js';

const clientId = z.string().trim().min(1).max(160);
const externalId = z.string().trim().min(1).max(200).optional();
const authMode = z.enum(['oauth', 'token', 'environment']);
const createConnectionInput = z.discriminatedUnion('provider', [
  z
    .object({
      dataset: z.literal('workspace'),
      clientId,
      provider: z.literal('shopify'),
      name: z.string().trim().min(1).max(160),
      authMode,
      externalAccountId: externalId,
      credentials: z
        .object({ accessToken: z.string().trim().min(10).max(20_000), shopDomain: z.string().trim().min(1).max(120) })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      dataset: z.literal('workspace'),
      clientId,
      provider: z.literal('meta-ads'),
      name: z.string().trim().min(1).max(160),
      authMode,
      externalAccountId: externalId,
      credentials: z.object({ accessToken: z.string().trim().min(10).max(20_000) }).strict().optional(),
    })
    .strict(),
  z
    .object({
      dataset: z.literal('workspace'),
      clientId,
      provider: z.literal('amazon-ads'),
      name: z.string().trim().min(1).max(160),
      authMode,
      externalAccountId: externalId,
      credentials: z
        .object({
          clientId: z.string().trim().min(1).max(500),
          clientSecret: z.string().trim().min(1).max(2_000),
          refreshToken: z.string().trim().min(10).max(20_000),
          region: z.enum(['NA', 'EU', 'FE']),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      dataset: z.literal('workspace'),
      clientId,
      provider: z.literal('pbs'),
      name: z.string().trim().min(1).max(160),
      authMode,
      externalAccountId: externalId,
      credentials: z
        .object({
          baseUrl: z.url().max(500),
          accessToken: z.string().trim().min(10).max(20_000),
          publisherCode: z.string().trim().min(1).max(32),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

const scope = z
  .object({ dataset: datasetSchema, clientId })
  .strict();

export function connectionRoutes(app: Express, service: ConnectionService) {
  app.post('/api/clients', (req, res) => {
    const input = z
      .object({ dataset: z.literal('workspace'), name: z.string().trim().min(1).max(160) })
      .strict()
      .parse(req.body);
    res.status(201).json(service.createClient(input.name));
  });

  app.get('/api/connections', (req, res) => {
    const parsed = z
      .object({ dataset: datasetSchema, clientId: clientId.optional() })
      .strict()
      .parse(req.query);
    res.json(service.view(parsed.dataset, parsed.clientId));
  });

  app.post('/api/connections', (req, res) => {
    const input = createConnectionInput.parse(req.body);
    res.status(201).json(service.create(input));
  });

  app.post('/api/connections/:id/sync', async (req, res) => {
    const input = scope.parse(req.body);
    res.json(await service.sync(input.dataset, input.clientId, String(req.params.id)));
  });

  app.post('/api/connections/:id/revoke', (req, res) => {
    const input = scope.parse(req.body);
    res.json(service.revoke(input.dataset, input.clientId, String(req.params.id)));
  });

  app.post('/api/connections/:id/backfill', (req, res) => {
    const input = scope.extend({ from: z.iso.date() }).strict().parse(req.body);
    res.status(202).json(
      service.queueBackfill(input.dataset, input.clientId, String(req.params.id), input.from),
    );
  });

  app.post('/api/connection-jobs/:id/retry', (req, res) => {
    const input = scope.parse(req.body);
    res.status(202).json(
      service.retryJob(input.dataset, input.clientId, String(req.params.id)),
    );
  });

  app.post('/api/connections/:id/oauth/start', (req, res) => {
    const input = scope
      .extend({ shopDomain: z.string().trim().max(120).optional() })
      .parse(req.body);
    const connection = service.repository.connection(
      input.dataset,
      input.clientId,
      String(req.params.id),
    );
    res.json(
      new ConnectionOAuth(service.repository, service.fetcher, service.clock).start(
        connection,
        input,
      ),
    );
  });

  app.get('/api/oauth/:provider/callback', async (req, res) => {
    const provider = z.enum(sourceProviders).parse(req.params.provider);
    const params = new URL(req.originalUrl, 'http://localhost').searchParams;
    await new ConnectionOAuth(service.repository, service.fetcher, service.clock).callback(
      provider,
      params,
    );
    res.redirect(303, '/#connections');
  });
}

export function shopifyWebhookRoute(app: Express, service: ConnectionService) {
  app.post(
    '/api/webhooks/shopify/:connectionId',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('Shopify webhook body is invalid.');
      const hmac = String(req.headers['x-shopify-hmac-sha256'] || '');
      const topic = String(req.headers['x-shopify-topic'] || 'unknown').slice(0, 100);
      const deliveryId = String(req.headers['x-shopify-webhook-id'] || '');
      const shop = String(req.headers['x-shopify-shop-domain'] || '').toLowerCase();
      const secret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
      if (!secret || !/^[A-Za-z0-9+/=]{40,100}$/.test(hmac))
        throw new AppError('Shopify webhook signature is missing or invalid.', 401);
      const expected = createHmac('sha256', secret).update(req.body).digest();
      const supplied = Buffer.from(hmac, 'base64');
      if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
        throw new AppError('Shopify webhook signature is invalid.', 401);
      if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(deliveryId))
        throw new AppError('Shopify webhook delivery identity is missing or invalid.', 400);
      const connection = service.repository.connectionById(String(req.params.connectionId));
      if (connection.provider !== 'shopify' || connection.dataset !== 'workspace')
        throw new AppError('Shopify connection not found.', 404);
      const credential = service.repository.secret<ShopifyCredential>(connection);
      if (credential.shopDomain !== shop)
        throw new AppError('Shopify webhook store does not match this connection.', 403);
      const now = new Date();
      const job: ConnectionJob = {
        id: randomUUID(),
        dataset: connection.dataset,
        clientId: connection.clientId,
        connectionId: connection.id,
        provider: 'shopify',
        kind: 'webhook',
        status: 'queued',
        attempt: 0,
        startedAt: now.toISOString(),
        finishedAt: null,
        cursor: null,
        counts: {},
        message: `Verified ${topic}; queued a read-only refresh.`,
        errorKind: null,
      };
      const accepted = service.store.transaction(() => {
        if (!service.repository.acceptWebhook(connection.id, deliveryId, topic, now)) return false;
        service.repository.saveJob(job);
        service.repository.event(
          connection,
          connection.dataset,
          connection.clientId,
          'connection.webhook.verified',
          `${connection.name}: ${topic}. Payload discarded after signature verification.`,
          now,
        );
        return true;
      });
      if (!accepted) return void res.status(202).json({ accepted: true, duplicate: true });
      res.status(202).json({ accepted: true, jobId: job.id });
    },
  );
}
