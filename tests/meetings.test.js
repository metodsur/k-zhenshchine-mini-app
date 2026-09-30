const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv();
const scheduleApi = require('../api/schedule');
const adminApi = require('../api/admin/schedule');
const meetingsRoute = require('../api/meetings/[action]');
const invoiceApi = (req, res) => meetingsRoute({ ...req, query: { action: 'invoice' } }, res);
const waitlistApi = (req, res) => meetingsRoute({ ...req, query: { action: 'waitlist' } }, res);
const webhook = require('../api/telegram/webhook');
const reminders = require('../lib/handlers/meeting-reminders');
const schedule = require('../lib/schedule');

const ADMIN = { id: 900, first_name: 'Варвара' };
const ANNA = { id: 101, first_name: 'Анна', username: 'anna' };
const OLGA = { id: 102, first_name: 'Ольга' };

const DAY = 24 * 60 * 60 * 1000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const inDays = (n) => isoDate(Date.now() + n * DAY);

async function adminSave(mutate) {
  const loaded = await call(adminApi, { method: 'POST', body: { initData: initData(ADMIN) } });
  const doc = loaded.body.schedule;
  mutate(doc);
  return call(adminApi, { method: 'POST', body: { initData: initData(ADMIN), action: 'save', schedule: doc } });
}

async function deliver(update) {
  return call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });
}

async function buy(user, body) {
  const inv = await call(invoiceApi, { method: 'POST', body: { initData: initData(user), ...body } });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  return inv.body.order_id;
}

async function pay(world, user, orderId, amount) {
  await deliver({ pre_checkout_query: { id: `q-${orderId}`, from: { id: user.id }, currency: 'RUB', total_amount: amount * 100, invoice_payload: orderId } });
  const answer = world.sent('answerPreCheckoutQuery').at(-1);
  if (!answer.ok) return answer;
  await deliver({ message: { message_id: 1, chat: { id: user.id, type: 'private' }, from: user, successful_payment: {
    currency: 'RUB', total_amount: amount * 100, invoice_payload: orderId,
    telegram_payment_charge_id: `tg-${orderId}`, provider_payment_charge_id: `yk-${orderId}`,
    order_info: { phone_number: '+79990001122', email: 'anna@example.test' } } } });
  return answer;
}

test('public schedule starts with every meeting as "date coming soon"', async () => {
  createWorld();
  const { status, body } = await call(scheduleApi, { method: 'GET' });
  assert.equal(status, 200);
  assert.deepEqual(body.cities.map((c) => c.name), ['Москва', 'Красноярск', 'Дубай']);
  for (const city of body.cities) {
    assert.equal(city.package_status, 'soon');
    for (const m of city.meetings) { assert.equal(m.status, 'soon'); assert.equal(m.date_label, 'Дата скоро появится'); }
  }
  assert.equal(body.prices.single, 5555);
  assert.equal(body.prices.package, 25000);
});

test('admin page is closed to non-admins and tells them their ID', async () => {
  createWorld();
  const res = await call(adminApi, { method: 'POST', body: { initData: initData(ANNA) } });
  assert.equal(res.status, 403);
  assert.equal(res.body.your_id, ANNA.id);
});

test('admin input is validated', async () => {
  createWorld();
  const res = await adminSave((doc) => { doc.cities[0].meetings['1'].date = '12.11.2026'; doc.prices.single = 0; });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.some((e) => e.includes('ГГГГ-ММ-ДД')));
  assert.ok(res.body.errors.some((e) => e.includes('Цена одной встречи')));
});

test('waitlist is notified once when the admin publishes a date', async () => {
  const world = createWorld();
  const soon = await call(invoiceApi, { method: 'POST', body: { initData: initData(ANNA), city: 'moscow', kind: 'single', meeting: '1' } });
  assert.equal(soon.status, 409);
  assert.equal(soon.body.status, 'soon');

  assert.equal((await call(waitlistApi, { method: 'POST', body: { initData: initData(ANNA), city: 'moscow', meeting: '1' } })).status, 200);
  assert.equal((await call(waitlistApi, { method: 'POST', body: { initData: initData(OLGA), city: 'moscow', kind: 'package' } })).status, 200);

  const saved = await adminSave((doc) => { Object.assign(doc.cities[0].meetings['1'], { date: inDays(20), time: '19:00', venue: 'Студия Light' }); });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.notified, 2);
  const texts = world.sent('sendMessage');
  assert.ok(texts.some((m) => m.chat_id === '101' && m.text.includes('«Основы» — Москва')));
  assert.ok(texts.some((m) => m.chat_id === '102' && m.text.includes('полный путь из 6 встреч')));

  const again = await adminSave((doc) => { doc.cities[0].meetings['1'].venue = 'Студия Light, зал 2'; });
  assert.equal(again.body.notified, 0);
});

test('full purchase: invoice, pre-checkout, ticket with details, admin alert, seats', async () => {
  const world = createWorld();
  await adminSave((doc) => {
    doc.cities[0].organizer = { name: 'Валерия', contact: '@valeria_org' };
    Object.assign(doc.cities[0].meetings['2'], { date: inDays(10), time: '18:30', venue: 'Студия Light', address: 'ул. Тверская, 1', seats: 1, bring: 'Коврик и воду', details: 'Практика целостности в круге.' });
  });

  const orderId = await buy(ANNA, { city: 'moscow', kind: 'single', meeting: '2' });
  const invoice = world.sent('createInvoiceLink').at(-1);
  assert.equal(invoice.payload, orderId);
  assert.equal(invoice.currency, 'RUB');
  assert.equal(invoice.prices[0].amount, 555500);
  assert.equal(invoice.provider_token, 'test-provider-token');

  const answer = await pay(world, ANNA, orderId, 5555);
  assert.equal(answer.ok, true);
  const ticket = world.sent('sendMessage').find((m) => m.chat_id === ANNA.id);
  assert.match(ticket.text, /Оплата получена/);
  assert.match(ticket.text, /«Целостность» — Москва/);
  assert.match(ticket.text, /ул\. Тверская, 1/);
  assert.match(ticket.text, /Коврик и воду/);
  assert.match(ticket.text, /Практика целостности в круге\./);
  assert.match(ticket.text, /Организатор: Валерия — @valeria_org/);
  const alert = world.sent('sendMessage').find((m) => m.chat_id === '900');
  assert.match(alert.text, /Новая оплата: Анна @anna/);
  assert.match(alert.text, /\+79990001122/);

  // Duplicate delivery of the same payment must not send a second ticket.
  const before = world.sent('sendMessage').length;
  await deliver({ message: { chat: { id: ANNA.id, type: 'private' }, from: ANNA, successful_payment: { invoice_payload: orderId, total_amount: 555500, currency: 'RUB' } } });
  assert.equal(world.sent('sendMessage').length, before);

  // The only seat is taken: public view shows sold out and new invoices are refused.
  const pub = await call(scheduleApi, { method: 'GET' });
  const m2 = pub.body.cities[0].meetings[1];
  assert.equal(m2.status, 'sold_out');
  assert.equal(m2.seats_left, 0);
  const refused = await call(invoiceApi, { method: 'POST', body: { initData: initData(OLGA), city: 'moscow', kind: 'single', meeting: '2' } });
  assert.equal(refused.status, 409);

  // Admin sees the participant.
  const adm = await call(adminApi, { method: 'POST', body: { initData: initData(ADMIN) } });
  assert.equal(adm.body.participants.moscow['2'][0].name, 'Анна');
});

test('pre-checkout refuses a stale, foreign or changed order', async () => {
  const world = createWorld();
  await adminSave((doc) => { Object.assign(doc.cities[1].meetings['1'], { date: inDays(5), time: '12:00', seats: 1 }); });
  const orderA = await buy(ANNA, { city: 'krasnoyarsk', kind: 'single', meeting: '1' });
  const orderB = await buy(OLGA, { city: 'krasnoyarsk', kind: 'single', meeting: '1' });

  assert.equal((await pay(world, OLGA, orderA, 5555)).ok, false, 'someone else\'s order');
  assert.equal((await pay(world, ANNA, orderA, 1)).ok, false, 'wrong amount');
  assert.equal((await pay(world, ANNA, orderA, 5555)).ok, true);
  const lastSeat = await pay(world, OLGA, orderB, 5555);
  assert.equal(lastSeat.ok, false);
  assert.match(lastSeat.error_message, /Места закончились/);
  assert.equal((await pay(world, ANNA, 'ffffffffffffffffff', 5555)).ok, false, 'unknown order');
});

test('package counts a seat in all six meetings and lists every date', async () => {
  const world = createWorld();
  await adminSave((doc) => { Object.assign(doc.cities[2].meetings['1'], { date: inDays(30), time: '11:00' }); Object.assign(doc.cities[2].meetings['3'], { date: inDays(60) }); });
  const orderId = await buy(ANNA, { city: 'dubai', kind: 'package' });
  assert.equal(world.sent('createInvoiceLink').at(-1).prices[0].amount, 2500000);
  await pay(world, ANNA, orderId, 25000);
  const ticket = world.sent('sendMessage').find((m) => m.chat_id === ANNA.id);
  assert.match(ticket.text, /полном пути из 6 встреч/);
  assert.match(ticket.text, /2\. Целостность — Дата скоро появится/);
  for (const mid of schedule.MEETING_IDS) assert.equal(world.sets.get(`tickets:dubai:${mid}`).size, 1);
});

test('past meetings are shown as past and cannot be bought', async () => {
  createWorld();
  await adminSave((doc) => { Object.assign(doc.cities[0].meetings['6'], { date: inDays(-3), time: '10:00' }); });
  const pub = await call(scheduleApi, { method: 'GET' });
  assert.equal(pub.body.cities[0].meetings[5].status, 'past');
  const res = await call(invoiceApi, { method: 'POST', body: { initData: initData(ANNA), city: 'moscow', kind: 'single', meeting: '6' } });
  assert.equal(res.status, 409);
});

test('ticket holders get one reminder the day before', async () => {
  const world = createWorld();
  await adminSave((doc) => { Object.assign(doc.cities[0].meetings['4'], { date: inDays(3), time: '19:00', bring: 'Блокнот' }); });
  const orderId = await buy(ANNA, { city: 'moscow', kind: 'single', meeting: '4' });
  await pay(world, ANNA, orderId, 5555);
  const start = schedule.meetingStart({ date: inDays(3), time: '19:00' }, 'Europe/Moscow');
  const dayBefore = start - 30 * 60 * 60 * 1000;
  const first = await reminders.runMeetingReminders(dayBefore);
  assert.equal(first.sent, 1);
  const reminder = world.sent('sendMessage').at(-1);
  assert.match(reminder.text, /завтра встреча/);
  assert.match(reminder.text, /Блокнот/);
  assert.equal((await reminders.runMeetingReminders(dayBefore + 60 * 60 * 1000)).sent, 0);
  assert.equal((await reminders.runMeetingReminders(start - 5 * 24 * 60 * 60 * 1000)).meetings, 0);
});

test('/admin opens the admin page for admins and shows the ID to others', async () => {
  const world = createWorld();
  await deliver({ message: { chat: { id: ADMIN.id, type: 'private' }, from: ADMIN, text: '/admin' } });
  assert.equal(world.sent('sendMessage').at(-1).reply_markup.inline_keyboard[0][0].web_app.url, 'https://app.example.test/admin.html');
  await deliver({ message: { chat: { id: ANNA.id, type: 'private' }, from: ANNA, text: '/admin' } });
  assert.match(world.sent('sendMessage').at(-1).text, /Ваш Telegram ID: 101/);
});

test('meeting routes: unknown action is 404, circle request reaches admins', async () => {
  const world = createWorld();
  assert.equal((await call(meetingsRoute, { method: 'POST', query: { action: 'nope' }, body: {} })).status, 404);
  const res = await call(meetingsRoute, { method: 'POST', query: { action: 'circle-request' }, body: { initData: initData(ANNA), name: 'Анна', contact: '+7 999 000-11-22', city: 'Москва', meeting: '01 — Основы' } });
  assert.equal(res.status, 200);
  const msg = world.sent('sendMessage').find((m) => m.chat_id === '900');
  assert.match(msg.text, /Заявка в женский круг/);
  assert.match(msg.text, /\+7 999 000-11-22/);
});

test('cron route runs the meeting reminder job only with the secret', async () => {
  createWorld();
  const cronRoute = require('../api/cron/[job]');
  const run = (headers, job = 'meeting-reminders') => call(cronRoute, { method: 'GET', query: { job }, headers });
  assert.equal((await run({})).status, 403);
  assert.equal((await run({ authorization: 'Bearer test-cron-secret' })).status, 200);
  assert.equal((await run({ authorization: 'Bearer test-cron-secret' }, 'unknown')).status, 404);
});
