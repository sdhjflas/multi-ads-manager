import type { Express } from 'express';
import { z } from 'zod';
import { Store } from './store.js';
import { AppError } from './validation.js';
import {
  batchInput,
  batchRevisions,
  commitBatch,
  createSource,
  discardBatch,
  refreshPreview,
  reportReceipt,
  reportReceipts,
  reportScope,
  reportSource,
  reportSources,
  sourceInput,
  sourceTemplate,
  stageBatch,
} from './reports.js';

export function reportRoutes(app: Express, store: Store) {
  app.get('/api/reporting', (req, res) => {
    const { dataset } = reportScope.parse(req.query);
    res.json({ sources: reportSources(store, dataset), batches: reportReceipts(store, dataset) });
  });
  app.post('/api/reporting/sources', (req, res) => {
    const input = sourceInput.parse(req.body);
    res.status(201).json(store.transaction(() => createSource(store, input)));
  });
  app.delete('/api/reporting/sources/:id', (req, res) => {
    const { dataset } = reportScope.parse(req.body);
    store.transaction(() => {
      const source = reportSource(store, dataset, String(req.params.id));
      if (store.db.prepare('SELECT 1 FROM report_batches WHERE source_id=? LIMIT 1').get(source.id))
        throw new AppError(
          'This source has report history and must be retained. Use a new campaign/source for a changed identity.',
        );
      store.db.prepare('DELETE FROM report_bindings WHERE source_id=?').run(source.id);
      store.db.prepare('DELETE FROM report_sources WHERE id=?').run(source.id);
      store.activity(
        source.dataset,
        'import',
        'Unused report source removed',
        `${source.name}. No reports or observations were removed.`,
      );
    });
    res.json({ ok: true });
  });
  app.get('/api/reporting/sources/:id/template', (req, res) => {
    const { dataset } = reportScope.parse(req.query);
    const source = reportSource(store, dataset, String(req.params.id));
    res
      .type('text/csv')
      .attachment(`orbit-${source.profile}-template.csv`)
      .send(sourceTemplate(source));
  });
  app.post('/api/reporting/batches', (req, res) => {
    const input = batchInput.parse(req.body);
    res.status(201).json(store.transaction(() => stageBatch(store, input)));
  });
  app.get('/api/reporting/batches/:id', (req, res) => {
    const { dataset } = reportScope.parse(req.query);
    res.json(reportReceipt(store, dataset, String(req.params.id)));
  });
  app.post('/api/reporting/batches/:id/refresh', (req, res) => {
    const { dataset } = reportScope.parse(req.body);
    res.json(store.transaction(() => refreshPreview(store, dataset, String(req.params.id))));
  });
  app.post('/api/reporting/batches/:id/commit', (req, res) => {
    const { dataset, fingerprint } = reportScope
      .extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(req.body);
    res.json(
      store.transaction(() => commitBatch(store, dataset, String(req.params.id), fingerprint)),
    );
  });
  app.post('/api/reporting/batches/:id/discard', (req, res) => {
    const { dataset } = reportScope.parse(req.body);
    res.json(store.transaction(() => discardBatch(store, dataset, String(req.params.id))));
  });
  app.get('/api/reporting/batches/:id/revisions', (req, res) => {
    const { dataset, offset } = reportScope
      .extend({ offset: z.coerce.number().int().min(0).max(10000).default(0) })
      .parse(req.query);
    res.json(batchRevisions(store, dataset, String(req.params.id), offset));
  });
}
