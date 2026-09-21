process.env.PORT = '4312';
process.env.HOST = '127.0.0.1';
process.env.DATABASE_PATH = `.artifacts/e2e-${process.pid}-${Date.now()}.sqlite`;
// Browser tests never use a configured paid provider.
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_MODEL = '';
await import('../dist-server/server/index.js');
