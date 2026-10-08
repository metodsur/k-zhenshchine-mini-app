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
      case 'INCR': { const v = (Number(kv.get(key)) || 0) + 1; kv.set(key, String(v)); return v; }
      case 'EXPIRE': return 1;
      case 'LPUSH': { const l = world.lists[key] || (world.lists[key] = []); rest.forEach((v) => l.unshift(v)); return l.length; }
      case 'SUNION': { const u = new Set(); [key, ...rest].forEach((k) => (sets.get(k) || new Set()).forEach((v) => u.add(v))); return [...u]; }
      case 'SCARD': return (sets.get(key) || new Set()).size;
      case 'MGET': return [key, ...rest].map((k) => (kv.has(k) ? kv.get(k) : null));
      case 'HMGET': { const h = kv.has(key) ? JSON.parse(kv.get(key)) : {}; return rest.map((f) => h[f] ?? null); }
      case 'HGET': {
        const h = kv.get(key); const v = h ? (JSON.parse(h)[rest[0]] ?? null) : null;
        // Most tests are about other things: consent counts as given unless a test turns this off.
        if (v === null && rest[0] === 'consent_at' && world.autoConsent) return '2026-01-01T00:00:00.000Z';
        return v;
      }
      case 'HSETNX': { const h = kv.has(key) ? JSON.parse(kv.get(key)) : {}; if (h[rest[0]]) return 0; h[rest[0]] = rest[1]; kv.set(key, JSON.stringify(h)); return 1; }
      case 'HSET': { const h = kv.has(key) ? JSON.parse(kv.get(key)) : {}; let added = 0; for (let i = 0; i < rest.length; i += 2) { if (!(rest[i] in h)) added++; h[rest[i]] = rest[i + 1]; } kv.set(key, JSON.stringify(h)); return added; }
      case 'HDEL': { const h = kv.has(key) ? JSON.parse(kv.get(key)) : {}; let n = 0; rest.forEach((f) => { if (f in h) { delete h[f]; n++; } }); kv.set(key, JSON.stringify(h)); return n; }
      case 'HGETALL': { const h = kv.has(key) ? JSON.parse(kv.get(key)) : {}; return Object.entries(h).flat(); }
      case 'SREM': { const s = sets.get(key) || new Set(); let n = 0; rest.forEach((v) => { if (s.delete(String(v))) n++; }); return n; }
      case 'SISMEMBER': return (sets.get(key) || new Set()).has(String(rest[0])) ? 1 : 0;
      default: throw new Error(`Fake Redis: unsupported ${cmd}`);
    }
  };
  const blockedChats = new Set();
  const world = { autoConsent: true, members: new Set(), memberCounts: {}, tributeSubscribers: null, qstash: [], lists: {} };
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    const ok = (result) => ({ ok: true, json: async () => result });
    if (href.startsWith('https://redis.example.test')) return ok({ result: redis(JSON.parse(options.body)) });
    if (href.startsWith('https://tribute.tg/') && world.tributeSubscribers) return ok(world.tributeSubscribers);
    if (href.startsWith('https://qstash.upstash.io/')) { world.qstash.push({ url: href, headers: options.headers, body: JSON.parse(options.body) }); return ok({ messageId: 'm' + world.qstash.length }); }
    const tg = href.match(/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
    if (tg) {
      const payload = JSON.parse(options.body);
      telegramCalls.push({ method: tg[1], payload });
      if (tg[1] === 'sendMessage' && blockedChats.has(String(payload.chat_id))) return { ok: false, json: async () => ({ ok: false }) };
      if (tg[1] === 'createInvoiceLink') return ok({ ok: true, result: `https://t.me/$invoice-${payload.payload}` });
      if (tg[1] === 'getChatMemberCount') return ok({ ok: true, result: world.memberCounts[String(payload.chat_id)] ?? 0 });
      if (tg[1] === 'getChatMember') return ok({ ok: true, result: { status: (world.members.has(String(payload.user_id)) ? 'member' : 'left') } });
      return ok({ ok: true, result: true });
    }
    throw new Error(`Unexpected request ${href}`);
  };
  return Object.assign(world, { kv, sets, telegramCalls, blockedChats, sent: (method) => telegramCalls.filter((c) => c.method === method).map((c) => c.payload) });
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
