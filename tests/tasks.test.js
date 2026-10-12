const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv();
const osRoute = require('../api/os/[section]');
const adminRoute = require('../api/admin/[section]');
const webhook = require('../api/telegram/webhook');
const tasks = require('../lib/tasks');

const OWNER = { id: 900, first_name: 'Варвара' };
const NASTYA = { id: 5101, first_name: 'Анастасия' };
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

test('tasks: plan import, statuses, comments, bot buttons, notifications, Friday summary', async () => {
  const world = createWorld();
  await call(adminRoute, { method: 'POST', query: { section: 'team' }, body: { initData: initData(OWNER), action: 'save', members: [{ id: '5101', name: 'Анастасия', role: 'director' }] } });
  const nastya = await login(world, NASTYA);
  const owner = await login(world, OWNER);

  // First open of «Задачи» loads the plan once: all on Анастасия, no deadlines, calendar entry.
  let r = await os('tasks', {}, nastya);
  assert.equal(r.body.tasks.length, 18);
  assert.ok(r.body.tasks.every((t) => t.owner === 'Анастасия' && !t.due && t.status === 'todo'));
  assert.equal(r.body.tasks.find((t) => t.area === 'Дни дружбы').checklist.length, 3);
  assert.equal((await os('tasks', {}, owner)).body.tasks.length, 18, 'imported once');
  const cal = await os('calendar', { action: 'list', from: '2026-10-09', to: '2026-10-09' }, owner);
  assert.match(cal.body.items[0].title, /Сканди/);
  assert.equal(world.sent('sendMessage').filter((m) => m.chat_id === '5101' && /назначена/.test(m.text)).length, 0, 'import is silent');

  // Owner creates and assigns → Анастасия notified with buttons.
  r = await os('tasks', { action: 'save', task: { title: 'Снять «Зеркало»', owner: 'Анастасия', due: '2026-10-10' } }, owner);
  const t = r.body.task;
  const note = world.sent('sendMessage').filter((m) => m.chat_id === '5101').pop();
  assert.match(note.text, /Вам назначена задача: «Снять «Зеркало»»/);
  assert.equal(note.reply_markup.inline_keyboard[0][1].callback_data, `t:d:${t.id}`);

  // /tasks in the bot.
  await say(NASTYA, '/tasks');
  const listed = world.sent('sendMessage').filter((m) => m.chat_id === 5101);
  const picker = listed.find((m) => /Нажмите на задачу/.test(m.text));
  assert.equal(picker.reply_markup.inline_keyboard.length, 20, '19 tasks + «Новая задача»');
  assert.match(picker.reply_markup.inline_keyboard[0][0].callback_data, /^t:o:[a-f0-9]{10}$/);
  // Owner: team overview by person.
  await say(OWNER, '/tasks');
  const ov = world.sent('sendMessage').filter((m) => m.chat_id === 900).map((m) => m.text).join('\n');
  assert.match(ov, /Задачи команды/);
  assert.match(ov, /👤 Анастасия — 19 задач/);
  assert.match(ov, /Снять «Зеркало» — 10 октября/);

  // Button «Выполнено» → status, owner notified, comment prompt; next text = comment.
  await deliver({ callback_query: { id: 'cb1', from: NASTYA, data: `t:d:${t.id}`, message: { chat: { id: 5101 }, message_id: 7 } } });
  assert.equal((await tasks.load()).find((x) => x.id === t.id).status, 'done');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '900').pop().text, /Задача выполнена: «Снять «Зеркало»»/);
  assert.equal(world.sent('editMessageText').length, 1);
  await say(NASTYA, 'Снято, отдано в монтаж');
  const done = (await tasks.load()).find((x) => x.id === t.id);
  assert.equal(done.comments[0].text, 'Снято, отдано в монтаж');
  assert.equal(done.comments[0].by, 'Анастасия');

  // Comment from the dashboard → assignee notified.
  const other = (await tasks.load())[0];
  await os('tasks', { action: 'comment', id: other.id, text: 'Варвара: посмотри референсы' }, owner);
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '5101').pop().text, /комментарий к задаче/);
  // Status via dashboard.
  r = await os('tasks', { action: 'status', id: other.id, status: 'doing' }, nastya);
  assert.equal(r.body.task.status, 'doing');

  // Friday summary to owner + director.
  const friday = Date.parse('2026-10-09T15:00:00Z');
  const s = await tasks.runWeeklySummary(friday);
  assert.equal(s.sent, 2);
  const text = world.sent('sendMessage').filter((m) => String(m.chat_id) === '900').pop().text;
  assert.match(text, /Сводка задач за неделю/);
  assert.match(text, /В работе \(1\)/);
  assert.equal((await tasks.runWeeklySummary(friday)).skipped, 'sent');
  assert.equal((await tasks.runWeeklySummary(Date.parse('2026-10-08T15:00:00Z'))).skipped, 'not friday');
});

test('HR: only the owner sees and edits it', async () => {
  const world = createWorld();
  await call(adminRoute, { method: 'POST', query: { section: 'team' }, body: { initData: initData(OWNER), action: 'save', members: [{ id: '5101', name: 'Анастасия', role: 'director' }] } });
  const owner = await login(world, OWNER);
  const nastya = await login(world, NASTYA);
  const r = await os('collection', { name: 'hr', action: 'save', item: { title: 'Петрова Анастасия', position: 'Операционный директор', status: 'active', start_date: '2026-10-07', form: 'self', pay_amount: 80000, duties: 'Вся операционка' } }, owner);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await os('collection', { name: 'hr', action: 'list' }, owner)).body.items.length, 1);
  assert.equal((await os('collection', { name: 'hr', action: 'list' }, nastya)).status, 403);
  assert.equal((await os('collection', { name: 'hr', action: 'save', item: { title: 'x' } }, nastya)).status, 403);
  assert.ok(!(await os('me', {}, nastya)).body.perms.includes('hr.view'));
});

test('bot: owner-only /setup refreshes webhook updates, commands and menu', async () => {
  const world = createWorld();
  await say(NASTYA, '/setup');
  assert.equal(world.sent('setWebhook').length, 0, 'not for others');
  await say(OWNER, '/setup');
  const hook = world.sent('setWebhook').pop();
  assert.ok(hook.allowed_updates.includes('callback_query'));
  assert.ok(world.sent('setMyCommands').pop().commands.some((c) => c.command === 'tasks'));
  assert.match(world.sent('sendMessage').filter((m) => String(m.chat_id) === '900').pop().text, /Готово/);
});

test('tasks in the bot: create with /task, assign, deadline, comment by reply, all visible in the dashboard', async () => {
  const world = createWorld();
  await call(adminRoute, { method: 'POST', query: { section: 'team' }, body: { initData: initData(OWNER), action: 'save', members: [{ id: '5101', name: 'Анастасия', role: 'director' }] } });
  const nastya = await login(world, NASTYA);
  await os('tasks', {}, nastya); // plan import happens on first open
  // Owner: /task with text → created, asked whom to assign.
  await say(OWNER, '/task Снять рилс про клуб\nВертикально, 30 сек');
  let msg = world.sent('sendMessage').filter((m) => String(m.chat_id) === '900').pop();
  assert.match(msg.text, /Задача создана/);
  const btn = msg.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Анастасия');
  assert.ok(btn, 'team members as buttons');
  const id = btn.callback_data.split(':')[2];
  await deliver({ callback_query: { id: 'q1', from: OWNER, data: btn.callback_data, message: { chat: { id: 900 }, message_id: 50 } } });
  // Анастасия notified; the owner's message now asks for the deadline.
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '5101').pop().text, /Вам назначена задача: «Снять рилс про клуб»/);
  const asked = world.sent('editMessageText').pop();
  assert.match(asked.text, /Какой срок/);
  await deliver({ callback_query: { id: 'q2', from: OWNER, data: `t:u:${id}:1`, message: { chat: { id: 900 }, message_id: 50 } } });
  let t = (await tasks.load()).find((x) => x.id === id);
  assert.equal(t.owner, 'Анастасия');
  assert.ok(t.due);
  assert.equal(t.description, 'Вертикально, 30 сек');
  // The dashboard sees it.
  assert.ok((await os('tasks', {}, nastya)).body.tasks.some((x) => x.id === id));
  // Comment = a plain reply to the task message (message 50 is mapped to the task).
  await deliver({ message: { chat: { id: 900, type: 'private' }, from: OWNER, text: 'Добавь субтитры', reply_to_message: { message_id: 50 } } });
  t = (await tasks.load()).find((x) => x.id === id);
  assert.equal(t.comments[0].text, 'Добавь субтитры');
  assert.equal(t.comments[0].by, 'Варвара');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '5101').pop().text, /Варвара: Добавь субтитры/);
  // Button «Новая задача» → next message becomes a task.
  await deliver({ callback_query: { id: 'q3', from: NASTYA, data: 't:n', message: { chat: { id: 5101 }, message_id: 7 } } });
  await say(NASTYA, 'Забронировать зал на ноябрь');
  assert.ok((await tasks.load()).some((x) => x.title === 'Забронировать зал на ноябрь' && x.created_by === 'Анастасия'));
  // Open a task from the /tasks picker.
  await deliver({ callback_query: { id: 'q4', from: OWNER, data: `t:o:${id}`, message: { chat: { id: 900 }, message_id: 51 } } });
  assert.match(world.sent('sendMessage').filter((m) => String(m.chat_id) === '900').pop().text, /💬 <b>Варвара: Добавь субтитры<\/b>/);
});

test('vault: passwords encrypted at rest, revealed on request with a log, visibility by access list', async () => {
  const world = createWorld();
  await call(adminRoute, { method: 'POST', query: { section: 'team' }, body: { initData: initData(OWNER), action: 'save', members: [{ id: '5101', name: 'Анастасия', role: 'director' }, { id: '5102', name: 'Лена', role: 'content' }] } });
  const owner = await login(world, OWNER);
  const lena = await login(world, { id: 5102, first_name: 'Лена' });
  let r = await os('vault', { action: 'save', item: { title: 'Tribute', url: 'tribute.tg', login: 'kz@mail.ru', password: 'S3cret!pass', access: 'Варвара, Анастасия' } }, owner);
  assert.equal(r.status, 200);
  assert.equal(r.body.items[0].url, 'https://tribute.tg');
  assert.equal(r.body.items[0].password, undefined, 'never in the list');
  assert.ok(![...world.kv.values()].some((v) => String(v).includes('S3cret!pass')), 'not stored in plain text');
  await os('vault', { action: 'save', item: { title: 'Canva', login: 'design@kz', password: 'canva1', access: ['Лена'] } }, owner);
  // Лена sees only Canva; she cannot open Tribute or delete.
  const lenaList = (await os('vault', {}, lena)).body.items;
  assert.deepEqual(lenaList.map((x) => x.title), ['Canva']);
  const tributeId = r.body.items.find((x) => x.title === 'Tribute').id;
  assert.equal((await os('vault', { action: 'reveal', id: tributeId }, lena)).status, 404);
  assert.equal((await os('vault', { action: 'reveal', id: lenaList[0].id }, lena)).body.password, 'canva1');
  assert.equal((await os('vault', { action: 'remove', id: lenaList[0].id }, lena)).status, 403);
  // Owner reveals; the view is logged; editing with an empty password keeps it.
  assert.equal((await os('vault', { action: 'reveal', id: tributeId }, owner)).body.password, 'S3cret!pass');
  r = await os('vault', { action: 'save', item: { id: tributeId, title: 'Tribute', login: 'new@mail.ru', password: '' } }, owner);
  assert.equal(r.body.items.find((x) => x.id === tributeId).last_view.by, 'Варвара');
  assert.equal((await os('vault', { action: 'reveal', id: tributeId }, owner)).body.password, 'S3cret!pass');
  // Лена adds her own service → she keeps access to it.
  r = await os('vault', { action: 'save', item: { title: 'CapCut', password: 'x' } }, lena);
  assert.deepEqual(r.body.items.find((x) => x.title === 'CapCut').access, ['Лена']);
});

test('tasks: review (approve, revisions, defect) from the dashboard and the bot', async () => {
  const world = createWorld();
  await call(adminRoute, { method: 'POST', query: { section: 'team' }, body: { initData: initData(OWNER), action: 'save', members: [{ id: '5101', name: 'Анастасия', role: 'director' }, { id: '5102', name: 'Лена', role: 'content' }] } });
  const owner = await login(world, OWNER);
  const lena = await login(world, { id: 5102, first_name: 'Лена' });
  let r = await os('tasks', { action: 'save', task: { title: 'Смонтировать рилс', owner: 'Лена' } }, owner);
  const id = r.body.task.id;
  // Лена finishes → the owner gets the card with review buttons.
  await os('tasks', { action: 'status', id, status: 'done' }, lena);
  const card = world.sent('sendMessage').filter((m) => m.chat_id === '900').pop();
  assert.match(card.text, /Ждёт утверждения/);
  assert.deepEqual(card.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`t:y:${id}`, `t:r:${id}`, `t:x:${id}`]);
  // Лена (content role) cannot review.
  assert.equal((await os('tasks', { action: 'review', id, verdict: 'approved' }, lena)).status, 403);
  // Revisions need a note; the task goes back to work and Лена gets the note.
  assert.equal((await os('tasks', { action: 'review', id, verdict: 'revision', note: ' ' }, owner)).status, 400);
  r = await os('tasks', { action: 'review', id, verdict: 'revision', note: 'Убрать музыку в начале' }, owner);
  assert.equal(r.body.task.status, 'doing');
  assert.equal(r.body.task.review.verdict, 'revision');
  assert.match(r.body.task.comments.pop().text, /Нужны правки: Убрать музыку/);
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '5102').pop().text, /Нужны правки по задаче «Смонтировать рилс»[\s\S]*Убрать музыку в начале/);
  // Done again → waits for review; defect from the bot: button, then the reason as a message.
  r = await os('tasks', { action: 'status', id, status: 'done' }, lena);
  assert.equal(r.body.task.review, null);
  await deliver({ callback_query: { id: 'r1', from: OWNER, data: `t:x:${id}`, message: { chat: { id: 900 }, message_id: 60 } } });
  await say(OWNER, 'Звук рассинхронизирован');
  let t = (await tasks.load()).find((x) => x.id === id);
  assert.equal(t.status, 'doing');
  assert.equal(t.review.verdict, 'defect');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '5102').pop().text, /Брак по задаче[\s\S]*Звук рассинхронизирован/);
  // Approve from the bot.
  await os('tasks', { action: 'status', id, status: 'done' }, lena);
  await deliver({ callback_query: { id: 'r2', from: OWNER, data: `t:y:${id}`, message: { chat: { id: 900 }, message_id: 61 } } });
  t = (await tasks.load()).find((x) => x.id === id);
  assert.equal(t.status, 'done');
  assert.equal(t.review.verdict, 'approved');
  assert.deepEqual(t.reviews.map((x) => x.verdict), ['revision', 'defect', 'approved']);
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '5102').pop().text, /Задача утверждена/);
  assert.ok(!world.sent('editMessageText').pop().reply_markup.inline_keyboard.flat().some((b) => /^t:y:/.test(b.callback_data)), 'no review buttons once approved');
  // Лена pressing a review button in the bot is refused.
  await deliver({ callback_query: { id: 'r3', from: { id: 5102, first_name: 'Лена' }, data: `t:x:${id}`, message: { chat: { id: 5102 }, message_id: 62 } } });
  assert.match(world.sent('answerCallbackQuery').pop().text, /владелица или директор/);
});

test('tasks: attachments — photos, videos, files, texts and links from the dashboard and the bot', async () => {
  const world = createWorld();
  await call(adminRoute, { method: 'POST', query: { section: 'team' }, body: { initData: initData(OWNER), action: 'save', members: [{ id: '5101', name: 'Анастасия', role: 'director' }] } });
  const owner = await login(world, OWNER);
  const nastya = await login(world, NASTYA);
  let r = await os('tasks', { action: 'save', task: { title: 'Съёмка для клуба', owner: 'Анастасия' } }, owner);
  const id = r.body.task.id;
  // Link (https added) and text.
  r = await os('tasks', { action: 'attach', id, attachment: { kind: 'link', url: 'disk.yandex.ru/d/abc', title: 'Исходники' } }, owner);
  assert.equal(r.body.task.attachments[0].url, 'https://disk.yandex.ru/d/abc');
  assert.equal((await os('tasks', { action: 'attach', id, attachment: { kind: 'link', url: 'javascript:alert(1)' } }, owner)).status, 400);
  r = await os('tasks', { action: 'attach', id, attachment: { kind: 'text', title: 'Сценарий', text: 'Кадр 1: рассвет' } }, owner);
  assert.equal(r.body.task.attachments[1].text, 'Кадр 1: рассвет');
  // Photo upload: stored in Telegram through the uploader's chat; served back through the proxy.
  r = await os('tasks', { action: 'upload', id, file: { name: 'кадр.jpg', mime: 'image/jpeg', data: 'data:image/jpeg;base64,' + Buffer.from('jpeg-bytes').toString('base64') } }, owner);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const photo = r.body.task.attachments[2];
  assert.equal(photo.kind, 'photo');
  assert.equal(photo.file_id, 'doc-1');
  assert.equal(world.sent('sendDocument').pop().chat_id, '900');
  assert.ok(!JSON.stringify(r.body).includes('test-only-credential'));
  // Too big → a hint to send it to the bot.
  const big = Buffer.alloc(3 * 1024 * 1024 + 10).toString('base64');
  assert.match((await os('tasks', { action: 'upload', id, file: { name: 'v.mp4', mime: 'video/mp4', data: big } }, owner)).body.errors[0], /в бот/);
  // The file proxy needs a session; inline for photos, download for other files.
  const get = async (q, cookie) => {
    const out = { headers: {} };
    await osRoute({ method: 'GET', query: { section: 'file', ...q }, headers: { cookie } }, { statusCode: 0, setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, end(v) { out.body = v; } });
    return Object.assign(out, { status: out.status });
  };
  let f = await get({ task: id, a: photo.id }, '');
  assert.equal(f.headers['content-type'], undefined);
  f = await get({ task: id, a: photo.id }, nastya);
  assert.equal(f.headers['content-type'], 'image/jpeg');
  assert.match(f.headers['content-disposition'], /^inline/);
  assert.equal(String(f.body), 'file:doc-1');
  // Video and a document sent to the bot as replies to the task message.
  const msg = world.sent('sendMessage').filter((m) => m.chat_id === '5101').pop();
  assert.match(msg.text, /вложение/);
  assert.equal(world.kv.get('tmsg:900:7001'), id, 'the uploaded file message is mapped to the task');
  world.kv.set('tmsg:5101:555', id); // a task card Анастасия got in the bot
  const replyTo = { message_id: 555 };
  await deliver({ message: { chat: { id: 5101, type: 'private' }, from: NASTYA, caption: 'Дубль 2', video: { file_id: 'vid-1', file_size: 50e6, mime_type: 'video/mp4' }, reply_to_message: replyTo } });
  await deliver({ message: { chat: { id: 5101, type: 'private' }, from: NASTYA, document: { file_id: 'doc-x', file_name: 'смета.html', mime_type: 'text/html' }, reply_to_message: replyTo } });
  await deliver({ message: { chat: { id: 5101, type: 'private' }, from: NASTYA, text: 'https://t.me/c/1/2', reply_to_message: replyTo } });
  let t = (await tasks.load()).find((x) => x.id === id);
  const [video, doc, link] = t.attachments.slice(3);
  assert.deepEqual([video.kind, video.title, video.send, video.by], ['video', 'Дубль 2', 'video', 'Анастасия']);
  assert.equal(doc.kind, 'file');
  assert.equal(link.url, 'https://t.me/c/1/2');
  assert.equal(t.comments.length, 0, 'a bare link is an attachment, not a comment');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === 5101).pop().text, /Ссылка добавлена/);
  // HTML never opens inline (no script from uploads on the dashboard origin).
  f = await get({ task: id, a: doc.id }, owner);
  assert.equal(f.headers['content-type'], 'application/octet-stream');
  assert.match(f.headers['content-disposition'], /^attachment/);
  assert.equal(f.headers['x-content-type-options'], 'nosniff');
  // Over 20 MB Telegram won't hand it out → the bot sends it to the viewer instead.
  world.bigFiles = new Set(['vid-1']);
  f = await get({ task: id, a: video.id }, owner);
  assert.match(String(f.body), /прислали его вам в Telegram/);
  assert.equal(world.sent('sendVideo').pop().video, 'vid-1');
  // Remove.
  r = await os('tasks', { action: 'detach', id, attachment_id: link.id }, owner);
  assert.equal(r.body.task.attachments.length, 5);
  assert.match(r.body.task.history.pop().text, /Удалено вложение: Ссылка/);
  // Bot card shows the count.
  await deliver({ callback_query: { id: 'a1', from: OWNER, data: `t:o:${id}`, message: { chat: { id: 900 }, message_id: 80 } } });
  assert.match(world.sent('sendMessage').filter((m) => String(m.chat_id) === '900').pop().text, /📎 Вложений: 5/);
});
