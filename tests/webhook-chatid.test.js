const test = require('node:test');
const assert = require('node:assert/strict');

// Synthetic test credentials only; never use production values here.
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: '123456:test-only-credential',
  TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
  TELEGRAM_CHANNEL_ID: '@test_channel',
  TELEGRAM_CHANNEL_URL: 'https://t.me/test_channel',
  APP_BASE_URL: 'https://example.test'
});

const handler = require('../api/telegram/webhook');

function mockTelegram(senderStatus) {
  const sent = [];
  global.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.endsWith('/getChatMember')) return { ok: true, json: async () => ({ ok: true, result: { status: senderStatus } }) };
    if (url.endsWith('/sendMessage')) { sent.push(payload); return { ok: true, json: async () => ({ ok: true, result: {} }) }; }
    throw new Error(`Unexpected request ${url}`);
  };
  return sent;
}

async function deliver(message) {
  const res = { statusCode: 0, setHeader() {}, end() {} };
  await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: { message } }, res);
  return res.statusCode;
}

const group = { id: -1009876543210, type: 'supergroup' };

test('/chatid in a group replies with the group ID to an admin', async () => {
  const sent = mockTelegram('administrator');
  assert.equal(await deliver({ chat: group, from: { id: 1 }, text: '/chatid' }), 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, group.id);
  assert.match(sent[0].text, /-1009876543210/);
});

test('/chatid@botname form also works', async () => {
  const sent = mockTelegram('creator');
  await deliver({ chat: group, from: { id: 1 }, text: '/chatid@k_bot' });
  assert.equal(sent.length, 1);
});

test('/chatid is ignored for regular group members', async () => {
  const sent = mockTelegram('member');
  await deliver({ chat: group, from: { id: 2 }, text: '/chatid' });
  assert.equal(sent.length, 0);
});

test('/chatid is ignored in private chats', async () => {
  const sent = mockTelegram('administrator');
  await deliver({ chat: { id: 3, type: 'private' }, from: { id: 3 }, text: '/chatid' });
  assert.equal(sent.length, 0);
});

test('joining the channel records the join date once and sends the welcome message', async () => {
  process.env.KV_REST_API_URL = 'https://redis.example.test';
  process.env.KV_REST_API_TOKEN = 'test-redis-token';
  const stored = {};
  const sent = [];
  global.fetch = async (url, options) => {
    const href = String(url);
    const payload = JSON.parse(options.body);
    if (href.startsWith('https://redis.example.test')) {
      const [cmd, key, field, value] = payload;
      assert.equal(cmd, 'HSETNX');
      const isNew = !stored[key];
      if (isNew) stored[key] = { [field]: value };
      return { ok: true, json: async () => ({ result: isNew ? 1 : 0 }) };
    }
    if (href.endsWith('/sendMessage')) { sent.push(payload); return { ok: true, json: async () => ({ ok: true, result: {} }) }; }
    throw new Error(`Unexpected request ${href}`);
  };
  const join = (date) => ({
    chat: { id: -100555, username: 'test_channel' }, date,
    old_chat_member: { status: 'left', user: { id: 77 } },
    new_chat_member: { status: 'member', user: { id: 77 } }
  });
  const deliverUpdate = async (update) => {
    const res = { statusCode: 0, setHeader() {}, end() {} };
    await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update }, res);
    return res.statusCode;
  };
  assert.equal(await deliverUpdate({ chat_member: join(1789000000) }), 200);
  await deliverUpdate({ chat_member: join(1790000000) });
  assert.equal(stored['user:77'].channel_joined_at, new Date(1789000000 * 1000).toISOString());
  assert.equal(sent.length, 2);
  assert.equal(sent[0].chat_id, 77);
});
