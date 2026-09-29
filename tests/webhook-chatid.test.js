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
