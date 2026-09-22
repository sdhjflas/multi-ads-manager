process.env.PORT = '4312';
process.env.HOST = '127.0.0.1';
process.env.DATABASE_PATH = `.artifacts/e2e-${process.pid}-${Date.now()}.sqlite`;
// Browser tests never use a configured paid provider.
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_MODEL = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.AMAZON_ADS_CLIENT_ID = '';
process.env.AMAZON_ADS_CLIENT_SECRET = '';
process.env.AMAZON_ADS_REFRESH_TOKEN = '';
process.env.AMAZON_ADS_WRITES_ENABLED = 'false';
process.env.BRAIN_SYNC_INTERVAL_MINUTES = '0';
await import('../dist-server/server/index.js');
