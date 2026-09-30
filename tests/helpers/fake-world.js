// In-memory fakes for Redis (Upstash REST) and the Telegram Bot API used by tests.
const crypto = require('node:crypto');

function setupEnv(extra = {}) {
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: '123456:test-only-credential',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    TELEGRAM_CHANNEL_ID: '@test_channel',
    TELEGRAM_CHANNEL_URL: 'https://t.me/test_channel',
    APP_BASE_URL: 'https://app.example.test',
    KV_REST_API_URL: 'https://redis.example.test',
    KV_REST_API_TOKEN: 'test-redis-token',
    YOOKASSA_PROVIDER_TOKEN: 'test-provider-token',
    ADMIN_TELEGRAM_IDS: '900',
    CRON_SECRET: 'test-cron-secret',
    ...extra
  });
}

function createWorld() {
  const kv = new Map();
  const sets = new Map();
  const telegramCalls = [];
  const redis = (args) => {
    const [cmd, key, ...rest] = args;
    switch (cmd) {
      case 'GET': return kv.has(key) ? kv.get(key) : null;
      case 'SET': {
        if (rest.includes('NX') && kv.has(key)) return null;
        kv.set(key, rest[0]); return 'OK';
      }
      case 'DEL': { const had = kv.delete(key) || sets.delete(key); return had ? 1 : 0; }
      case 'SADD': { const s = sets.get(key) || new Set(); const before = s.size; rest.forEach((v) => s.add(String(v))); sets.set(key, s); return s.size - before; }
      case 'SMEMBERS': return [...(sets.get(key) || [])];
      case 'SCARD': return (sets.get(key) || new Set()).size;
      case 'MGET': return [key, ...rest].map((k) => (kv.has(k) ? kv.get(k) : null));
      case 'HGET': { const h = kv.get(key); return h ? (JSON.parse(h)[rest[0]] ?? null) : null; }
      case 'HSETNX': { const h = kv.has(key) ? JSON.parse(kv.get(key)) : {}; if (h[rest[0]]) return 0; h[rest[0]] = rest[1]; kv.set(key, JSON.stringify(h)); return 1; }
      default: throw new Error(`Fake Redis: unsupported ${cmd}`);
    }
  };
  const blockedChats = new Set();
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    const ok = (result) => ({ ok: true, json: async () => result });
    if (href.startsWith('https://redis.example.test')) return ok({ result: redis(JSON.parse(options.body)) });
    const tg = href.match(/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
    if (tg) {
      const payload = JSON.parse(options.body);
      telegramCalls.push({ method: tg[1], payload });
      if (tg[1] === 'sendMessage' && blockedChats.has(String(payload.chat_id))) return { ok: false, json: async () => ({ ok: false }) };
      if (tg[1] === 'createInvoiceLink') return ok({ ok: true, result: `https://t.me/$invoice-${payload.payload}` });
      return ok({ ok: true, result: true });
    }
    throw new Error(`Unexpected request ${href}`);
  };
  return { kv, sets, telegramCalls, blockedChats, sent: (method) => telegramCalls.filter((c) => c.method === method).map((c) => c.payload) };
}

function initData(user) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', key).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function call(handler, req) {
  let body;
  const res = { statusCode: 0, setHeader() {}, end(value) { body = value ? JSON.parse(value) : undefined; } };
  await handler({ headers: {}, ...req }, res);
  return { status: res.statusCode, body };
}

module.exports = { setupEnv, createWorld, initData, call };
