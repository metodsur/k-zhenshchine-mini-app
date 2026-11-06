const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setupEnv, createWorld, initData } = require('./helpers/fake-world');
setupEnv({ PRACTICE_REMOTE_OWNER_ID: '900' });
const handler = require('../api/practice-remote');
const OWNER = { id: 900, first_name: 'Owner' };
const OTHER = { id: 901, first_name: 'Other' };
const deviceId = '1d7e2b19-53d6-4a77-9c08-111111111111';
const requestId = 'a3d95e27-03d7-4ee9-9412-222222222222';

function oldInitData(user, ageSeconds) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds), user: JSON.stringify(user) };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', key).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
async function call(req) {
  let body;
  const res = { statusCode: 0, setHeader() {}, end(value) { body = value ? JSON.parse(value) : undefined; } };
  await handler({ headers: {}, ...req }, res);
  return { status: res.statusCode, body };
}
function post(data) { return { method: 'POST', body: data }; }

test('practice remote: owner-only authorization and fresh initData required', async () => {
  createWorld();
  assert.equal((await call(post({ action: 'enable', initData: initData(OTHER), deviceId }))).status, 401);
  assert.equal((await call(post({ action: 'enable', initData: oldInitData(OWNER, 301), deviceId }))).status, 401);
  assert.equal((await call(post({ action: 'enable', initData: initData(OWNER), deviceId: 'bad' }))).status, 400);
});

test('practice remote: closed by default; allowlist command delivered once only', async () => {
  createWorld();
  const auth = initData(OWNER);
  let r = await call(post({ action: 'command', initData: auth, deviceId, requestId, path: '/practice' }));
  assert.equal(r.status, 409, 'command rejected before device opt-in');
  r = await call(post({ action: 'enable', initData: auth, deviceId }));
  assert.equal(r.status, 200);
  const token = r.body.token;
  assert.equal(r.body.expiresIn, 1800);
  assert.equal((await call(post({ action: 'status', initData: auth, deviceId }))).body.enabled, true);
  assert.equal((await call(post({ action: 'command', initData: auth, deviceId, requestId, path: '/arbitrary' }))).status, 400);
  r = await call(post({ action: 'command', initData: auth, deviceId, requestId, path: '/practice' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.practice, 'Практика многомерности');
  assert.equal((await call(post({ action: 'command', initData: auth, deviceId, requestId, path: '/practice' }))).body.duplicate, true);
  const poll = (pollInitData = auth) => call({ method: 'GET', query: { deviceId }, headers: { authorization: `Bearer ${token}`, 'x-telegram-init-data': pollInitData } });
  assert.equal((await call({ method: 'GET', query: { deviceId }, headers: { authorization: `Bearer ${token}` } })).status, 401, 'missing signed Telegram identity is rejected');
  assert.equal((await poll(initData(OTHER))).status, 401, 'another Telegram account cannot poll with the saved browser token');
  assert.equal((await poll(oldInitData(OWNER, 1801))).status, 401, 'expired Telegram identity cannot poll');
  assert.equal((await call({ method: 'GET', query: { deviceId }, headers: { authorization: 'Bearer wrong', 'x-telegram-init-data': auth } })).status, 401);
  r = await poll();
  assert.deepEqual(r.body.command, { id: requestId, path: '/practice', issuedAt: r.body.command.issuedAt });
  assert.equal((await poll()).body.command, null, 'the command must not replay');
  assert.equal((await call(post({ action: 'disable', initData: auth, deviceId }))).body.enabled, false);
  assert.equal((await poll()).status, 401);
  assert.equal((await call(post({ action: 'command', initData: auth, deviceId, requestId: 'b3d95e27-03d7-4ee9-9412-222222222222', path: '/practice' }))).status, 409);
});

test('practice remote: all five routes are the only accepted destinations', async () => {
  createWorld();
  const auth = initData(OWNER);
  await call(post({ action: 'enable', initData: auth, deviceId }));
  for (const path of ['/practice', '/integrity', '/accept', '/abundance', '/mirror']) {
    const id = crypto.randomUUID();
    const result = await call(post({ action: 'command', initData: auth, deviceId, requestId: id, path }));
    assert.equal(result.status, 200, path);
  }
});

test('practice remote: command requests are rate limited', async () => {
  createWorld();
  const auth = initData(OWNER);
  await call(post({ action: 'enable', initData: auth, deviceId }));
  const results = [];
  for (let i = 0; i < 21; i += 1) {
    results.push(await call(post({ action: 'command', initData: auth, deviceId, requestId: crypto.randomUUID(), path: '/practice' })));
  }
  assert.ok(results.slice(0, 20).every((r) => r.status === 200));
  assert.equal(results[20].status, 429);
});
