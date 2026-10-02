const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv({ QSTASH_TOKEN: 'test-qstash', TELEGRAM_REMINDER_SECRET: 'test-reminder-secret' });
const adminRoute = require('../api/admin/[section]');
const meetingsRoute = require('../api/meetings/[action]');
const webhook = require('../api/telegram/webhook');
const reminder = require('../api/telegram/reminder');
const crm = require('../lib/crm');
const tribute = require('../lib/tribute');

const OWNER = { id: 900, first_name: 'Варвара' };
const CLIENT = { id: 7001, first_name: 'Анна', username: 'anna' };
const DAY = 864e5;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const deliver = (update) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });
const admin = (user, section, extra = {}) => call(adminRoute, { method: 'POST', query: { section }, body: { initData: initData(user), ...extra } });

async function openMoscow(dates) {
  const sched = (await admin(OWNER, 'schedule')).body.schedule;
  ['1', '2', '3', '4', '5', '6'].forEach((m, i) => { sched.cities[0].meetings[m].date = dates[i]; sched.cities[0].meetings[m].time = '12:00'; });
  const r = await admin(OWNER, 'schedule', { action: 'save', schedule: sched });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
async function invoice(user, kind = 'single', meeting = '1') {
  const r = await call(meetingsRoute, { method: 'POST', query: { action: 'invoice' }, body: { initData: initData(user), city: 'moscow', kind, meeting } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.order_id;
}
async function pay(user, id, amount = 555500) {
  await deliver({ pre_checkout_query: { id: 'q', from: { id: user.id }, currency: 'RUB', total_amount: amount, invoice_payload: id } });
  await deliver({ message: { chat: { id: user.id, type: 'private' }, from: user, successful_payment: { invoice_payload: id, total_amount: amount, currency: 'RUB', order_info: {} } } });
}
const fire = (body) => call(reminder, { method: 'POST', headers: { 'x-reminder-secret': 'test-reminder-secret' }, body });

test('abandoned checkout: reminder in an hour, CRM step, reply reaches the team', async () => {
  const world = createWorld();
  await openMoscow([inDays(5), inDays(12), inDays(19), inDays(26), inDays(33), inDays(40)]);
  const id = await invoice(CLIENT);
  await invoice(CLIENT); // a second try within 6 hours schedules no second reminder
  const scheduled = world.qstash.filter((q) => q.body.kind === 'checkout');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].headers['Upstash-Delay'], '60m');

  const r = await fire(scheduled[0].body);
  assert.equal(r.body.sent, 1);
  const msg = world.sent('sendMessage').filter((m) => m.chat_id === CLIENT.id).pop();
  assert.match(msg.text, /оплата не завершилась/);
  const card = await crm.getCard('tg7001');
  assert.equal(card.stage, 'offer');
  assert.match(card.next_step.action, /Не завершила оплату/);

  // She answers → the owner gets it, the card gets the message.
  await deliver({ message: { chat: { id: CLIENT.id, type: 'private' }, from: CLIENT, text: 'Карта не проходит, можно по ссылке?' } });
  const alert = world.sent('sendMessage').filter((m) => m.chat_id === '900').pop();
  assert.match(alert.text, /Карта не проходит/);
  assert.match((await crm.getCard('tg7001')).history.pop().text, /Карта не проходит/);

  // Paid → no reminder.
  const id2 = await invoice({ id: 7002, first_name: 'Мария' }, 'single', '2');
  await pay({ id: 7002, first_name: 'Мария' }, id2);
  assert.equal((await fire({ kind: 'checkout', orderId: id2 })).body.skipped, 'paid');
  // Paid with a newer order → no reminder for the old one.
  const id3 = await invoice(CLIENT, 'single', '3');
  await pay(CLIENT, await invoice(CLIENT, 'single', '3'));
  assert.equal((await fire({ kind: 'checkout', orderId: id3 })).body.skipped, 'paid');
  assert.ok(id);
});

test('automatic follow-ups: after 1st and 6th meeting, 3 days in channel, club cancelled', async () => {
  const world = createWorld();
  tribute.resetCache();
  const { runAutoFollowups } = require('../lib/crm-automation');
  await openMoscow([inDays(1), inDays(2), inDays(3), inDays(4), inDays(5), inDays(6)]);
  const MARIA = { id: 7002, first_name: 'Мария' };
  await pay(CLIENT, await invoice(CLIENT, 'single', '1'));
  await pay(MARIA, await invoice(MARIA, 'single', '6'));
  // A week later everything has happened.
  const later = Date.now() + 8 * DAY;
  let r = await runAutoFollowups(later);
  assert.equal(r.after_first, 1);
  assert.equal(r.after_sixth, 1);
  const anna = await crm.getCard('tg7001');
  assert.equal(anna.stage, 'followup');
  assert.match(anna.next_step.action, /предложить пакет/);
  assert.ok((await crm.getCard('tg7002')).interests.includes('master'));
  r = await runAutoFollowups(later);
  assert.equal(r.after_first + r.after_sixth, 0, 'each rule fires once');

  // Joined the channel, bought nothing for 3 days.
  const OLGA = { id: 7003, first_name: 'Ольга' };
  await deliver({ chat_member: { chat: { id: '@test_channel', username: 'test_channel' }, date: Math.floor(Date.now() / 1000), old_chat_member: { status: 'left', user: OLGA }, new_chat_member: { status: 'member', user: OLGA } } });
  assert.equal((await runAutoFollowups(Date.now() + 1 * DAY)).welcome, 0);
  assert.equal((await runAutoFollowups(Date.now() + 4 * DAY)).welcome, 1);
  assert.match((await crm.getCard('tg7003')).next_step.action, /3 дня в канале/);

  // Club cancelled → ask why; an already planned step is not overwritten.
  await crm.updateCard('tg7003', { next_step: { date: inDays(2), action: 'Созвон' } }, 'Валерия');
  await crm.syncClub([{ telegramUserId: 7003, status: 'pre_cancelled', expireAt: '2026-11-01T00:00:00Z' }]);
  assert.equal((await runAutoFollowups(Date.now())).club_cancel, 1);
  const olga = await crm.getCard('tg7003');
  assert.equal(olga.next_step.action, 'Созвон');
  assert.match(olga.history.pop().text, /Автоподсказка: Отменила подписку/);
});

const osRoute = require('../api/os/[section]');
async function os(section, body = {}, cookie = '') {
  let out; const set = {};
  const res = { statusCode: 0, setHeader(k, v) { set[k.toLowerCase()] = v; }, end(v) { out = v ? JSON.parse(v) : undefined; } };
  await osRoute({ method: 'POST', query: { section }, headers: { 'x-kz-os': '1', cookie }, body }, res);
  return { status: res.statusCode, body: out, cookie: set['set-cookie'] || '' };
}
async function loginAs(world, user) {
  await deliver({ message: { chat: { id: user.id, type: 'private' }, from: user, text: '/dashboard' } });
  const msg = world.sent('sendMessage').filter((m) => String(m.chat_id) === String(user.id)).pop();
  const r = await os('login', { token: msg.reply_markup.inline_keyboard[0][0].url.split('#login=')[1] });
  return r.cookie.split(';')[0];
}
const VALERIA = { id: 5001, first_name: 'Валерия' };
const IRINA = { id: 5002, first_name: 'Ирина' };
const ELENA = { id: 5005, first_name: 'Елена' };
async function team() {
  const r = await admin(OWNER, 'team', { action: 'save', members: [
    { id: '5001', name: 'Валерия', role: 'director' }, { id: '5002', name: 'Ирина', role: 'manager' }, { id: '5005', name: 'Елена', role: 'master' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test('assignments notify, «Моё» digest in the morning', async () => {
  const world = createWorld();
  await team();
  const valeria = await loginAs(world, VALERIA);
  await deliver({ message: { chat: { id: CLIENT.id, type: 'private' }, from: CLIENT, text: '/start' } });
  await os('crm', { action: 'update', id: 'tg7001', patch: { owner: 'Ирина', next_step: { date: inDays(0), action: 'Позвонить' } } }, valeria);
  const note = world.sent('sendMessage').filter((m) => String(m.chat_id) === '5002').pop();
  assert.match(note.text, /Вам передана карточка в CRM: Анна/);
  await os('tasks', { action: 'save', task: { title: 'Найти площадку', owner: 'Ирина', due: inDays(0) } }, valeria);
  assert.match(world.sent('sendMessage').filter((m) => String(m.chat_id) === '5002').pop().text, /Задача: Найти площадку/);

  const { runDigest } = require('../lib/digest');
  const weekdayNoon = (() => { let t = Date.now(); while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY; return t; })();
  const r = await runDigest(weekdayNoon);
  assert.ok(r.sent >= 1);
  const digest = world.sent('sendMessage').filter((m) => String(m.chat_id) === '5002').pop();
  assert.match(digest.text, /Доброе утро, Ирина/);
  assert.match(digest.text, /Анна — Позвонить/);
  assert.match(digest.text, /Найти площадку/);
  assert.equal((await runDigest(weekdayNoon)).sent, 0, 'once a day');
});

test('templates, broadcast with opt-out, replies', async () => {
  const world = createWorld();
  await team();
  const valeria = await loginAs(world, VALERIA);
  const irina = await loginAs(world, IRINA);
  const tpl = await os('collection', { name: 'templates', action: 'list' }, valeria);
  assert.ok(tpl.body.items.length >= 5, 'starter templates');
  const MARIA = { id: 7002, first_name: 'Мария' };
  for (const u of [CLIENT, MARIA]) await deliver({ message: { chat: { id: u.id, type: 'private' }, from: u, text: '/start' } });
  await deliver({ message: { chat: { id: MARIA.id, type: 'private' }, from: MARIA, text: '/stop' } });
  const manual = (await os('crm', { action: 'create', card: { name: 'Без бота' } }, valeria)).body.card;
  const ids = ['tg7001', 'tg7002', manual.id];
  const pre = await os('crm', { action: 'broadcast_preview', ids, text: '{имя}, есть места!' }, valeria);
  assert.deepEqual([pre.body.recipients, pre.body.skipped_opt_out, pre.body.skipped_no_bot], [1, 1, 1]);
  assert.equal(pre.body.sample[0].text, 'Анна, есть места!');
  assert.equal((await os('crm', { action: 'broadcast', ids, text: 'x' }, irina)).status, 403, 'manager cannot broadcast');
  const sent = await os('crm', { action: 'broadcast', ids, text: '{имя}, есть места!', button: 'meetings' }, valeria);
  assert.equal(sent.body.sent, 1);
  const msg = world.sent('sendMessage').filter((m) => m.chat_id === '7001').pop();
  assert.match(msg.text, /^Анна, есть места!/);
  assert.match(msg.text, /\/stop/);
  assert.equal(msg.reply_markup.inline_keyboard[0][0].text, 'Выбрать встречу');
  await deliver({ message: { chat: { id: CLIENT.id, type: 'private' }, from: CLIENT, text: 'Хочу в Москву!' } });
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '900').pop().text, /Хочу в Москву/);
});

test('Master sees only her group and marks attendance; reviews; weekly report; morning run', async () => {
  const world = createWorld();
  tribute.resetCache();
  await team();
  const valeria = await loginAs(world, VALERIA);
  const elena = await loginAs(world, ELENA);
  const meetings = Object.fromEntries(['1', '2', '3', '4', '5', '6'].map((m, i) => [m, { date: inDays(1 + i), time: '12:00' }]));
  const c1 = (await os('cycles', { action: 'save', cycle: { city_id: 'moscow', status: 'selling', capacity: 15, master: { name: 'Елена' }, master_id: '5005', meetings } }, valeria)).body.cycles[0];
  await os('cycles', { action: 'save', cycle: { city_id: 'dubai', status: 'planned', capacity: 15, master: { name: 'Другая' }, meetings: {} } }, valeria);
  await os('cycles', { action: 'publish', id: c1.id }, valeria);
  assert.match(world.sent('sendMessage').filter((m) => String(m.chat_id) === '5005').pop().text, /Вы — Мастер цикла/);
  await pay(CLIENT, await invoice(CLIENT, 'single', '1'));

  // Master: only her cycle, only cycles and attendance.
  const mine = await os('cycles', { action: 'list' }, elena);
  assert.equal(mine.body.cycles.length, 1);
  assert.equal(mine.body.cycles[0].participants[0].name, 'Анна');
  assert.equal((await os('today', {}, elena)).status, 403);
  assert.equal((await os('crm', { action: 'list' }, elena)).status, 403);
  assert.equal((await os('cycles', { action: 'save', cycle: { city_id: 'moscow' } }, elena)).status, 403);
  const marked = await os('cycles', { action: 'attendance', id: c1.id, meeting: '1', present: ['7001'] }, elena);
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  assert.deepEqual(marked.body.cycles[0].participants[0].attended, ['1']);

  // The day after meeting 1: review request → score → text → consent.
  const { runReviewRequests } = require('../lib/reviews');
  const r = await runReviewRequests(Date.now() + 2 * DAY);
  assert.equal(r.asked, 1);
  const ask = world.sent('sendMessage').filter((m) => m.chat_id === 7001).pop();
  assert.match(ask.text, /Оцени/);
  const reply = (text) => deliver({ message: { chat: { id: CLIENT.id, type: 'private' }, from: CLIENT, text } });
  await reply('отлично');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === 7001).pop().text, /число от 1 до 10/);
  await reply('5');
  await reply('Было глубоко, но мало времени');
  await reply('Да, но без имени');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '900').pop().text, /Низкая оценка.*5\/10/s);
  const lib = await os('collection', { name: 'library', action: 'list' }, valeria);
  assert.equal(lib.body.items[0].category, 'reviews');
  assert.match(lib.body.items[0].title, /без имени/);
  const rated = await os('cycles', { action: 'list' }, valeria);
  assert.equal(rated.body.cycles.find((c) => c.id === c1.id).rating.avg, 5);

  // Weekly report goes to the owner on Monday only, once.
  const { runWeeklyReport, buildReport } = require('../lib/weekly-report');
  let monday = Date.now(); while (new Date(monday + 3 * 3600e3).getUTCDay() !== 1) monday += DAY;
  assert.match(await buildReport(monday), /Отчёт недели/);
  assert.equal((await runWeeklyReport(monday)).sent, 1);
  assert.equal((await runWeeklyReport(monday)).skipped, 'sent');

  // Morning run: every step reports, none crashes.
  const morning = await require('../lib/morning').runMorning();
  for (const k of ['meetings', 'auto_followups', 'reviews', 'rhythm', 'weekly_report', 'digest']) assert.ok(morning[k] && !morning[k].error, k);
});
