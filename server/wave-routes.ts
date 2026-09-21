import type { Express } from 'express';
import { z } from 'zod';
import type { TestWave } from '../shared/types.js';
import { Store } from './store.js';
import { AppError, datasetSchema } from './validation.js';
import { evaluateWave, recordLearning, registerWave, waveInput } from './waves.js';

export function waveRoutes(app: Express, store: Store) {
  app.post('/api/waves', (req, res) => {
    const input = waveInput.parse(req.body);
    const wave = store.transaction(() => registerWave(store, input));
    res
      .status(201)
      .json({ ...wave, evaluation: evaluateWave(store, wave), platformMutation: false });
  });
  app.post('/api/waves/:id/conclusion', (req, res) => {
    const input = z
      .object({
        dataset: datasetSchema,
        evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
        notes: z.string().trim().min(10).max(2000),
      })
      .strict()
      .parse(req.body);
    const learning = store.transaction(() => {
      const wave = store.record<TestWave>(input.dataset, 'wave', String(req.params.id));
      return recordLearning(store, wave, input.evidenceId, input.notes);
    });
    res.json({ learning, platformMutation: false });
  });
  app.post('/api/waves/:id/cancel', (req, res) => {
    const input = z
      .object({ dataset: datasetSchema, reason: z.string().trim().min(10).max(1000) })
      .strict()
      .parse(req.body);
    store.transaction(() => {
      const wave = store.record<TestWave>(input.dataset, 'wave', String(req.params.id));
      if (wave.status === 'cancelled') return;
      if (wave.status !== 'measuring')
        throw new AppError('A concluded wave retains its result. Register a new test instead.');
      store.putRecord('wave', { ...wave, status: 'cancelled', closedAt: new Date().toISOString() });
      store.activity(
        input.dataset,
        'experiment',
        'Local test wave cancelled',
        `${wave.name}: ${input.reason}. Unused local allowance released. Platform ads were not paused.`,
      );
    });
    res.json({ ok: true, platformMutation: false });
  });
  app.get('/api/waves/:id/setup-sheet', (req, res) => {
    const { dataset } = z.object({ dataset: datasetSchema }).parse(req.query);
    const wave = store.record<TestWave>(dataset, 'wave', String(req.params.id));
    const cell = (value: string | number) =>
      `"${String(value)
        .replace(/^[=+\-@\t\r]/, "'$&")
        .replaceAll('"', '""')}"`;
    const rows = [
      [
        'wave_id',
        'plan_hash',
        'campaign',
        'role',
        'candidate_id',
        'candidate_value',
        'target_id',
        'target',
        'kind',
        'match_type',
        'start_date',
        'end_date',
        'currency',
        'wave_budget_cents',
        'wave_loss_boundary_cents',
      ],
      ...wave.arms.map((a) => [
        wave.id,
        wave.planId,
        wave.campaignSnapshot.name,
        a.role,
        a.candidate?.id || '',
        a.candidate?.value || 'Existing baseline',
        a.target.sourceId,
        a.target.label,
        a.target.kind,
        a.target.matchType,
        wave.startDate,
        wave.endDate,
        'USD',
        wave.budgetCents,
        wave.lossLimitCents,
      ]),
    ];
    res
      .type('text/csv')
      .attachment(`orbit-wave-${wave.id.slice(0, 8)}-setup.csv`)
      .send(rows.map((r) => r.map(cell).join(',')).join('\r\n'));
  });
}
