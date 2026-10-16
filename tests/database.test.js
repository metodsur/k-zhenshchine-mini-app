const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv();
const osRoute = require('../api/os/[section]');
const adminRoute = require('../api/admin/[section]');
const webhook = require('../api/telegram/webhook');

const OWNER = { id: 900, first_name: 'Варвара' };
const MANAGER = { id: 5202, first_name: 'Ольга' };
const deliver = (update) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });
const say = (user, text) => deliver({ message: { chat: { id: user.id, type: 'private' }, from: user, text } });
async function os(section, body = {}, cookie = '') {
  let out; const set = {};
  const res = { statusCode: 0, setHeader(k, v) { set[k.toLowerCase()] = v; }, end(v) { out = v ? JSON.parse(v) : undefined; } };
  await osRoute({ method: 'POST', query: { section }, headers: { 'x-kz-os': '1', cookie }, body }, res);
  return { status: res.statusCode, body: out, cookie: set['set-cookie'] || '' };
}
async function login(world, user) {
  await say(user, '/dashboard');
  const msg = world.sent('sendMessage').filter((m) => String(m.chat_id) === String(user.id)).pop();
  return (await os('login', { token: msg.reply_markup.inline_keyboard[0][0].url.split('#login=')[1] })).cookie.split(';')[0];
}
async function getFile(q, cookie) {
  const out = { headers: {} };
  await osRoute({ method: 'GET', query: { section: 'file', ...q }, headers: { cookie } }, { statusCode: 0, setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, end(v) { out.body = v; } });
  return out;
}

test('database: files, links and texts with descriptions; big files through the bot', async () => {
  const world = createWorld();
  await call(adminRoute, { method: 'POST', query: { section: 'team' }, body: { initData: initData(OWNER), action: 'save', members: [{ id: '5202', name: 'Ольга', role: 'manager' }] } });
  const owner = await login(world, OWNER);
  const olga = await login(world, MANAGER);

  let r = await os('database', {}, olga);
  assert.deepEqual(r.body.items, []);

  // A document straight from the dashboard: stored in Telegram, described, in a folder.
  r = await os('database', { action: 'upload', item: { folder: 'Договоры', description: 'Подписан 01.10' }, file: { name: 'договор.pdf', mime: 'application/pdf', data: Buffer.from('pdf').toString('base64') } }, olga);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const doc = r.body.item;
  assert.deepEqual([doc.title, doc.folder, doc.description, doc.kind, doc.file_id, doc.by], ['договор.pdf', 'Договоры', 'Подписан 01.10', 'file', 'doc-1', 'Ольга']);
  assert.equal(world.sent('sendDocument').pop().chat_id, '5202');
  let f = await getFile({ db: doc.id }, owner);
  assert.equal(f.headers['content-type'], 'application/octet-stream');
  assert.equal(String(f.body), 'file:doc-1');
  assert.equal((await getFile({ db: doc.id }, '')).headers['content-type'], undefined, 'needs a session');

  // Too big for the dashboard → hint about the bot.
  const big = Buffer.alloc(3 * 1024 * 1024 + 10).toString('base64');
  assert.match((await os('database', { action: 'upload', item: { title: 'Видео' }, file: { name: 'v.mp4', mime: 'video/mp4', data: big } }, olga)).body.errors[0], /бот/);

  // A link and a text record.
  assert.equal((await os('database', { action: 'save', item: { title: 'Плохая', url: 'javascript:alert(1)' } }, owner)).status, 400);
  r = await os('database', { action: 'save', item: { title: 'Исходники', url: 'disk.yandex.ru/d/x', description: 'Фото с ретрита' } }, owner);
  assert.equal(r.body.item.kind, 'link');
  assert.equal(r.body.item.url, 'https://disk.yandex.ru/d/x');

  // Big video: record first, then the bot asks for the file; a reply fills it in.
  r = await os('database', { action: 'save', item: { title: 'Ретрит, видео', folder: 'Видео', description: 'Полная запись' } }, owner);
  const vid = r.body.item;
  assert.equal(vid.kind, 'note');
  r = await os('database', { action: 'via_bot', id: vid.id }, owner);
  assert.equal(r.status, 200);
  const ask = world.sent('sendMessage').filter((m) => String(m.chat_id) === '900').pop();
  assert.match(ask.text, /Ретрит, видео/);
  // The next file sent to the bot lands in the record.
  await deliver({ message: { chat: { id: 900, type: 'private' }, from: OWNER, video: { file_id: 'vid-9', file_size: 80e6, mime_type: 'video/mp4' } } });
  r = await os('database', {}, owner);
  const filled = r.body.items.find((x) => x.id === vid.id);
  assert.deepEqual([filled.kind, filled.file_id], ['video', 'vid-9']);
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === 900).pop().text, /сохранён в базе данных/);
  // A reply to the bot's message works too (and replaces the file); a stray file afterwards is ignored.
  world.kv.set('dbmsg:900:4242', vid.id);
  await deliver({ message: { chat: { id: 900, type: 'private' }, from: OWNER, document: { file_id: 'doc-z', file_name: 'запись.mov', mime_type: 'video/quicktime' }, reply_to_message: { message_id: 4242 } } });
  await deliver({ message: { chat: { id: 900, type: 'private' }, from: OWNER, photo: [{ file_id: 'stray' }] } });
  r = await os('database', {}, owner);
  assert.deepEqual([r.body.items.find((x) => x.id === vid.id).file_id, r.body.items.find((x) => x.id === vid.id).kind], ['doc-z', 'video']);
  world.kv.set('dbmsg:900:4242', vid.id);
  await deliver({ message: { chat: { id: 900, type: 'private' }, from: OWNER, video: { file_id: 'vid-9', file_size: 80e6, mime_type: 'video/mp4' }, reply_to_message: { message_id: 4242 } } });
  // Over 20 MB: the bot sends it to the viewer.
  world.bigFiles = new Set(['vid-9']);
  f = await getFile({ db: vid.id }, olga);
  assert.match(String(f.body), /прислали его вам в Telegram/);
  assert.match(world.sent('sendVideo').pop().caption, /База данных/);

  // Audio: an mp3 from the dashboard plays inline; an audio track sent to the bot lands too.
  r = await os('database', { action: 'upload', item: { title: 'Аудиопрактика 1', folder: 'Аудиопрактики' }, file: { name: 'practice-1.mp3', mime: 'audio/mpeg', data: Buffer.from('mp3').toString('base64') } }, owner);
  assert.equal(r.body.item.kind, 'audio');
  f = await getFile({ db: r.body.item.id }, owner);
  assert.equal(f.headers['content-type'], 'audio/mpeg');
  assert.match(f.headers['content-disposition'], /^inline/);
  r = await os('database', { action: 'save', item: { title: 'Аудиопрактика 2' } }, owner);
  const a2 = r.body.item;
  await os('database', { action: 'via_bot', id: a2.id }, owner);
  await deliver({ message: { chat: { id: 900, type: 'private' }, from: OWNER, audio: { file_id: 'aud-2', file_size: 30e6, mime_type: 'audio/mpeg', file_name: 'Практика 2.mp3' } } });
  r = await os('database', {}, owner);
  const got = r.body.items.find((x) => x.id === a2.id);
  assert.deepEqual([got.kind, got.file_id, got.send, got.name], ['audio', 'aud-2', 'audio', 'Практика 2.mp3']);
  world.bigFiles.add('aud-2');
  f = await getFile({ db: a2.id }, owner);
  assert.equal(world.sent('sendAudio').pop().audio, 'aud-2', 'over 20 MB the bot sends the audio');
  for (const x of r.body.items.filter((x) => x.kind === 'audio')) await os('database', { action: 'remove', id: x.id }, owner);

  // Removing: the author or the owner, not others.
  const linkId = r.body.items.find((x) => x.kind === 'link').id;
  assert.equal((await os('database', { action: 'remove', id: linkId }, olga)).status, 403);
  assert.equal(r.body.items.find((x) => x.id === doc.id).can_remove, true);
  assert.equal((await os('database', { action: 'remove', id: doc.id }, olga)).status, 200);
  r = await os('database', { action: 'remove', id: linkId }, owner);
  assert.deepEqual(r.body.items.map((x) => x.title), ['Ретрит, видео']);
});
