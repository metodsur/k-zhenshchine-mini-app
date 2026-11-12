const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: '123456:test-only-credential',
  TELEGRAM_CLUB_CHAT_ID: '-1001234567890',
  CLUB_TELEGRAM_SECRET: 'test-club-secret'
});
const handler = require('../api/site/club-access');

function call(body, authorization = 'Bearer test-club-secret') {
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), payload: JSON.parse(options.body) });
    const method = String(url).split('/').pop();
    const result = method === 'createChatInviteLink' ? { invite_link: 'https://t.me/+test' } : {};
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = JSON.parse(value); } };
  return handler({ method: 'POST', headers: { authorization }, body }, res).then(() => ({ res, requests }));
}

test('invite is restricted to configured group, one member and a private message', async () => {
  const { res, requests } = await call({ action: 'invite', telegram_id: 42 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(requests.map((r) => r.url.split('/').pop()), ['unbanChatMember', 'createChatInviteLink', 'sendMessage']);
  assert.equal(requests[0].payload.chat_id, process.env.TELEGRAM_CLUB_CHAT_ID);
  assert.equal(requests[1].payload.member_limit, 1);
  assert.ok(requests[1].payload.expire_date > Math.floor(Date.now() / 1000));
  assert.equal(requests[2].payload.chat_id, 42);
  assert.match(requests[2].payload.text, /https:\/\/t\.me\/\+test/);
});

test('remove kicks without permanent ban and sends fixed message', async () => {
  const { res, requests } = await call({ action: 'remove', telegram_id: 42 });
  assert.equal(res.statusCode, 200);
  assert.equal(requests[0].url.endsWith('/banChatMember'), true);
  assert.equal(requests[1].payload.only_if_banned, true);
  assert.match(requests[2].payload.text, /Срок доступа к клубу завершился/);
});

test('notify accepts only allow-listed reminder timing and rejects arbitrary text', async () => {
  const rejected = await call({ action: 'notify', telegram_id: 42, daysBefore: 2, text: 'inject' });
  assert.equal(rejected.res.statusCode, 400);
  assert.equal(rejected.requests.length, 0);
  const accepted = await call({ action: 'notify', telegram_id: 42, daysBefore: 7, text: 'inject' });
  assert.equal(accepted.res.statusCode, 200);
  assert.match(accepted.requests[0].payload.text, /неделя/);
  assert.doesNotMatch(accepted.requests[0].payload.text, /inject/);
});

test('rejects missing/incorrect shared secret and malformed identifiers', async () => {
  assert.equal((await call({ action: 'invite', telegram_id: 42 }, 'Bearer wrong')).res.statusCode, 403);
  assert.equal((await call({ action: 'invite', telegram_id: '-100123' })).res.statusCode, 400);
});
