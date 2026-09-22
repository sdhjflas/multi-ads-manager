import 'dotenv/config';
import { createApp } from './app.js';
import { seedDemo } from './seed.js';
import { seedWaves } from './seed-waves.js';
import { Store } from './store.js';
import { seedBrain } from './brain/seed.js';
import { connectorFor } from './brain/accounts.js';
import { runBrain } from './brain/execution.js';

const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host))
  throw new Error(
    'This release is local-only. Add authentication and authorization before a network deployment.',
  );
const port = Number(process.env.PORT || '4311');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT.');
const store = new Store(process.env.DATABASE_PATH || '.data/orbit.sqlite');
seedDemo(store);
seedWaves(store);
await seedBrain(store);
// Background cycle for connected workspace accounts that opted into automatic sync.
const interval = Number(process.env.BRAIN_SYNC_INTERVAL_MINUTES ?? '60');
let cycling = false;
async function cycle() {
  if (cycling) return;
  cycling = true;
  try {
    for (const account of store.accounts('workspace')) {
      if (!account.policy.autoSync || account.policy.killSwitch) continue;
      try {
        await runBrain(store, account, connectorFor(store, account));
      } catch (error) {
        console.error('Brain cycle failed:', error instanceof Error ? error.message : 'unknown');
      }
    }
  } finally {
    cycling = false;
  }
}
const timer =
  Number.isFinite(interval) && interval > 0 ? setInterval(cycle, interval * 60_000) : null;
timer?.unref();
const server = createApp(store).listen(port, host, () =>
  console.log(`Orbit API ready at http://${host}:${port} · local operator mode`),
);
function shutdown() {
  if (timer) clearInterval(timer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
