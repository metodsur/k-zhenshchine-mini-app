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
  assert.ok(listed.some((m) => /Ваши открытые задачи: 19/.test(m.text)));
  assert.ok(listed.some((m) => /И ещё 4/.test(m.text)));

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
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '5101').pop().text, /Комментарий к задаче/);
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
