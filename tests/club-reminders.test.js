const test = require('node:test');
const assert = require('node:assert/strict');

// Synthetic test credentials only; never use production values here.
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: '123456:test-only-credential',
  TRIBUTE_API_KEY: 'test-tribute-key',
  KV_REST_API_URL: 'https://redis.example.test',
  KV_REST_API_TOKEN: 'test-redis-token',
  CRON_SECRET: 'test-cron-secret'
});

const handler = require('../lib/handlers/club-reminders');
const cronRoute = require('../api/cron/[job]');
const tribute = require('../lib/tribute');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T07:00:00Z');

function mockWorld(subscribers, { blockedUsers = [] } = {}) {
  tribute.resetCache();
  const sent = [];
  const claimed = new Set();
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    const ok = (result) => ({ ok: true, json: async () => result });
    if (href.startsWith('https://tribute.tg')) return ok({ result: subscribers });
    if (href.startsWith('https://redis.example.test')) {
      const [cmd, key] = JSON.parse(options.body);
      assert.equal(cmd, 'SET');
      if (claimed.has(key)) return ok({ result: null });
      claimed.add(key); return ok({ result: 'OK' });
    }
    if (href.endsWith('/sendMessage')) {
      const payload = JSON.parse(options.body);
      if (blockedUsers.includes(payload.chat_id)) return { ok: false, json: async () => ({ ok: false }) };
      sent.push(payload); return ok({ ok: true, result: {} });
    }
    throw new Error(`Unexpected request ${href}`);
  };
  return sent;
}

const iso = (ms) => new Date(ms).toISOString();

test('reminds active and cancelled-but-paid members 3 days before expiry, once', async () => {
  const sent = mockWorld([
    { telegramUserId: 1, status: 'active', expireAt: iso(NOW + 3 * DAY - 60 * 60 * 1000), link: 'https://t.me/tribute/app?startapp=sub1' },
    { telegramUserId: 2, status: 'pre_cancelled', expireAt: iso(NOW + 2.5 * DAY) },
    { telegramUserId: 3, status: 'active', expireAt: iso(NOW + 10 * DAY) },
    { telegramUserId: 4, status: 'cancelled', expireAt: iso(NOW + 3 * DAY - 1000) },
    { telegramUserId: 5, status: 'active', expireAt: iso(NOW + 1 * DAY) }
  ]);
  const first = await handler.runReminders(NOW);
  assert.deepEqual(first, { checked: 5, sent: 2, skipped: 0, failed: 0 });
  assert.deepEqual(sent.map((m) => m.chat_id), [1, 2]);
  assert.match(sent[0].text, /продлится твоя подписка/);
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].url, 'https://t.me/tribute/app?startapp=sub1');
  assert.match(sent[1].text, /доступ к клубу «к Женщине» открыт до/);
  assert.equal(sent[1].reply_markup.inline_keyboard[0][0].url, 'https://t.me/tribute/app?startapp=s17IJ');

  const second = await handler.runReminders(NOW + 60 * 60 * 1000);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 2);
});

test('a member who never started the bot is counted as failed, others still get reminders', async () => {
  const sent = mockWorld([
    { telegramUserId: 7, status: 'active', expireAt: iso(NOW + 2.9 * DAY) },
    { telegramUserId: 8, status: 'active', expireAt: iso(NOW + 2.9 * DAY) }
  ], { blockedUsers: [7] });
  const result = await handler.runReminders(NOW);
  assert.equal(result.failed, 1);
  assert.equal(result.sent, 1);
  assert.equal(sent[0].chat_id, 8);
});

test('cron endpoint requires the Vercel cron secret', async () => {
  mockWorld([]);
  const call = async (authorization) => {
    const res = { statusCode: 0, setHeader() {}, end() {} };
    await cronRoute({ method: 'GET', query: { job: 'club-reminders' }, headers: authorization ? { authorization } : {} }, res);
    return res.statusCode;
  };
  assert.equal(await call(), 403);
  assert.equal(await call('Bearer wrong'), 403);
  assert.equal(await call('Bearer test-cron-secret'), 200);
});
