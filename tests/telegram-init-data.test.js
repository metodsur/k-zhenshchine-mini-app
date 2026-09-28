const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyInitData } = require('../lib/telegram');

// Synthetic test credential only; never use a production bot token here.
process.env.TELEGRAM_BOT_TOKEN = '123456:test-only-credential';
const user = { id: 123456789, first_name: 'Test' };
function fixture(extra = {}) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'test-query', user: JSON.stringify(user), ...extra };
  const check = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', key).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
async function authorize(path, initData) {
  let body;
  const res = { statusCode: 0, setHeader() {}, end(value) { body = JSON.parse(value); } };
  await require(path)({ method: 'POST', body: { initData } }, res);
  return { status: res.statusCode, body };
}
for (const path of ['../api/auth/telegram', '../api/telegram/telegram']) {
  test(`${path}: accepts HMAC covering signature`, async () => {
    const result = await authorize(path, fixture({ signature: 'synthetic-ed25519-value' }));
    assert.equal(result.status, 200);
    assert.equal(result.body.user.telegram_user_id, user.id);
  });
  test(`${path}: preserves payloads without signature`, async () => {
    assert.equal((await authorize(path, fixture())).status, 200);
  });
  test(`${path}: rejects a signature appended after signing`, async () => {
    assert.equal((await authorize(path, fixture() + '&signature=tampered')).status, 401);
  });
}
test('shared verifier accepts HMAC covering signature', () => {
  assert.deepEqual(verifyInitData(fixture({ signature: 'synthetic-ed25519-value' })), user);
});
test('shared verifier preserves payloads without signature', () => {
  assert.deepEqual(verifyInitData(fixture()), user);
});
test('shared verifier rejects a signature appended after signing', () => {
  assert.throws(() => verifyInitData(fixture() + '&signature=tampered'));
});
test('shared verifier rejects expired data', () => {
  assert.throws(() => verifyInitData(fixture({ auth_date: String(Math.floor(Date.now()/1000)-86401) })));
});
test('shared verifier rejects changed user data', () => {
  const data = new URLSearchParams(fixture({ signature: 'synthetic-ed25519-value' }));
  data.set('user', JSON.stringify({ ...user, id: 987654321 }));
  assert.throws(() => verifyInitData(data.toString()));
});
