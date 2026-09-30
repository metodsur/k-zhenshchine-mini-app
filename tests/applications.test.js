const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv();
const meetingsRoute = require('../api/meetings/[action]');
const adminRoute = require('../api/admin/[section]');
const webhook = require('../api/telegram/webhook');

const OWNER = { id: 900, first_name: 'Варвара' };
const ANNA = { id: 7001, first_name: 'Анна', username: 'anna' };
const apply = (user, body) => call(meetingsRoute, { method: 'POST', query: { action: 'application' }, body: { initData: initData(user), ...body } });
const admin = (section, extra = {}) => call(adminRoute, { method: 'POST', query: { section }, body: { initData: initData(OWNER), ...extra } });
const deliver = (update) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });

test('partner application reaches the team and is stored', async () => {
  const world = createWorld();
  assert.equal((await apply(ANNA, { kind: 'partner', name: '', contact: '' })).status, 400);
  assert.equal((await apply(ANNA, { kind: 'franchise', name: 'Анна', contact: '1' })).status, 400);
  const ok = await apply(ANNA, { kind: 'partner', name: 'Анна', contact: '@anna', project: 'Студия керамики для женщин' });
  assert.equal(ok.status, 200);
  const alert = world.sent('sendMessage').find((m) => m.chat_id === '900');
  assert.match(alert.text, /Заявка: Путь Партнёра/);
  assert.match(alert.text, /Студия керамики/);
  assert.equal(world.lists.applications.length, 1);
});

test('master application includes how many meetings she has passed', async () => {
  const world = createWorld();
  const doc = (await admin('schedule')).body.schedule;
  const past = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  Object.assign(doc.cities[0].meetings['1'], { date: past, time: '10:00' });
  await admin('schedule', { action: 'save', schedule: doc });
  const inv = await call(meetingsRoute, { method: 'POST', query: { action: 'invoice' }, body: { initData: initData(ANNA), city: 'moscow', kind: 'single', meeting: '1' } });
  await deliver({ pre_checkout_query: { id: 'q', from: { id: ANNA.id }, currency: 'RUB', total_amount: 555500, invoice_payload: inv.body.order_id } });
  await deliver({ message: { chat: { id: ANNA.id, type: 'private' }, from: ANNA, successful_payment: { invoice_payload: inv.body.order_id, total_amount: 555500, currency: 'RUB' } } });
  const later = (await admin('schedule')).body.schedule;
  later.cities[0].meetings['1'].date = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  await admin('schedule', { action: 'save', schedule: later });

  await apply(ANNA, { kind: 'master', name: 'Анна', contact: '@anna', city: 'Москва' });
  const alert = world.sent('sendMessage').filter((m) => m.chat_id === '900').at(-1);
  assert.match(alert.text, /Путь Мастера/);
  assert.match(alert.text, /Город: Москва/);
  assert.match(alert.text, /Пройдено встреч: 1 из 6/);
});
