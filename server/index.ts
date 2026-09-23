import 'dotenv/config';
import { createApp } from './app.js';
import { seedDemo } from './seed.js';
import { seedWaves } from './seed-waves.js';
import { Store } from './store.js';
import { seedBrain } from './brain/seed.js';
import { connectorFor } from './brain/accounts.js';
import { runBrain } from './brain/execution.js';
import type { ConnectionService } from './connections/service.js';

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
const interval = Number(process.env.BRAIN_SYNC_INTERVAL_MINUTES ?? '1440');
let cycling = false,
  closing = false;
async function cycle(pendingOnly = false) {
  if (cycling || closing) return;
  cycling = true;
  try {
    for (const account of store.accounts('workspace')) {
      if (closing) break;
      if (
        !account.policy.autoSync ||
        account.policy.killSwitch ||
        (pendingOnly && !['pending', 'throttled'].includes(account.health.status))
      )
        continue;
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
  Number.isFinite(interval) && interval > 0 ? setInterval(() => cycle(), interval * 60_000) : null;
timer?.unref();
const reportTimer =
  Number.isFinite(interval) && interval > 0 ? setInterval(() => cycle(true), 60000) : null;
reportTimer?.unref();
const app = createApp(store);
const connectionService = app.locals.connectionService as ConnectionService;
const connectionInterval = Number(process.env.CONNECTION_SYNC_INTERVAL_MINUTES ?? '5');
if (!Number.isFinite(connectionInterval) || connectionInterval < 0)
  throw new Error('CONNECTION_SYNC_INTERVAL_MINUTES must be zero or a positive number.');
let connectionCycling = false;
async function connectionCycle() {
  if (connectionCycling || closing) return;
  connectionCycling = true;
  try {
    await connectionService.processQueuedJobs();
    await connectionService.syncDueConnections();
  } catch (error) {
    console.error(
      'Connection cycle failed:',
      error instanceof Error ? error.message : 'unknown',
    );
  } finally {
    connectionCycling = false;
  }
}
void connectionCycle();
const connectionTimer =
  connectionInterval > 0
    ? setInterval(() => void connectionCycle(), connectionInterval * 60_000)
    : null;
connectionTimer?.unref();
const server = app.listen(port, host, () =>
  console.log(`Orbit API ready at http://${host}:${port} · local operator mode`),
);
function shutdown() {
  if (closing) return;
  closing = true;
  if (reportTimer) clearInterval(reportTimer);
  if (timer) clearInterval(timer);
  if (connectionTimer) clearInterval(connectionTimer);
  server.close(async () => {
    while (cycling || connectionCycling) await new Promise((resolve) => setTimeout(resolve, 100));
    store.close();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
