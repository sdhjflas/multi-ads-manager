import type { Express } from 'express';
import { z } from 'zod';
import { ProfitControlService } from './profit-control.js';

const id = z.string().trim().min(1).max(200);
const cents = z.number().int().min(0).max(1_000_000_000);
const economics = {
  retailPriceCents: cents,
  netReceiptCents: cents,
  variableCostCents: cents,
  profitReserveCents: cents,
  lossLimitCents: cents,
  dailyBudgetLimitCents: cents,
  verified: z.boolean(),
  note: z.string().trim().max(500).default(''),
};

export function profitRoutes(app: Express, service: ProfitControlService) {
  app.get('/api/profit-control', (req, res) => {
    const input = z
      .object({ dataset: z.enum(['demo', 'workspace']), clientId: id.optional() })
      .strict()
      .parse(req.query);
    res.json(service.view(input.dataset, input.clientId));
  });

  app.post('/api/profit-control/items', (req, res) => {
    const input = z
      .object({
        dataset: z.literal('workspace'),
        clientId: id,
        vertical: z.enum(['commerce', 'books']),
        name: z.string().trim().min(1).max(200),
        sku: z.string().trim().max(160).optional(),
        isbn: z.string().trim().max(32).optional(),
        asin: z.string().trim().max(32).optional(),
        ...economics,
      })
      .strict()
      .parse(req.body);
    res.status(201).json(service.createItem(input));
  });

  app.post('/api/profit-control/items/:id/economics', (req, res) => {
    const input = z
      .object({ dataset: z.literal('workspace'), clientId: id, ...economics })
      .strict()
      .parse(req.body);
    const { dataset, clientId, ...version } = input;
    res.json(service.reviseEconomics(dataset, clientId, String(req.params.id), version));
  });

  app.post('/api/profit-control/mappings', (req, res) => {
    const input = z
      .object({
        dataset: z.literal('workspace'),
        clientId: id,
        connectionId: id,
        sourceKind: z.enum(['campaign', 'variant', 'book']),
        externalId: id,
        itemId: id,
      })
      .strict()
      .parse(req.body);
    res.status(201).json(service.map(input));
  });

  app.post('/api/profit-control/mappings/:id/remove', (req, res) => {
    const input = z
      .object({ dataset: z.literal('workspace'), clientId: id })
      .strict()
      .parse(req.body);
    res.json(service.removeMapping(input.dataset, input.clientId, String(req.params.id)));
  });

  app.post('/api/profit-control/pools', (req, res) => {
    const input = z
      .object({
        dataset: z.literal('workspace'),
        clientId: id,
        name: z.string().trim().min(1).max(160),
        vertical: z.enum(['all', 'commerce', 'books']),
        dailyLimitCents: cents.positive(),
        learningLimitCents: cents.positive(),
        reservePercent: z.number().int().min(0).max(90),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(service.savePool(input));
  });

  app.post('/api/profit-control/optimize', (req, res) => {
    const input = z
      .object({ dataset: z.literal('workspace'), clientId: id, poolId: id })
      .strict()
      .parse(req.body);
    res.status(201).json(service.optimize(input.dataset, input.clientId, input.poolId));
  });

  app.post('/api/profit-control/tests', (req, res) => {
    const input = z
      .object({
        dataset: z.literal('workspace'),
        clientId: id,
        itemId: id,
        hypothesis: z.string().trim().min(10).max(1200),
        variable: z.enum([
          'keyword',
          'product-target',
          'hook',
          'headline',
          'audience',
          'landing-page',
        ]),
        seeds: z.array(z.string().trim().min(2).max(160)).min(1).max(50),
        count: z.number().int().min(2).max(300),
        lossBudgetCents: cents.positive(),
        maxConcurrent: z.number().int().min(1).max(20),
        assetEvidenceApproved: z.boolean(),
      })
      .strict()
      .parse(req.body);
    if (input.maxConcurrent > input.count)
      return res.status(400).json({
        error: 'Concurrent candidate count cannot exceed the candidate library.',
      });
    res.status(201).json(service.createTest(input));
  });

  app.post('/api/profit-control/tests/:id/activate', (req, res) => {
    const input = z
      .object({ dataset: z.literal('workspace'), clientId: id })
      .strict()
      .parse(req.body);
    res.json(service.activateTest(input.dataset, input.clientId, String(req.params.id)));
  });
}
