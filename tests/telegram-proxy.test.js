const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { Writable } = require('node:stream');
const { setupEnv, createWorld } = require('./helpers/fake-world');
const client = require('../lib/telegram');
const PROXY = 'https://content.towomen.ru/cf-staging/api/workflow/local-telegram';
const TOKEN = '8824620595:' + 'synthetic_only_credential'.repeat(2);
const SECRET = 'synthetic-only-bridge-secret-longer-than-32';
const FILE_ID = 'received-file-abc';
const opaque = `local/${crypto.createHash('sha256').update(FILE_ID).digest('hex')}`;
const LOCAL_LIMIT = 6 * 1024 ** 3;
let world, bridge, requests, baseFetch;
function response(result) { return Response.json({ ok: true, result }); }
function configure() {
  for (const key of ['CF_TELEGRAM_API_BASE', 'CF_TELEGRAM_FILE_ROOT', 'VALKEY_URL', 'VALKEY_HOST', 'CF_AUTO_INTAKE']) delete process.env[key];
  setupEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_PROXY_URL: PROXY, CF_BRIDGE_ENABLED: '1', CF_BRIDGE_SECRET: SECRET,
    CONTENT_FACTORY_URL: 'https://factory.example.test', CF_ALLOWED_TELEGRAM_IDS: '900,901', ADMIN_TELEGRAM_IDS: '900,902' });
  world = createWorld(); baseFetch = global.fetch; requests = [];
  Object.assign(world, { metadata: { file_id: FILE_ID, file_path: opaque, file_size: 30 * 1024 * 1024 },
    bytes: Buffer.from('cross host private video'), downloadLength: undefined, failProxy: false, factory: [], identity: { id: 8824620595, is_bot: true, username: 'K_zhenshcine_bot' } });
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href === PROXY) {
      const envelope = options.body instanceof FormData ? { method: options.body.get('method'), token: options.body.get('token'), payload: JSON.parse(options.body.get('payload')) } : JSON.parse(options.body);
      requests.push({ href, envelope, options });
      assert.equal(options.redirect, 'error'); assert.equal(options.headers['x-cf-bridge-secret'], SECRET);
      assert.equal(envelope.token, TOKEN); assert.equal(href.includes(TOKEN), false);
      if (world.failProxy) throw new Error(`${TOKEN} ${SECRET} ${PROXY}?private=x`);
      if (envelope.method === 'getMe') return response(world.identity);
      if (envelope.method === 'getFile') return response(world.metadata);
      if (envelope.method === 'download') return new Response(world.bytes, { headers: world.downloadLength === null ? {} : { 'Content-Length': String(world.downloadLength ?? world.bytes.length) } });
      return response({ message_id: 42 });
    }
    if (href.endsWith('/api/workflow/telegram')) {
      world.factory.push(JSON.parse(options.body)); return response({ accepted: true });
    }
    if (href.startsWith('https://redis.example.test')) return baseFetch(url, options);
    assert.fail('unexpected external request: ' + href.replace(TOKEN, '[redacted]'));
  };
  delete require.cache[require.resolve('../lib/content-factory')];
  bridge = require('../lib/content-factory');
}
test.beforeEach(configure);
function message(extra = {}, userId = 900) { return { message_id: 17, from: { id: userId }, chat: { id: userId, type: 'private' }, ...extra }; }
function video(extra = {}, userId = 900) {
  return { update_id: 42, message: message({ video: { file_id: FILE_ID, file_unique_id: 'unique_abc', file_size: 30 * 1024 * 1024, mime_type: 'video/mp4', file_name: 'source.mp4' }, ...extra }, userId) };
}
async function intake() { await bridge.handleUpdate({ message: message({ text: '/reels' }) }); await bridge.handleUpdate(video()); }
function output() {
  const chunks = [];
  const res = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.headers = {}; res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = String(value); };
  return { res, chunks };
}
function noSecrets(value) {
  const text = JSON.stringify(value);
  for (const s of [TOKEN, SECRET, PROXY]) assert.equal(text.includes(s), false);
}

test('main client routes known setup, membership, message, payment and attachment calls using a private JSON envelope', async () => {
  for (const method of ['getMe', 'getWebhookInfo', 'sendMessage', 'sendVideo', 'sendDocument', 'sendPhoto', 'sendAudio', 'sendAnimation', 'sendVoice', 'sendVideoNote', 'getChatMember', 'getChatMemberCount', 'getChat', 'answerCallbackQuery', 'answerPreCheckoutQuery', 'editMessageText', 'editMessageReplyMarkup', 'pinChatMessage', 'createChatInviteLink', 'banChatMember', 'unbanChatMember', 'createInvoiceLink', 'setWebhook', 'setMyCommands', 'setChatMenuButton']) {
    await client.telegram(method, { synthetic: true }, { dispatcher: { cloudOnly: true } });
    assert.equal(requests.at(-1).envelope.method, method);
    assert.equal(Object.hasOwn(requests.at(-1).options, 'dispatcher'), false);
  }
  assert.ok(requests.every(r => r.href === PROXY));
});
test('configured invalid endpoint, token, or secret fails closed before any requests; no fallback or automatic retry', async () => {
  for (const bad of ['', 'http://127.0.0.1:8081', PROXY + '?x=1', PROXY.replace('content.towomen.ru', 'evil.example'), PROXY + '/']) {
    process.env.TELEGRAM_API_PROXY_URL = bad;
    await assert.rejects(client.telegram('sendMessage', {}), { code: 'TELEGRAM_PROXY_NOT_CONFIGURED' });
    await assert.rejects(client.telegramDownload(FILE_ID), { code: 'TELEGRAM_PROXY_NOT_CONFIGURED' });
    await assert.rejects(client.telegramUpload('sendDocument', {}, 'document', Buffer.from('x'), 'x'), { code: 'TELEGRAM_PROXY_NOT_CONFIGURED' });
  }
  process.env.TELEGRAM_API_PROXY_URL = PROXY;
  for (const token of ['123456:' + 'x'.repeat(30), TOKEN + '/getMe']) {
    process.env.TELEGRAM_BOT_TOKEN = token;
    await assert.rejects(client.telegram('getMe', {}), { code: 'TELEGRAM_PROXY_NOT_CONFIGURED' });
  }
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.CF_BRIDGE_SECRET = 'weak';
  await assert.rejects(client.telegram('getMe', {}), { code: 'TELEGRAM_PROXY_NOT_CONFIGURED' });
  assert.equal(requests.length, 0);
  process.env.CF_BRIDGE_SECRET = SECRET; world.failProxy = true;
  let telemetry;
  await assert.rejects(client.telegram('sendMessage', { text: 'ambiguous' }, { onFailure: (meta, e) => { telemetry = { meta, message: e.message }; } }), e => { noSecrets({ message: e.message, stack: e.stack }); return true; });
  noSecrets(telemetry); assert.equal(requests.length, 1);
});
test('absent flag preserves Cloud JSON, multipart and legacy download defaults', async () => {
  delete process.env.TELEGRAM_API_PROXY_URL;
  const seen = [];
  global.fetch = async (url, options = {}) => {
    seen.push({ url: String(url), options });
    if (String(url).includes('/file/bot')) return new Response('cloud bytes');
    if (String(url).endsWith('/getFile')) return response({ file_path: 'documents/safe' });
    return response({ message_id: 1 });
  };
  await client.telegram('sendMessage', { chat_id: 900, text: 'cloud' });
  assert.equal(seen[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(seen[0].options.body, JSON.stringify({ chat_id: 900, text: 'cloud' }));
  assert.equal(Object.hasOwn(seen[0].options, 'signal'), false);
  await client.telegramUpload('sendDocument', { chat_id: 900 }, 'document', Buffer.from('bytes'), 'a.txt', 'text/plain');
  assert.equal(seen[1].url, `https://api.telegram.org/bot${TOKEN}/sendDocument`);
  assert.equal(seen[1].options.body.get('chat_id'), '900');
  assert.equal(seen[1].options.body.has('token'), false);
  assert.equal((await client.telegramDownload(FILE_ID)).toString(), 'cloud bytes');
  assert.equal(seen.at(-1).url, `https://api.telegram.org/file/bot${TOKEN}/documents/safe`);
});
test('Cloud raw token-bearing fetch exceptions also never escape to legacy callers or telemetry', async () => {
  delete process.env.TELEGRAM_API_PROXY_URL;
  global.fetch = async () => { throw new Error(`https://api.telegram.org/bot${TOKEN}/getMe`); };
  await assert.rejects(client.telegram('getMe', {}), e => { noSecrets({ message: e.message, stack: e.stack }); return true; });
});
test('existing multipart upload encodes exact method/token/payload/file fields and does not retry', async () => {
  await client.telegramUpload('sendDocument', { chat_id: 900, caption: 'attachment' }, 'document', Buffer.from('bytes'), 'safe.txt', 'text/plain');
  const form = requests[0].options.body;
  assert.deepEqual([...form.keys()], ['method', 'token', 'payload', 'document']);
  assert.equal(form.get('document').size, 5);
  assert.equal(form.get('document').name, 'safe.txt');
  await assert.rejects(client.telegramUpload('sendDocument', {}, 'document', Buffer.from('x'), '../unsafe'), { code: 'INVALID_TELEGRAM_UPLOAD' });
  await assert.rejects(client.telegramUpload('sendPhoto', {}, 'photo', Buffer.from('x'), 'safe'), { code: 'INVALID_TELEGRAM_UPLOAD' });
  assert.equal(requests.length, 1);
});
test('reusable legacy download POSTs only a file ID and bounds declared and actual bytes', async () => {
  assert.deepEqual(await client.telegramDownload(FILE_ID), world.bytes);
  assert.deepEqual(requests[0].envelope, { method: 'download', payload: { file_id: FILE_ID }, token: TOKEN });
  world.downloadLength = LOCAL_LIMIT + 1;
  await assert.rejects(client.telegramDownload(FILE_ID), { code: 'LARGE_FILE' });
  world.downloadLength = null;
  await assert.rejects(client.telegramDownload(FILE_ID, { maxBytes: 3 }), { code: 'LARGE_FILE' });
  await assert.rejects(client.telegramDownload('../path'), { code: 'INVALID_TELEGRAM_FILE_ID' });
});
test('CF large metadata and downloads remain receipt-owner-bound before any upstream file request, with no MiniApp fs access', async t => {
  await intake(); requests.length = 0;
  t.mock.method(fs, 'realpath', async () => assert.fail('cross-host file must never resolve on MiniApp'));
  t.mock.method(fs, 'open', async () => assert.fail('cross-host file must never open on MiniApp'));
  const meta = await bridge.gateway('getFile', { chat_id: 900, file_id: FILE_ID });
  assert.equal(meta.file_size, 30 * 1024 * 1024); assert.equal(meta.file_path, opaque); assert.equal(meta.file_unique_id, 'unique_abc');
  requests.length = 0;
  for (const query of [{ chat_id: 901, file_id: FILE_ID }, { chat_id: 900, file_id: 'never_received' }]) {
    const o = output(); await assert.rejects(bridge.download({ query }, o.res), { code: 'FILE_NOT_AUTHORIZED' });
  }
  assert.equal(requests.length, 0);
  const o = output(); await bridge.download({ query: { chat_id: 900, file_id: FILE_ID } }, o.res);
  assert.deepEqual(Buffer.concat(o.chunks), world.bytes);
  assert.equal(o.res.headers['content-type'], 'video/mp4');
  assert.equal(o.res.headers['cache-control'], 'no-store');
  assert.equal(o.res.headers['x-content-type-options'], 'nosniff'); noSecrets(o.res.headers);
  assert.deepEqual(requests.map(r => r.envelope.method), ['getFile', 'download']);
  assert.deepEqual(requests.at(-1).envelope.payload, { file_id: FILE_ID });
});
test('CF proxy metadata rejects paths, foreign opaque handles and the local 6 GiB cap', async () => {
  await intake();
  for (const file_path of ['/absolute/server/file.mp4', 'videos/cloud.mp4', 'local/' + 'b'.repeat(64)]) {
    world.metadata.file_path = file_path;
    await assert.rejects(bridge.gateway('getFile', { chat_id: 900, file_id: FILE_ID }), { code: 'INVALID_TELEGRAM_FILE_PATH' });
  }
  world.metadata.file_path = opaque; world.metadata.file_size = LOCAL_LIMIT + 1;
  await assert.rejects(bridge.gateway('getFile', { chat_id: 900, file_id: FILE_ID }), { code: 'LARGE_FILE' });
  world.metadata.file_size = 123; world.downloadLength = LOCAL_LIMIT + 1;
  const o = output(); await assert.rejects(bridge.download({ query: { chat_id: 900, file_id: FILE_ID } }, o.res), { code: 'LARGE_FILE' });
});
test('CF stream is bounded by actual byte count/Content-Length and aborts upstream on consumer close', async () => {
  await intake();
  world.metadata.file_size = 123; world.downloadLength = 1;
  const mismatch = output(); await assert.rejects(bridge.download({ query: { chat_id: 900, file_id: FILE_ID } }, mismatch.res), { code: 'LARGE_FILE' });
  let receivedSignal;
  const previous = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url) === PROXY && JSON.parse(options.body).method === 'download') {
      receivedSignal = options.signal;
      return new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener('abort', () => controller.error(new Error(TOKEN)), { once: true });
      } }));
    }
    return previous(url, options);
  };
  const o = output();
  const promise = bridge.download({ query: { chat_id: 900, file_id: FILE_ID } }, o.res);
  while (!receivedSignal) await new Promise(resolve => setImmediate(resolve));
  o.res.destroy();
  await assert.rejects(promise, e => { noSecrets({ message: e.message }); return true; });
  assert.equal(receivedSignal.aborted, true);
});
test('actual certified Master photo consumer uses the common proxy download rather than getFile plus Cloud fetch', async t => {
  const masters = require('../lib/masters');
  t.mock.method(masters, 'getPerson', async () => ({ status: 'master', profile: { photo_file_id: FILE_ID } }));
  const { photoAction } = require('../lib/handlers/master');
  const o = output(); await photoAction({ query: { id: 900 } }, o.res);
  assert.equal(o.res.statusCode, 200); assert.deepEqual(Buffer.concat(o.chunks), world.bytes);
  assert.deepEqual(requests.map(r => r.envelope.method), ['download']);
});
test('server health uses main client in proxy mode and does not bypass an invalid flag', async () => {
  const { handle } = require('../server');
  const previous = global.fetch;
  global.fetch = async (url, options) => {
    const href = String(url);
    if (href.startsWith('https://qstash.upstash.io') || href.startsWith('https://tribute.tg')) return new Response('{}');
    return previous(url, options);
  };
  const o = output(); await handle({ url: '/healthz/deps' }, o.res);
  assert.equal(JSON.parse(Buffer.concat(o.chunks)).telegram, true);
  assert.deepEqual(requests.map(r => r.envelope.method), ['getMe']);
  process.env.TELEGRAM_API_PROXY_URL = 'invalid';
  const next = output(); await handle({ url: '/healthz/deps' }, next.res);
  assert.equal(JSON.parse(Buffer.concat(next.chunks)).telegram, false);
  assert.equal(requests.length, 1);
});
test('opt-in automatic intake accepts only authorized private standalone videos with no prior /reels mode', async () => {
  process.env.CF_AUTO_INTAKE = '1';
  assert.equal(await bridge.handleUpdate(video()), true);
  assert.equal(world.factory.length, 1);
  assert.deepEqual(world.factory[0], { kind: 'media', input: { updateId: 42, userId: '900', chatId: '900', messageId: 17,
    fileId: FILE_ID, fileUniqueId: 'unique_abc', fileName: 'source.mp4', fileSize: 30 * 1024 * 1024, mime: 'video/mp4' } });
  assert.equal(world.kv.has('cf:bridge:mode:900'), false);
  noSecrets(world.factory[0]);
});
test('automatic intake leaves wrong owners, legacy pending state, replies, albums and nonvideo messages untouched', async () => {
  process.env.CF_AUTO_INTAKE = '1';
  for (const userId of [901, 902, 999]) assert.equal(await bridge.handleUpdate(video({}, userId)), false);
  assert.equal(await bridge.handleUpdate(video({ chat: { id: -100, type: 'group' } })), false);
  world.kv.set('conv:900', JSON.stringify({ topic: 'task_comment' }));
  assert.equal(await bridge.handleUpdate(video()), false); world.kv.delete('conv:900');
  for (const prefix of ['tmsg', 'dbmsg']) {
    world.kv.set(`${prefix}:900:4`, 'legacy');
    assert.equal(await bridge.handleUpdate(video({ reply_to_message: { message_id: 4 } })), false);
    world.kv.delete(`${prefix}:900:4`);
  }
  assert.equal(await bridge.handleUpdate(video({ reply_to_message: { message_id: 999 } })), false);
  assert.equal(await bridge.handleUpdate(video({ media_group_id: 'album-1' })), false);
  assert.equal(await bridge.handleUpdate({ update_id: 44, message: message({ text: 'unrelated' }) }), false);
  assert.equal(await bridge.handleUpdate({ update_id: 44, message: message({ photo: [{ file_id: FILE_ID }] }) }), false);
  const animated = video(); animated.message.animation = animated.message.video; delete animated.message.video;
  assert.equal(await bridge.handleUpdate(animated), false);
  assert.equal(world.factory.length, 0); assert.equal(requests.length, 0);
});
test('absent automatic flag preserves legacy mode requirement and album handling', async () => {
  assert.equal(await bridge.handleUpdate(video()), false);
  await bridge.handleUpdate({ message: message({ text: '/reels' }) });
  assert.equal(await bridge.handleUpdate(video({ media_group_id: 'existing-album' })), true);
  assert.equal(world.factory[0].input.mediaGroupId, 'existing-album');
});

test('actual OS attachment consumer checks existing session/permissions before proxy download, including large-file forwarding', async t => {
  const auth = require('../lib/os-auth'), team = require('../lib/team'), database = require('../lib/database');
  let member = null;
  t.mock.method(auth, 'memberFromRequest', async () => member);
  t.mock.method(team, 'can', (m, permission) => !!m && permission === 'os.workspace');
  t.mock.method(database, 'find', async () => ({ title: 'Database', file_id: FILE_ID, mime: 'video/mp4', name: 'video.mp4', send: 'video' }));
  const handler = require('../api/os/[section]');
  const req = { method: 'GET', query: { section: 'file', db: 'entry-1' } };
  const denied = output(); await handler(req, denied.res);
  assert.equal(denied.res.statusCode, 401); assert.equal(requests.length, 0);
  member = { id: '900' };
  const o = output(); await handler(req, o.res);
  assert.equal(o.res.statusCode, 200); assert.deepEqual(Buffer.concat(o.chunks), world.bytes);
  assert.deepEqual(requests.map(r => r.envelope.method), ['download']);
  assert.equal(o.res.headers['content-type'], 'video/mp4');
  world.downloadLength = 51 * 1024 * 1024;
  const big = output(); await handler(req, big.res);
  assert.equal(big.res.statusCode, 200); assert.equal(big.res.headers['content-type'], 'text/html; charset=utf-8');
  assert.deepEqual(requests.at(-1).envelope, { method: 'sendVideo', payload: { chat_id: '900', video: FILE_ID, caption: '🗂 База данных: «Database»' }, token: TOKEN });
});
test('wrong proxied identity cannot persist intake mode, forward receipts or send bridge messages', async () => {
  world.identity = { id: 1, is_bot: true, username: 'K_zhenshcine_bot' };
  process.env.CF_AUTO_INTAKE = '1';
  await assert.rejects(bridge.handleUpdate(video()), { code: 'BOT_IDENTITY_MISMATCH' });
  assert.equal(world.factory.length, 0); assert.equal(world.kv.size, 0);
  assert.deepEqual(requests.map(r => r.envelope.method), ['getMe']);
});
test('nested token-bearing causes and URL fields are redacted even for default Cloud fetch failures', async () => {
  delete process.env.TELEGRAM_API_PROXY_URL;
  const error = Object.assign(new TypeError('fetch failed'), { cause: { message: 'private ' + TOKEN, url: `https://api.telegram.org/bot${TOKEN}/getMe` } });
  global.fetch = async () => { throw error; };
  let failure;
  await assert.rejects(client.telegram('getMe', {}, { onFailure: (_, e) => { failure = e; } }), e => e !== error);
  noSecrets({ message: failure.message, stack: failure.stack, cause: failure.cause });
});
