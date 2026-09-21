import 'dotenv/config';
import { createApp } from './app.js';
import { seedDemo } from './seed.js';
import { Store } from './store.js';

const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host))
  throw new Error(
    'This release is local-only. Add authentication and authorization before a network deployment.',
  );
const port = Number(process.env.PORT || '4311');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT.');
const store = new Store(process.env.DATABASE_PATH || '.data/orbit.sqlite');
seedDemo(store);
const server = createApp(store).listen(port, host, () =>
  console.log(`Orbit API ready at http://${host}:${port} · local advisory mode`),
);
function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
