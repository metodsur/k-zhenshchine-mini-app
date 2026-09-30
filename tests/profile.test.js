const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Synthetic test credentials only; never use production values here.
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: '123456:test-only-credential',
  TELEGRAM_CHANNEL_ID: '@test_channel',
  TELEGRAM_CLUB_CHAT_ID: '-1000000000001',
  TELEGRAM_CLUB_URL: 'https://t.me/+test-club-link',
  TRIBUTE_API_KEY: 'test-tribute-key',
  KV_REST_API_URL: 'https://redis.example.test',
  KV_REST_API_TOKEN: 'test-redis-token'
});

const handler = require('../api/auth/me');
const tribute = require('../lib/tribute');

function initData(user) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) };
  const check = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', key).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

// Fake Telegram, Tribute and Redis in one fetch mock.
function mockWorld({ channel = 'member', club = 'member', subscribers = [], redis = {} } = {}) {
  tribute.resetCache();
  const writes = [];
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    const ok = (result) => ({ ok: true, json: async () => result });
    if (href.includes('api.telegram.org')) {
      const { chat_id } = JSON.parse(options.body);
      const status = chat_id === process.env.TELEGRAM_CLUB_CHAT_ID ? club : channel;
      if (status === 'error') return { ok: false, json: async () => ({ ok: false }) };
      return ok({ ok: true, result: { status } });
    }
    if (href.startsWith('https://tribute.tg/api/v1/subscribers')) {
      assert.equal(options.headers['Api-Key'], 'test-tribute-key');
      return ok(subscribers);
    }
    if (href.startsWith('https://redis.example.test')) {
      const [cmd, keyName, field, value] = JSON.parse(options.body);
      const map = redis[keyName] || (redis[keyName] = {});
      if (cmd === 'HGET') return ok({ result: map[field] ?? null });
      if (cmd === 'HSETNX') {
        if (map[field]) return ok({ result: 0 });
        map[field] = value; writes.push([keyName, field, value]); return ok({ result: 1 });
      }
    }
    throw new Error(`Unexpected request ${href}`);
  };
  return { writes, redis };
}

async function call(user) {
  let body;
  const res = { statusCode: 0, setHeader() {}, end(value) { body = JSON.parse(value); } };
  await handler({ method: 'POST', body: { initData: initData(user) } }, res);
  return { status: res.statusCode, body };
}

test('returns real name, recorded join date and club subscription dates', async () => {
  mockWorld({
    redis: { 'user:10': { channel_joined_at: '2026-09-05T10:00:00.000Z' } },
    subscribers: [
      { telegramUserId: 99, status: 'active', activatedAt: '2026-09-01T00:00:00Z', expireAt: '2026-10-01T00:00:00Z' },
      { telegramUserId: 10, status: 'cancelled', activatedAt: '2026-06-01T00:00:00Z', expireAt: '2026-07-01T00:00:00Z' },
      { telegramUserId: 10, status: 'active', activatedAt: '2026-09-12T00:00:00Z', expireAt: '2026-10-12T00:00:00Z' }
    ]
  });
  const { status, body } = await call({ id: 10, first_name: 'Анна' });
  assert.equal(status, 200);
  assert.equal(body.user.first_name, 'Анна');
  assert.deepEqual(body.space, { member: true, joined_at: '2026-09-05T10:00:00.000Z', joined_at_source: 'recorded' });
  assert.equal(body.club.member, true);
  assert.equal(body.club.url, 'https://t.me/+test-club-link');
  assert.equal(body.club.status, 'active');
  assert.equal(body.club.activated_at, '2026-09-12T00:00:00Z');
  assert.equal(body.club.expires_at, '2026-10-12T00:00:00Z');
});

test('channel member without a recorded date gets first-visit date saved once', async () => {
  const world = mockWorld();
  const first = await call({ id: 20, first_name: 'Мария' });
  assert.equal(first.body.space.joined_at_source, 'first_seen');
  assert.ok(first.body.space.joined_at);
  assert.equal(world.writes.length, 1);
  const second = await call({ id: 20, first_name: 'Мария' });
  assert.equal(second.body.space.joined_at, first.body.space.joined_at);
  assert.equal(second.body.space.joined_at_source, 'recorded');
  assert.equal(world.writes.length, 1);
});

test('non-member of the club gets no club link and no dates', async () => {
  mockWorld({ club: 'left' });
  const { body } = await call({ id: 30, first_name: 'Ольга' });
  assert.equal(body.club.member, false);
  assert.equal(body.club.url, null);
  assert.equal(body.club.expires_at, null);
});

test('Tribute or Telegram outages do not break the profile', async () => {
  mockWorld({ club: 'error' });
  global.fetch = ((original) => async (url, options) => {
    if (String(url).startsWith('https://tribute.tg')) return { ok: false, status: 500, json: async () => ({}) };
    return original(url, options);
  })(global.fetch);
  const { status, body } = await call({ id: 40, first_name: 'Ирина' });
  assert.equal(status, 200);
  assert.equal(body.user.first_name, 'Ирина');
  assert.equal(body.club.member, null);
  assert.equal(body.club.url, null);
  assert.equal(body.club.status, null);
});

test('forged initData is rejected', async () => {
  mockWorld();
  const forged = new URLSearchParams(initData({ id: 50, first_name: 'X' }));
  forged.set('user', JSON.stringify({ id: 51, first_name: 'Y' }));
  let status;
  const res = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader() {}, end() {} };
  await handler({ method: 'POST', body: { initData: forged.toString() } }, res);
  assert.equal(status, 401);
});
