const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { setupEnv, createWorld, call } = require('./helpers/fake-world');
let bridge = require('../lib/content-factory');
let gatewayHandler = require('../api/content-factory/telegram');
const webhook = require('../api/telegram/webhook');
const TOKEN = '123456:test-only-credential';
const SECRET = 'test-cf-secret-at-least-32-characters';
let world;

function reset() {
  for (const key of ['VALKEY_URL', 'VALKEY_HOST', 'CF_TELEGRAM_API_BASE', 'CF_TELEGRAM_FILE_ROOT']) delete process.env[key];
  setupEnv({ CF_BRIDGE_ENABLED: '1', CF_BRIDGE_SECRET: SECRET, CONTENT_FACTORY_URL: 'https://factory.example.test', CF_ALLOWED_TELEGRAM_IDS: '900,901', ADMIN_TELEGRAM_IDS: '900;902' });
  // Each synthetic world has an independent process-local identity cache, with no production test hook.
  delete require.cache[require.resolve('../lib/content-factory')];
  delete require.cache[require.resolve('../api/content-factory/telegram')];
  bridge = require('../lib/content-factory');
  gatewayHandler = require('../api/content-factory/telegram');
  const fake = createWorld();
  const baseFetch = global.fetch;
  Object.assign(fake, { factory: [], requests: [], metadata: null, fileBytes: Buffer.from('video bytes'), factoryDown: false, telegramError: false,
    identity: { id: 1, is_bot: true, username: 'K_zhenshcine_bot', has_main_web_app: false }, identityError: false });
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    fake.requests.push({ url: href, options });
    // Intercept the actual read, including existing local Bot API URLs; never use a generic result fallback.
    if (href.endsWith('/getMe')) {
      fake.telegramCalls.push({ method: 'getMe', payload: JSON.parse(options.body) });
      if (fake.identityError || fake.telegramError) throw new Error(`secret ${TOKEN} ${SECRET}`);
      return { ok: true, json: async () => ({ ok: true, result: fake.identity }) };
    }
    if (href.endsWith('/api/workflow/telegram')) {
      fake.factory.push({ url: href, headers: options.headers, body: JSON.parse(options.body) });
      if (fake.factoryDown) throw new Error(`https://api.telegram.org/bot${TOKEN}/secret`);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (/\/(?:file\/bot|bot)[^/]+\//.test(href) && !href.startsWith('https://api.telegram.org/')) {
      if (href.includes('/file/bot')) return new Response(fake.fileBytes);
      fake.telegramCalls.push({ method: href.split('/').pop(), payload: JSON.parse(options.body) });
      if (fake.telegramError) throw new Error(`secret ${TOKEN} ${SECRET}`);
      return { ok: true, json: async () => ({ ok: true, result: fake.metadata }) };
    }
    if (href.includes('api.telegram.org/file/bot')) return new Response(fake.fileBytes, { headers: { 'Content-Length': fake.fileBytes.length } });
    if (href.endsWith('/getFile') && fake.metadata) {
      fake.telegramCalls.push({ method: 'getFile', payload: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: fake.metadata }) };
    }
    if (href.endsWith('/getWebhookInfo')) return { ok: true, json: async () => ({ ok: true, result: { url: `https://app.example.test/${TOKEN}`, last_error_message: TOKEN, pending_update_count: 2, allowed_updates: ['message'] } }) };
    if (fake.telegramError && href.startsWith('https://api.telegram.org/')) throw new Error(`secret ${TOKEN} ${SECRET}`);
    return baseFetch(url, options);
  };
  return fake;
}
test.beforeEach(() => { world = reset(); });
function message(extra = {}, userId = 900) {
  return { message_id: 17, from: { id: userId, first_name: 'Test' }, chat: { id: userId, type: 'private' }, ...extra };
}
function video(extra = {}) {
  return { update_id: 42, message: message({ video: { file_id: 'file-abc', file_unique_id: 'unique-abc', file_size: 123, mime_type: 'video/mp4', file_name: 'source.mp4' }, ...extra }) };
}
async function mode(userId = 900) { return bridge.handleUpdate({ update_id: 1, message: message({ text: '/reels' }, userId) }); }
async function post(method, payload, headers = { 'x-cf-bridge-secret': SECRET }) {
  return call(gatewayHandler, { method: 'POST', headers, body: { method, payload } });
}
function callback(extra = {}) {
  return { callback_query: { id: 'cb-123', from: { id: 900 }, message: message(), data: `cf:${'a'.repeat(32)}:1:status`, ...extra } };
}
async function deliver(update) {
  return call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });
}
function signedUrl(extra = '') {
  return `${process.env.CONTENT_FACTORY_URL}/api/public/1/%D0%A0%D0%B8%D0%BB%D1%81.mp4?exp=${Math.floor(Date.now() / 1000) + 3600}&sig=${'a'.repeat(64)}${extra}`;
}
async function getFile(query, headers = { 'x-cf-bridge-secret': SECRET }) {
  const chunks = [];
  const res = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = String(value); };
  res.statusCode = 0;
  await gatewayHandler({ method: 'GET', headers, query }, res);
  return { status: res.statusCode, bytes: Buffer.concat(chunks), headers: res.headers };
}

test('disabled bridge is inert and the protected endpoint is unavailable', async () => {
  delete process.env.CF_BRIDGE_ENABLED;
  assert.equal(await mode(), false);
  assert.equal(await bridge.handleUpdate(video()), false);
  assert.equal(await bridge.handleUpdate(callback()), false);
  assert.equal((await post('getMe', {})).status, 404);
  assert.equal(world.requests.length, 0);
});
test('requires both existing ADMIN authorization and explicit allowlist, plus exact private ownership', async () => {
  assert.equal(bridge.authorized(900), true);
  assert.equal(bridge.authorized(901), false); // allowlist only
  assert.equal(bridge.authorized(902), false); // ADMIN only
  assert.equal(bridge.authorized(900, 901), false);
  assert.equal(bridge.authorized('secret'), false);
  for (const userId of [901, 902, 999]) assert.equal(await mode(userId), false);
  assert.equal(await bridge.handleUpdate({ message: message({ text: '/reels', chat: { id: -1, type: 'group' } }) }), false);
  assert.equal(world.requests.length, 0);
});
test('/reels persists isolated mode, preserves legacy state, and /reels_off disables new intake', async () => {
  world.kv.set('conv:900', JSON.stringify({ topic: 'db_file', item_id: 'db1' }));
  assert.equal(await mode(), true);
  assert.equal(world.kv.get('cf:bridge:mode:900'), 'true');
  assert.equal(JSON.parse(world.kv.get('conv:900')).topic, 'db_file');
  assert.equal(await bridge.handleUpdate(video()), false);
  world.kv.delete('conv:900');
  assert.equal(await bridge.handleUpdate(video()), true);
  assert.equal(await bridge.handleUpdate({ message: message({ text: '/reels_off@existing_bot' }) }), true);
  assert.equal(await bridge.handleUpdate(video()), false);
  assert.equal(world.factory.length, 1);
});
test('media intake is opt-in and sends exact MediaInput with update, unique and album IDs', async () => {
  assert.equal(await bridge.handleUpdate(video()), false);
  await mode();
  assert.equal(await bridge.handleUpdate(video({ media_group_id: 'album-1' })), true);
  const request = world.factory[0];
  assert.equal(request.url, 'https://factory.example.test/api/workflow/telegram');
  assert.equal(request.headers['x-cf-bridge-secret'], SECRET);
  assert.deepEqual(request.body, { kind: 'media', input: { updateId: 42, userId: '900', chatId: '900', messageId: 17, fileId: 'file-abc', fileUniqueId: 'unique-abc', fileName: 'source.mp4', fileSize: 123, mime: 'video/mp4', mediaGroupId: 'album-1' } });
  assert.equal(JSON.stringify(request).includes(TOKEN), false);
  await bridge.handleUpdate(video()); // factory, not the bridge, atomically owns dedupe
  assert.equal(world.factory.length, 2);
});
test('video documents accept supported video MIME or unambiguous generic video extensions only', async () => {
  await mode();
  const document = { file_id: 'doc1', file_unique_id: 'uniq1', file_name: 'clip.MOV', mime_type: 'application/octet-stream', file_size: 100 };
  assert.equal(await bridge.handleUpdate({ update_id: 43, message: message({ document }) }), true);
  assert.equal(world.factory[0].body.input.mime, 'video/quicktime');
  for (const change of [{ mime_type: 'application/pdf' }, { file_name: 'fake.pdf' }, { file_name: 'clip.mkv' }, { file_name: 'clip.avi' },
    { mime_type: 'video/x-matroska' }, { mime_type: 'video/x-msvideo' }, { mime_type: 'video/unknown' },
    { file_name: 'clip.avi', mime_type: 'video/mp4' }, { file_id: `https://api.telegram.org/bot${TOKEN}/file` }, { file_unique_id: '' }, { file_size: -1 }]) {
    assert.equal(await bridge.handleUpdate({ update_id: 44, message: message({ document: { ...document, ...change } }) }), false);
  }
  assert.equal(bridge.mediaInput({ ...video(), update_id: undefined }), null);
  assert.equal(world.factory.length, 1);
});
test('bridge never takes existing state or a task/database reply even if a legacy handler did not finish', async () => {
  await mode();
  for (const topic of ['task_comment', 'task_review', 'db_file', 'broadcast']) {
    world.kv.set('conv:900', JSON.stringify({ topic }));
    assert.equal(await bridge.handleUpdate(video()), false);
  }
  world.kv.delete('conv:900');
  for (const prefix of ['tmsg', 'dbmsg']) {
    world.kv.set(`${prefix}:900:4`, 'legacy-id');
    assert.equal(await bridge.handleUpdate(video({ reply_to_message: { message_id: 4 } })), false);
    world.kv.delete(`${prefix}:900:4`);
  }
  assert.equal(world.factory.length, 0);
});
test('webhook database file and task attachment handlers retain precedence with intake enabled', async () => {
  await mode();
  world.kv.set('os:db', JSON.stringify([{ id: 'db1', title: 'Database', by_id: '900' }]));
  world.kv.set('conv:900', JSON.stringify({ topic: 'db_file', item_id: 'db1' }));
  assert.equal((await deliver(video())).status, 200);
  assert.equal(JSON.parse(world.kv.get('os:db'))[0].file_id, 'file-abc');
  world.kv.set('os:tasks', JSON.stringify([{ id: 'task1', title: 'Task', status: 'todo' }]));
  world.kv.set('tmsg:900:9', 'task1');
  assert.equal((await deliver(video({ reply_to_message: { message_id: 9 } }))).status, 200);
  assert.equal(JSON.parse(world.kv.get('os:tasks'))[0].attachments[0].file_id, 'file-abc');
  assert.equal(world.factory.length, 0);
});
test('generic text and replies are untouched; only gateway ForceReply prompts authorize workflow text', async () => {
  await mode();
  assert.equal(await bridge.handleUpdate({ message: message({ text: 'do not intercept' }) }), false);
  const normal = await post('sendMessage', { chat_id: '900', text: 'normal notice' });
  const normalId = normal.body.result.message_id;
  assert.equal(await bridge.handleUpdate({ message: message({ text: 'plain reply', reply_to_message: { message_id: normalId } }) }), false);
  const prompt = await post('sendMessage', { chat_id: '900', text: 'ISO date?', reply_markup: { force_reply: true, selective: true } });
  const replyTo = prompt.body.result.message_id;
  await bridge.handleUpdate({ message: message({ text: '/reels_off' }) });
  assert.equal(await bridge.handleUpdate({ message: message({ text: '2030-01-01T12:00:00+03:00', reply_to_message: { message_id: replyTo } }) }), true);
  assert.deepEqual(world.factory[0].body, { kind: 'text', userId: '900', chatId: '900', text: '2030-01-01T12:00:00+03:00', replyTo });
  world.kv.set('conv:900', JSON.stringify({ topic: 'task_new' }));
  assert.equal(await bridge.handleUpdate({ message: message({ text: 'legacy reply', reply_to_message: { message_id: replyTo } }) }), false);
});
test('unrelated authorized replies and media do not become bridge failures when no factory is configured', async () => {
  delete process.env.CONTENT_FACTORY_URL;
  assert.equal(await bridge.handleUpdate({ message: message({ text: 'plain reply', reply_to_message: { message_id: 8 } }) }), false);
  assert.equal(await bridge.handleUpdate(video()), false);
});
test('cf callbacks go directly to factory, with auth, no intake requirement, and scoped answers', async () => {
  assert.equal((await deliver(callback())).status, 200);
  assert.deepEqual(world.factory[0].body, { kind: 'callback', userId: '900', chatId: '900', id: 'cb-123', data: `cf:${'a'.repeat(32)}:1:status`, messageId: 17 });
  assert.equal((await post('answerCallbackQuery', { callback_query_id: 'cb-123', text: 'OK' })).status, 200);
  assert.equal((await post('answerCallbackQuery', { callback_query_id: 'secret' })).status, 403);
  assert.equal(await bridge.handleUpdate(callback({ from: { id: 901 } })), true);
  assert.equal(await bridge.handleUpdate(callback({ data: 'cf:malformed' })), true);
  assert.equal(world.factory.length, 1);
});
test('factory failures cause a retryable webhook 503 without exporting secrets', async () => {
  await mode();
  world.factoryDown = true;
  const response = await deliver(video());
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response).includes(TOKEN), false);
  assert.equal(JSON.stringify(response).includes(SECRET), false);
});
test('disabled webhook behavior and existing non-CF callbacks are preserved', async () => {
  delete process.env.CF_BRIDGE_ENABLED;
  assert.equal((await deliver({ message: message({ text: '/space' }) })).status, 200);
  assert.ok(world.sent('sendMessage').length);
  assert.equal((await deliver(callback({ data: 'not-cf' }))).status, 200);
  assert.equal(world.factory.length, 0);
});
test('gateway uses constant-time secret auth, an exact operation allowlist, and outbound owner allowlist', async () => {
  for (const headers of [{}, { 'x-cf-bridge-secret': '' }, { 'x-cf-bridge-secret': 'different' }, { 'x-cf-bridge-secret': SECRET + 'x' }]) assert.equal((await post('getMe', {}, headers)).status, 403);
  for (const method of ['setWebhook', 'deleteMessage', 'sendPhoto', 'constructor', '__proto__']) assert.equal((await post(method, {})).status, 400);
  for (const chat_id of [901, 902, -100, '@channel', 'secret']) assert.equal((await post('sendMessage', { chat_id, text: 'no' })).status, 403);
  assert.equal((await post('sendMessage', { chat_id: 900, text: 'hello', token: TOKEN })).status, 400);
  assert.equal((await post('sendMessage', { chat_id: 900, text: 'hello' })).status, 200);
  assert.equal((await call(gatewayHandler, { method: 'DELETE', headers: { 'x-cf-bridge-secret': SECRET } })).status, 405);
  assert.equal((await call(gatewayHandler, { method: 'POST', headers: { 'x-cf-bridge-secret': SECRET }, body: 'invalid json' })).status, 400);
});
test('egress media accepts only HTTPS signed factory public routes, with no raw uploads or arbitrary file IDs', async () => {
  for (const value of ['file-abc', 'https://evil.example/clip.mp4', `https://api.telegram.org/file/bot${TOKEN}/a.mp4`, 'https://factory.example.test/other/clip.mp4', signedUrl('&token=' + TOKEN), signedUrl().replace('https:', 'http:'), signedUrl().replace('api/public/1/', 'api/public/1/%2f'), signedUrl().replace(/sig=.*/, 'sig=bad')]) {
    assert.equal((await post('sendVideo', { chat_id: 900, video: value })).status, 400);
  }
  for (const method of ['sendVideo', 'sendDocument']) {
    assert.equal((await post(method, { chat_id: '900', [method === 'sendVideo' ? 'video' : 'document']: signedUrl(), caption: 'Preview' })).status, 200);
  }
  assert.equal((await post('sendVideo', { chat_id: 900, video: signedUrl(), thumbnail: 'https://evil.example/a.jpg' })).status, 400);
  process.env.CONTENT_FACTORY_URL = 'https://factory.example.test/prefix';
  assert.equal(bridge.signedFileUrl(signedUrl()), true);
  assert.equal(bridge.signedFileUrl(signedUrl().replace('/prefix/api/', '/api/')), false);
});
test('getFile requires an ingested per-chat file receipt and returns metadata, never a token or download URL', async () => {
  assert.equal((await post('getFile', { chat_id: '900', file_id: 'file-abc' })).status, 403);
  await mode();
  await bridge.handleUpdate(video());
  world.metadata = { file_id: 'file-abc', file_unique_id: 'unique-abc', file_size: 123, file_path: 'videos/safe.mp4', arbitrary: TOKEN };
  const response = await post('getFile', { chat_id: '900', file_id: 'file-abc' });
  assert.deepEqual(response.body, { ok: true, result: { file_id: 'file-abc', file_unique_id: 'unique-abc', file_size: 123, file_path: 'videos/safe.mp4' } });
  assert.equal(JSON.stringify(response).includes(TOKEN), false);
  assert.deepEqual(world.telegramCalls.find((c) => c.method === 'getFile').payload, { file_id: 'file-abc' });
  process.env.ADMIN_TELEGRAM_IDS += ',901';
  assert.equal((await post('getFile', { chat_id: 901, file_id: 'file-abc' })).status, 403);
  assert.equal((await post('getFile', { chat_id: 900, file_id: 'secret' })).status, 403);
});
test('download streams source bytes after authentication and receipt validation without exposing Telegram URLs', async () => {
  await mode(); await bridge.handleUpdate(video());
  world.metadata = { file_size: 123, file_path: 'videos/safe.mp4' };
  const response = await getFile({ chat_id: '900', file_id: 'file-abc' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.bytes, world.fileBytes);
  assert.equal(response.headers['content-type'], 'video/mp4');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(JSON.stringify(response.headers).includes(TOKEN), false);
  const download = world.requests.find((r) => r.url.includes('/file/bot'));
  assert.equal(download.options.redirect, 'error');
  assert.equal((await getFile({ chat_id: '900', file_id: 'file-abc' }, {})).status, 403);
  assert.equal((await getFile({ chat_id: '900', file_id: 'not-received' })).status, 403);
});
test('unsafe Telegram paths and token-bearing upstream failures are never returned', async () => {
  await mode(); await bridge.handleUpdate(video());
  for (const file_path of ['/etc/passwd', '../secret', 'videos/../secret', `https://host/${TOKEN}`, 'videos/a?token=secret', 'videos/%2e%2e/x']) {
    world.metadata = { file_path };
    const result = await post('getFile', { chat_id: 900, file_id: 'file-abc' });
    assert.ok([403, 502].includes(result.status));
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  }
  world.metadata = null; world.telegramError = true;
  const result = await post('getFile', { chat_id: 900, file_id: 'file-abc' });
  assert.equal(result.status, 502);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal((await post('getMe', {})).body.error, 'TELEGRAM_GATEWAY_FAILED');
});
test('cloud files above 20 MiB return LARGE_FILE with actionable manual upload guidance; documents do not bypass it', async () => {
  await mode();
  const update = video();
  update.message.video.file_size = 21 * 1024 * 1024;
  await bridge.handleUpdate(update);
  const result = await post('getFile', { chat_id: 900, file_id: 'file-abc' });
  assert.equal(result.status, 413);
  assert.equal(result.body.error, 'LARGE_FILE');
  assert.match(result.body.message, /20 MiB.*direct-upload/);
  assert.equal(world.telegramCalls.filter((c) => c.method === 'getFile').length, 0);
  assert.equal((await getFile({ chat_id: '900', file_id: 'file-abc' })).status, 413);
});
test('read-only diagnostics are sanitized and do not hardcode or export bot credentials', async () => {
  const identity = await post('getMe', {});
  assert.equal(identity.status, 200);
  assert.equal(identity.body.result.is_bot, true);
  assert.equal(world.telegramCalls.at(-1).method, 'getMe');
  assert.deepEqual((await post('getWebhookInfo', {})).body.result, { pending_update_count: 2, allowed_updates: ['message'] });
  assert.equal(JSON.stringify(identity).includes(TOKEN), false);
  assert.equal((await post('getMe', { token: TOKEN })).status, 400);
});
test('bridge fails closed when storage/configuration is missing', async () => {
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  assert.equal((await post('getMe', {})).status, 503);
  await assert.rejects(mode(), { code: 'BRIDGE_NOT_CONFIGURED' });
});
test('existing local Bot API supports absolute files only within canonical FILE_ROOT, without exporting absolute paths', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-bridge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'files');
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, TOKEN));
  const source = path.join(root, TOKEN, 'source.mp4');
  await fs.writeFile(source, 'local video');
  await mode(); await bridge.handleUpdate(video());
  process.env.CF_TELEGRAM_API_BASE = 'http://127.0.0.1:8081';
  process.env.CF_TELEGRAM_FILE_ROOT = root;
  world.metadata = { file_path: source, file_size: 11 };
  const metadata = await post('getFile', { chat_id: 900, file_id: 'file-abc' });
  assert.equal(metadata.status, 200);
  assert.match(metadata.body.result.file_path, /^local\/[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(metadata).includes(directory), false);
  assert.equal(JSON.stringify(metadata).includes(TOKEN), false);
  const download = await getFile({ chat_id: '900', file_id: 'file-abc' });
  assert.equal(download.status, 200);
  assert.equal(download.bytes.toString(), 'local video');
  assert.ok(world.requests.some((r) => r.url === `http://127.0.0.1:8081/bot${TOKEN}/getFile`));
  assert.equal(world.requests.some((r) => r.url.includes('/file/bot')), false);
  const outside = path.join(directory, 'outside.mp4');
  await fs.writeFile(outside, 'not authorized');
  await fs.symlink(outside, path.join(root, 'escape.mp4'));
  for (const file_path of [outside, path.join(root, 'escape.mp4'), path.join(root, '..', 'outside.mp4')]) {
    world.metadata = { file_path };
    assert.equal((await post('getFile', { chat_id: 900, file_id: 'file-abc' })).status, 403);
  }
});
test('local path support handles cloud-large files, enforces 6 GiB cap, and never silently reads absolute paths without local opt-in', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-bridge-cap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'large.mp4');
  await fs.writeFile(source, 'local video');
  await mode();
  const update = video(); update.message.video.file_size = 30 * 1024 * 1024;
  await bridge.handleUpdate(update);
  process.env.CF_TELEGRAM_API_BASE = 'http://127.0.0.1:8081';
  process.env.CF_TELEGRAM_FILE_ROOT = root;
  world.metadata = { file_path: source };
  assert.equal((await post('getFile', { chat_id: 900, file_id: 'file-abc' })).status, 200);
  await fs.truncate(source, 6 * 1024 * 1024 * 1024 + 1); // sparse file, not a huge allocation
  assert.equal((await post('getFile', { chat_id: 900, file_id: 'file-abc' })).body.error, 'LARGE_FILE');
  delete process.env.CF_TELEGRAM_FILE_ROOT;
  assert.equal((await post('getFile', { chat_id: 900, file_id: 'file-abc' })).status, 413);
});

test('cloud getFile too-big responses with unknown input size map to LARGE_FILE and redact Telegram descriptions', async () => {
  await mode();
  const update = video(); update.message.video.file_size = 0;
  await bridge.handleUpdate(update);
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => String(url).endsWith('/getFile')
    ? { ok: false, json: async () => ({ ok: false, description: `Bad Request: file is too big; secret ${TOKEN}` }) }
    : previousFetch(url, options);
  const response = await post('getFile', { chat_id: 900, file_id: 'file-abc' });
  assert.equal(response.status, 413);
  assert.equal(response.body.error, 'LARGE_FILE');
  assert.equal(JSON.stringify(response).includes(TOKEN), false);
});
test('existing webhook dispatch handles opt-in commands and media without capturing unrelated replies', async () => {
  assert.equal((await deliver({ message: message({ text: '/reels@existing_bot' }) })).status, 200);
  assert.equal((await deliver(video())).status, 200);
  assert.equal(world.factory.length, 1);
  const prompt = await post('sendMessage', { chat_id: '900', text: 'Reply?', reply_markup: { force_reply: true } });
  const replyTo = prompt.body.result.message_id;
  assert.equal((await deliver({ message: message({ text: 'feedback', reply_to_message: { message_id: replyTo } }) })).status, 200);
  assert.equal(world.factory.at(-1).body.kind, 'text');
  assert.equal((await deliver({ message: message({ text: 'unrelated', reply_to_message: { message_id: 555 } }) })).status, 200);
  assert.equal(world.factory.length, 2);
  assert.equal((await deliver({ message: message({ text: '/reels_off' }) })).status, 200);
  assert.equal((await deliver(video())).status, 200);
  assert.equal(world.factory.length, 2);
});

test('wrong existing bot blocks all bridge effects and downloads while getMe exposes its real identity', async (t) => {
  await mode();
  await bridge.handleUpdate(video());
  await bridge.handleUpdate(callback());
  const prompt = await post('sendMessage', { chat_id: 900, text: 'Reply?', reply_markup: { force_reply: true } });
  const replyTo = prompt.body.result.message_id;
  const beforeKV = new Map(world.kv);
  const beforeFactory = world.factory.length;
  const beforeCalls = world.telegramCalls.length;
  const beforeRequests = world.requests.length;
  // A different existing API base must be verified separately, even with a still-cached cloud identity.
  process.env.CF_TELEGRAM_API_BASE = 'http://127.0.0.1:8082';
  process.env.CF_TELEGRAM_FILE_ROOT = '/synthetic/no-file-access';
  world.metadata = { file_path: '/synthetic/no-file-access/source.mp4' };
  world.identity = { id: 999, is_bot: true, username: 'Some_other_bot', first_name: 'Actual other bot' };
  const realpath = t.mock.method(fs, 'realpath', async () => assert.fail('wrong identity must not resolve local files'));
  const open = t.mock.method(fs, 'open', async () => assert.fail('wrong identity must not open local files'));
  const mismatch = { code: 'BOT_IDENTITY_MISMATCH', status: 503 };
  for (const update of [
    { message: message({ text: '/reels' }) },
    { message: message({ text: '/reels_off' }) },
    video(), callback(), callback({ from: { id: 901 } }), callback({ data: 'cf:malformed' }),
    { message: message({ text: 'workflow reply', reply_to_message: { message_id: replyTo } }) }
  ]) await assert.rejects(bridge.handleUpdate(update), mismatch);
  for (const [method, payload] of [
    ['sendMessage', { chat_id: 900, text: 'Must not send', reply_markup: { force_reply: true } }],
    ['sendVideo', { chat_id: 900, video: signedUrl() }],
    ['sendDocument', { chat_id: 900, document: signedUrl() }],
    ['answerCallbackQuery', { callback_query_id: 'cb-123', text: 'Must not answer' }],
    ['getFile', { chat_id: 900, file_id: 'file-abc' }], ['getWebhookInfo', {}]
  ]) assert.deepEqual(await post(method, payload), { status: 503, body: { ok: false, error: 'BOT_IDENTITY_MISMATCH' } });
  const query = { chat_id: '900', file_id: 'file-abc' };
  const localDownload = await getFile(query);
  assert.equal(localDownload.status, 503);
  assert.deepEqual(JSON.parse(localDownload.bytes), { ok: false, error: 'BOT_IDENTITY_MISMATCH' });
  delete process.env.CF_TELEGRAM_FILE_ROOT; // relative/cloud HTTP downloads are blocked too
  world.metadata = { file_path: 'videos/safe.mp4' };
  assert.equal((await getFile(query)).status, 503);
  assert.equal(world.factory.length, beforeFactory);
  assert.deepEqual(world.kv, beforeKV);
  assert.deepEqual(world.telegramCalls.slice(beforeCalls), [{ method: 'getMe', payload: {} }]);
  assert.ok(world.requests.slice(beforeRequests).every((r) => r.url.endsWith('/getMe') || r.url.startsWith('https://redis.example.test')));
  assert.equal(realpath.mock.callCount(), 0);
  assert.equal(open.mock.callCount(), 0);
  // Diagnostic requests remain live, sanitized and read-only even while operational verification is negative.
  const diagnostic = await post('getMe', {});
  assert.deepEqual(diagnostic, { status: 200, body: { ok: true, result: world.identity } });
  assert.deepEqual(world.kv, beforeKV);
  assert.equal(world.telegramCalls.at(-1).method, 'getMe');
  assert.equal(JSON.stringify(diagnostic).includes(TOKEN), false);
});

test('verification requires a strict bot flag and the exact username, not a missing or lookalike identity', async () => {
  const invalid = [
    { username: 'K_zhenshcine_bot', is_bot: false },
    { username: 'K_zhenshcine_bot', is_bot: 'true' },
    { username: 'K_zhenshcine_bot' },
    { is_bot: true }, { is_bot: true, username: 123 },
    { is_bot: true, username: '@K_zhenshcine_bot' },
    { is_bot: true, username: 'K_zhenshcine_bot_extra' },
    { is_bot: true, username: ' K_zhenshcine_bot' }, null, true
  ];
  for (const [index, identity] of invalid.entries()) {
    process.env.CF_TELEGRAM_API_BASE = `http://127.0.0.1:${8100 + index}`;
    world.identity = identity;
    await assert.rejects(mode(), { code: 'BOT_IDENTITY_MISMATCH' });
  }
  assert.equal(world.kv.size, 0);
  assert.equal(world.factory.length, 0);
  assert.equal(world.telegramCalls.length, invalid.length);
  assert.ok(world.telegramCalls.every((entry) => entry.method === 'getMe'));
});

test('identity verification accepts case-insensitive matching and diagnostics preserve the actual casing', async () => {
  world.identity.username = 'K_ZHENSHCINE_BOT';
  assert.equal(await mode(), true);
  assert.equal((await post('getMe', {})).body.result.username, 'K_ZHENSHCINE_BOT');
  assert.deepEqual(world.telegramCalls.slice(0, 2).map((entry) => entry.method), ['getMe', 'sendMessage']);
  assert.equal(await bridge.handleUpdate(video()), true);
  assert.equal(world.factory.length, 1);
});

test('identity cache lasts exactly five minutes and is scoped to the current token and normalized API base', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const reads = () => world.telegramCalls.filter((entry) => entry.method === 'getMe').length;
  await mode();
  await bridge.handleUpdate(callback());
  assert.equal(reads(), 1);
  now += 5 * 60 * 1000 - 1;
  assert.equal((await post('sendMessage', { chat_id: 900, text: 'Cached' })).status, 200);
  assert.equal(reads(), 1);
  now += 1;
  assert.equal((await post('sendMessage', { chat_id: 900, text: 'Expired' })).status, 200);
  assert.equal(reads(), 2);
  // Synthetic credentials only: a credential change must never reuse the previous identity decision.
  process.env.TELEGRAM_BOT_TOKEN = `${TOKEN}-cache-key-test`;
  assert.equal((await post('sendMessage', { chat_id: 900, text: 'Different synthetic token' })).status, 200);
  assert.equal(reads(), 3);
  process.env.CF_TELEGRAM_API_BASE = 'http://127.0.0.1:8081';
  world.metadata = { message_id: 123 };
  assert.equal((await post('sendMessage', { chat_id: 900, text: 'Different API' })).status, 200);
  assert.equal(reads(), 4);
  process.env.CF_TELEGRAM_API_BASE += '/';
  assert.equal((await post('sendMessage', { chat_id: 900, text: 'Same normalized API' })).status, 200);
  assert.equal(reads(), 4);
  for (let i = 0; i < 2; i++) assert.equal((await post('getMe', {})).status, 200);
  assert.equal(reads(), 6); // diagnostics always read the actual identity, never the cache
  assert.equal((await post('sendMessage', { chat_id: 900, text: 'Still cached' })).status, 200);
  assert.equal(reads(), 6);
});

test('failed identity reads fail closed and expired positive results cannot authorize state changes', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  world.identityError = true;
  await assert.rejects(mode(), { code: 'TELEGRAM_GATEWAY_FAILED' });
  assert.equal(world.kv.size, 0);
  assert.equal(world.factory.length, 0);
  assert.deepEqual(world.telegramCalls.map((entry) => entry.method), ['getMe']);
  world.identityError = false;
  await mode();
  const before = new Map(world.kv);
  now += 5 * 60 * 1000;
  world.identityError = true;
  await assert.rejects(bridge.handleUpdate({ message: message({ text: '/reels_off' }) }), { code: 'TELEGRAM_GATEWAY_FAILED' });
  await assert.rejects(bridge.handleUpdate(video()), { code: 'TELEGRAM_GATEWAY_FAILED' });
  const response = await post('sendMessage', { chat_id: 900, text: 'Blocked' });
  assert.deepEqual(response, { status: 502, body: { ok: false, error: 'TELEGRAM_GATEWAY_FAILED' } });
  assert.deepEqual(world.kv, before);
  assert.equal(world.sent('sendMessage').length, 1);
  assert.equal(world.factory.length, 0);
  assert.equal(JSON.stringify(response).includes(TOKEN), false);
  assert.equal(JSON.stringify(response).includes(SECRET), false);
});

test('a missing or shorter-than-32-character bridge secret cannot configure or authenticate the bridge', async () => {
  for (const secret of [undefined, '', 'short-secret', 's'.repeat(31)]) {
    if (secret === undefined) delete process.env.CF_BRIDGE_SECRET;
    else process.env.CF_BRIDGE_SECRET = secret;
    const headers = { 'x-cf-bridge-secret': secret || SECRET };
    assert.equal(bridge.authenticated({ headers }), false);
    assert.equal((await post('getMe', {}, headers)).status, 403);
    assert.equal((await getFile({ chat_id: 900, file_id: 'file-abc' }, headers)).status, 403);
    await assert.rejects(bridge.gateway('getMe', {}), { code: 'BRIDGE_NOT_CONFIGURED' });
    await assert.rejects(mode(), { code: 'BRIDGE_NOT_CONFIGURED' });
  }
  assert.equal(world.requests.length, 0);
  assert.equal(world.kv.size, 0);
  process.env.CF_BRIDGE_SECRET = 's'.repeat(32);
  assert.equal(bridge.authenticated({ headers: { 'x-cf-bridge-secret': 's'.repeat(32) } }), true);
  assert.equal((await post('getMe', {}, { 'x-cf-bridge-secret': 's'.repeat(32) })).status, 200);
});

test('MP4 MOV M4V WEBM are the only supported media extension and MIME boundaries', () => {
  for (const [ext, mime] of Object.entries({ mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm' })) {
    const document = { file_id: 'doc1', file_unique_id: 'unique1', file_name: `clip.${ext.toUpperCase()}`, mime_type: mime };
    for (const mime_type of [mime, '', 'application/octet-stream']) {
      assert.equal(bridge.mediaInput({ update_id: 43, message: message({ document: { ...document, mime_type } }) }).mime, mime);
    }
    const native = video();
    native.message.video = { ...native.message.video, mime_type: mime, file_name: '' };
    assert.equal(bridge.mediaInput(native).fileName, `unique-abc.${ext}`);
  }
  for (const change of [
    { file_name: 'clip.mkv' }, { file_name: 'clip.avi' }, { mime_type: 'video/x-matroska' },
    { mime_type: 'video/x-msvideo' }, { mime_type: 'image/gif' }, { mime_type: 'video/unknown' }
  ]) {
    const native = video();
    Object.assign(native.message.video, change);
    assert.equal(bridge.mediaInput(native), null);
  }
});
