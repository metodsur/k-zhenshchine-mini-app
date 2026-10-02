const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv();
const osRoute = require('../api/os/[section]');
const adminRoute = require('../api/admin/[section]');
const meetingsRoute = require('../api/meetings/[action]');
const webhook = require('../api/telegram/webhook');
const tribute = require('../lib/tribute');

const OWNER = { id: 900, first_name: 'Варвара' };
const VALERIA = { id: 5001, first_name: 'Валерия' };
const ANALYST = { id: 5003, first_name: 'Ольга' };
const CLIENT = { id: 7001, first_name: 'Анна', username: 'anna' };
const DAY = 864e5;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

const deliver = (update) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });
const say = (user, text) => deliver({ message: { chat: { id: user.id, type: 'private' }, from: user, text } });
const admin = (user, section, extra = {}) => call(adminRoute, { method: 'POST', query: { section }, body: { initData: initData(user), ...extra } });

// Calls the dashboard API like the browser does (cookie + X-KZ-OS header).
async function os(section, body = {}, cookie = '', headers = { 'x-kz-os': '1' }) {
  let out; const set = {};
  const res = { statusCode: 0, setHeader(k, v) { set[k.toLowerCase()] = v; }, end(v) { out = v ? JSON.parse(v) : undefined; } };
  await osRoute({ method: 'POST', query: { section }, headers: { ...headers, cookie }, body }, res);
  return { status: res.statusCode, body: out, cookie: set['set-cookie'] || '' };
}

async function login(world, user) {
  await say(user, '/dashboard');
  const msg = world.sent('sendMessage').filter((m) => String(m.chat_id) === String(user.id)).pop();
  const url = msg.reply_markup && msg.reply_markup.inline_keyboard[0][0].url;
  if (!url) return null;
  const token = url.split('#login=')[1];
  const r = await os('login', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.cookie.split(';')[0];
}

async function setup() {
  const world = createWorld();
  tribute.resetCache();
  const saved = await admin(OWNER, 'team', { action: 'save', members: [
    { id: '5001', name: 'Валерия', role: 'director' }, { id: '5003', name: 'Ольга', role: 'analyst' }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return world;
}

test('dashboard login: one-time bot link, cookie session, roles', async () => {
  const world = await setup();
  const cookie = await login(world, VALERIA);
  assert.match(cookie, /^kz_os=[a-f0-9]{48}$/);
  const me = await os('me', {}, cookie);
  assert.equal(me.body.role, 'director');
  assert.ok(me.body.perms.includes('cycles.edit'));
  assert.ok(!me.body.perms.includes('team.manage'));

  // The link works once.
  const msg = world.sent('sendMessage').filter((m) => m.chat_id === VALERIA.id).pop();
  const again = await os('login', { token: msg.reply_markup.inline_keyboard[0][0].url.split('#login=')[1] });
  assert.equal(again.status, 401);

  // No header → refused; no cookie → 401.
  assert.equal((await os('me', {}, cookie, {})).status, 403);
  assert.equal((await os('me', {}, '')).status, 401);

  // A role without dashboard access and a stranger get no link.
  await say(ANALYST, '/dashboard');
  await say(CLIENT, '/dashboard');
  for (const id of [ANALYST.id, CLIENT.id]) {
    const m = world.sent('sendMessage').filter((x) => x.chat_id === id).pop();
    assert.ok(!m.reply_markup, 'no login button');
    assert.match(m.text, /Telegram ID/);
  }

  // Removing someone from the team ends the session at once.
  await admin(OWNER, 'team', { action: 'save', members: [] });
  assert.equal((await os('me', {}, cookie)).status, 401);
});

test('CRM fills itself: start with source, waitlist, payment', async () => {
  const world = await setup();
  await say(CLIENT, '/start podcast');
  await say(CLIENT, '/start');
  const cookie = await login(world, VALERIA);
  let list = await os('crm', { action: 'list' }, cookie);
  assert.equal(list.body.cards.length, 1);
  const card = list.body.cards[0];
  assert.equal(card.id, 'tg7001');
  assert.equal(card.source, 'Подкаст');
  assert.equal(card.stage, 'new');
  assert.equal(card.username, 'anna');

  await call(meetingsRoute, { method: 'POST', query: { action: 'waitlist' }, body: { initData: initData(CLIENT), city: 'moscow', kind: 'package' } });
  let full = await os('crm', { action: 'get', id: 'tg7001' }, cookie);
  assert.deepEqual(full.body.card.interests, ['cycle']);
  assert.equal(full.body.card.history.length, 2, 'second /start did not add history');

  // Work with the card.
  const upd = await os('crm', { action: 'update', id: 'tg7001', patch: { stage: 'dialog', next_step: { date: inDays(0), action: 'Позвонить про цикл' } } }, cookie);
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.match(upd.body.card.history.pop().text, /Новая → Диалог/);
  const today = await os('today', {}, cookie);
  assert.equal(today.body.followups[0].id, 'tg7001');
  assert.equal(today.body.kpi.leads_7d, 1);

  const bad = await os('crm', { action: 'update', id: 'tg7001', patch: { stage: 'refused', refusal_reason: '' } }, cookie);
  assert.equal(bad.status, 400);
  const manual = await os('crm', { action: 'create', card: { name: 'Мария', phone: '+7 900', interests: ['club'] } }, cookie);
  assert.equal(manual.status, 200);
  assert.equal(manual.body.card.source, 'Другое');
});

test('cycles: publish to the app, purchases belong to the cycle, calendar', async () => {
  const world = await setup();
  const cookie = await login(world, VALERIA);
  const meetings = Object.fromEntries(['1', '2', '3', '4', '5', '6'].map((m, i) => [m, { date: inDays(5 + i * 7), time: '12:00' }]));
  const created = await os('cycles', { action: 'save', cycle: { city_id: 'moscow', status: 'selling', capacity: 15, master: { name: 'Елена' }, venue: 'Студия Свет', meetings } }, cookie);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const cycle = created.body.cycles[0];
  assert.equal(cycle.published, false);

  // Somebody waits for the date → told when the cycle goes into the app.
  await call(meetingsRoute, { method: 'POST', query: { action: 'waitlist' }, body: { initData: initData(CLIENT), city: 'moscow', kind: 'package' } });
  const pub = await os('cycles', { action: 'publish', id: cycle.id }, cookie);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal(pub.body.notified, 1);
  assert.equal(pub.body.cycles[0].published, true);

  // Buy a meeting in the app → the order and the CRM card point to the cycle.
  const inv = await call(meetingsRoute, { method: 'POST', query: { action: 'invoice' }, body: { initData: initData(CLIENT), city: 'moscow', kind: 'single', meeting: '1' } });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const id = inv.body.order_id;
  await deliver({ pre_checkout_query: { id: 'q', from: { id: CLIENT.id }, currency: 'RUB', total_amount: 555500, invoice_payload: id } });
  await deliver({ message: { chat: { id: CLIENT.id, type: 'private' }, from: CLIENT, successful_payment: { invoice_payload: id, total_amount: 555500, currency: 'RUB', order_info: { phone_number: '+79990001122' } } } });
  const list = await os('cycles', { action: 'list' }, cookie);
  const c = list.body.cycles[0];
  assert.equal(c.participants.length, 1);
  assert.equal(c.participants[0].phone, '+79990001122');
  assert.equal(c.seats_by_meeting['1'], 1);
  assert.equal(c.free_seats, 14);
  const card = (await os('crm', { action: 'get', id: 'tg7001' }, cookie)).body.card;
  assert.equal(card.stage, 'paid');
  assert.equal(card.cycle_id, cycle.id);
  assert.equal(card.payments[0].amount, 5555);

  // Dates edited on the phone show in the dashboard; the cycle link survives.
  const sched = (await admin(OWNER, 'schedule')).body.schedule;
  sched.cities[0].meetings['2'].time = '15:00';
  assert.equal((await admin(OWNER, 'schedule', { action: 'save', schedule: sched })).status, 200);
  const after = (await os('cycles', { action: 'list' }, cookie)).body.cycles[0];
  assert.equal(after.published, true);
  assert.equal(after.meetings['2'].time, '15:00');

  // Calendar: 6 meetings + a manual entry.
  assert.equal((await os('calendar', { action: 'save', entry: { date: inDays(3), title: 'Съёмка Reels', type: 'shoot', varvara: true } }, cookie)).status, 200);
  const cal = await os('calendar', { action: 'list', from: inDays(0), to: inDays(60) }, cookie);
  assert.equal(cal.body.items.filter((i) => i.kind === 'cycle').length, 6);
  assert.equal(cal.body.items[0].title, 'Съёмка Reels');

  // Unpublish → app back to "дата скоро".
  await os('cycles', { action: 'unpublish', id: cycle.id }, cookie);
  const pubView = (await admin(OWNER, 'schedule')).body.schedule.cities[0];
  assert.equal(pubView.meetings['1'].date, '');
  assert.equal(pubView.cycle_id, null);
});

test('tasks with blockers show first on "Сегодня"', async () => {
  const world = await setup();
  const cookie = await login(world, VALERIA);
  await os('tasks', { action: 'save', task: { title: 'Найти площадку в Дубае', due: inDays(2) } }, cookie);
  await os('tasks', { action: 'save', task: { title: 'Нет монтажёра', blocker: true } }, cookie);
  const today = await os('today', {}, cookie);
  assert.equal(today.body.tasks[0].title, 'Нет монтажёра');
  const bad = await os('tasks', { action: 'save', task: { title: '' } }, cookie);
  assert.equal(bad.status, 400);
});
