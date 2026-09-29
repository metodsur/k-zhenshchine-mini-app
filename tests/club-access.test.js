const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Synthetic test credentials only; never use production values here.
process.env.TELEGRAM_BOT_TOKEN = '123456:test-only-credential';
process.env.TELEGRAM_CLUB_CHAT_ID = '-1000000000001';
process.env.TELEGRAM_CLUB_URL = 'https://t.me/+test-club-link';

const handler = require('../api/auth/club');

function initData(userId) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: 'Test' }) };
  const check = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', key).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function mockTelegram(status) {
  global.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.match(url, /getChatMember$/);
    assert.equal(payload.chat_id, process.env.TELEGRAM_CLUB_CHAT_ID);
    if (status === 'error') return { ok: false, json: async () => ({ ok: false }) };
    return { ok: true, json: async () => ({ ok: true, result: { status } }) };
  };
}

async function call(body) {
  let result;
  const res = { statusCode: 0, setHeader() {}, end(value) { result = JSON.parse(value); } };
  await handler({ method: 'POST', body }, res);
  return { status: res.statusCode, body: result };
}

test('club member receives the club link', async () => {
  mockTelegram('member');
  const { status, body } = await call({ initData: initData(111) });
  assert.equal(status, 200);
  assert.equal(body.club_member, true);
  assert.equal(body.club_url, 'https://t.me/+test-club-link');
});

test('non-member does not receive the club link', async () => {
  mockTelegram('left');
  const { status, body } = await call({ initData: initData(222) });
  assert.equal(status, 200);
  assert.equal(body.club_member, false);
  assert.equal(body.club_url, null);
});

test('forged initData is rejected', async () => {
  mockTelegram('member');
  const forged = new URLSearchParams(initData(333));
  forged.set('user', JSON.stringify({ id: 444 }));
  assert.equal((await call({ initData: forged.toString() })).status, 401);
});

test('Telegram failure reports unavailable instead of granting access', async () => {
  mockTelegram('error');
  assert.equal((await call({ initData: initData(555) })).status, 503);
});
