const test = require('node:test');
const assert = require('node:assert/strict');
const { record } = require('../lib/cf-telegram-diagnostics');
const { telegram } = require('../lib/telegram');

test('CF telemetry emits a fixed record, never raw errors, tokens, URLs or arbitrary fields', () => {
  const secret = 'token-and-private-url';
  const error = Object.assign(new Error(secret), { name: secret, code: secret, url: secret, stack: secret, cause: { code: 'ECONNRESET', message: secret } });
  const got = record('getFile', 'cloud', { phase: 'fetch', elapsedMs: 125, upstreamStatus: null, headers: secret, payload: secret }, error);
  assert.deepEqual(got.transportCodes, ['OTHER', 'ECONNRESET']);
  assert.equal(got.exceptionClass, 'OTHER');
  assert.equal(got.phase, 'fetch');
  assert.ok(!JSON.stringify(got).includes(secret));
  assert.equal(Object.keys(got).length, 9);
});

test('CF telemetry clamps numeric fields and bounded aggregate causes', () => {
  const error = new AggregateError([{ code: 'ENETUNREACH' }, { code: 'ETIMEDOUT' }]);
  const got = record('getMe', 'cloud', { phase: 'api', elapsedMs: 99, upstreamStatus: 401, apiErrorCode: 401 }, error);
  assert.deepEqual(got.transportCodes, ['ENETUNREACH', 'ETIMEDOUT']);
  assert.equal(got.upstreamStatus, 401);
  assert.equal(got.apiErrorCode, 401);
  assert.equal(record('invalid', 'bad', { phase: 'raw', elapsedMs: Infinity, upstreamStatus: '401' }, {}).upstreamStatus, null);
});

test('optional CF callback sees safe upstream metadata; legacy error remains unchanged', async () => {
  const beforeFetch = global.fetch, beforeToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-only';
  global.fetch = async () => ({ status: 429, ok: false, json: async () => ({ ok: false, error_code: 429, description: 'do-not-log' }) });
  let meta;
  try {
    await assert.rejects(telegram('getMe', {}, { onFailure: (m) => { meta = m; } }), /Telegram getMe failed/);
    assert.equal(meta.phase, 'api'); assert.equal(meta.upstreamStatus, 429); assert.equal(meta.apiErrorCode, 429);
    assert.equal(Object.hasOwn(meta, 'description'), false);
    await assert.rejects(telegram('getMe', {}), /Telegram getMe failed/);
    await assert.rejects(telegram('getMe', {}, { onFailure: () => { throw Error('telemetry failure'); } }), /Telegram getMe failed/);
  } finally {
    global.fetch = beforeFetch;
    if (beforeToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = beforeToken;
  }
});

test('optional telemetry distinguishes fetch exceptions without altering the request transport', async () => {
  const beforeFetch = global.fetch, beforeToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-only';
  const error = Object.assign(new TypeError('fetch failed (private URL)'), { cause: { code: 'ENETUNREACH' } });
  global.fetch = async () => { throw error; };
  let diagnostic;
  try {
    await assert.rejects(telegram('getMe', {}, { onFailure: (meta, e) => { diagnostic = record('getMe', 'cloud', meta, e); } }), e => e === error);
    assert.equal(diagnostic.phase, 'fetch'); assert.equal(diagnostic.upstreamStatus, null);
    assert.deepEqual(diagnostic.transportCodes, ['ENETUNREACH']);
    assert.ok(!JSON.stringify(diagnostic).includes('private URL'));
  } finally {
    global.fetch = beforeFetch;
    if (beforeToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = beforeToken;
  }
});
