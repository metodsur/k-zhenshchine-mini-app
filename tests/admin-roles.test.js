const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv({ TELEGRAM_CLUB_CHAT_ID: '-1000000000001', TRIBUTE_API_KEY: 'test-tribute-key' });
const adminRoute = require('../api/admin/[section]');
const scheduleApi = require('../api/schedule');
const meetingsRoute = require('../api/meetings/[action]');
const access = require('../api/auth/access');
const webhook = require('../api/telegram/webhook');
const tribute = require('../lib/tribute');

const OWNER = { id: 900, first_name: 'Варвара' };
const VALERIA = { id: 5001, first_name: 'Валерия' };
const MANAGER = { id: 5002, first_name: 'Ирина' };
const CLIENT = { id: 7001, first_name: 'Анна', username: 'anna' };
const DAY = 864e5;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

const admin = (user, section, extra = {}) => call(adminRoute, { method: 'POST', query: { section }, body: { initData: initData(user), ...extra } });
const deliver = (update) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });

async function withTeam() {
  const world = createWorld();
  tribute.resetCache();
  const saved = await admin(OWNER, 'team', { action: 'save', members: [
    { id: '5001', name: 'Валерия', role: 'analyst' }, { id: '5002', name: 'Ирина', role: 'manager' }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return world;
}

async function buyMeeting(world, user, city = 'moscow', meeting = '1') {
  const inv = await call(meetingsRoute, { method: 'POST', query: { action: 'invoice' }, body: { initData: initData(user), city, kind: 'single', meeting } });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const id = inv.body.order_id;
  await deliver({ pre_checkout_query: { id: 'q', from: { id: user.id }, currency: 'RUB', total_amount: 555500, invoice_payload: id } });
  await deliver({ message: { chat: { id: user.id, type: 'private' }, from: user, successful_payment: { invoice_payload: id, total_amount: 555500, currency: 'RUB', order_info: { phone_number: '+79990001122' } } } });
}

async function setDate(user, cityIndex, mid, date) {
  const loaded = await admin(user, 'schedule');
  const doc = loaded.body.schedule;
  Object.assign(doc.cities[cityIndex].meetings[mid], { date, time: '19:00' });
  return admin(user, 'schedule', { action: 'save', schedule: doc });
}

test('each role sees only its sections', async () => {
  await withTeam();
  const expect = {
    [OWNER.id]: { me: 200, schedule: 200, analytics: 200, events: 200, team: 200 },
    [VALERIA.id]: { me: 200, schedule: 200, analytics: 200, events: 403, team: 403 },
    [MANAGER.id]: { me: 200, schedule: 200, analytics: 403, events: 200, team: 403 }
  };
  for (const user of [OWNER, VALERIA, MANAGER]) {
    for (const [section, status] of Object.entries(expect[user.id])) {
      assert.equal((await admin(user, section)).status, status, `${user.first_name} → ${section}`);
    }
  }
  assert.equal((await admin(VALERIA, 'me')).body.role, 'analyst');
  assert.equal((await admin(MANAGER, 'me')).body.role_label, 'Менеджер встреч');
  const stranger = await admin(CLIENT, 'me');
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.your_id, CLIENT.id);
});

test('client contacts: owner and manager see them, Valeria sees only counts', async () => {
  const world = await withTeam();
  await setDate(OWNER, 0, '1', inDays(10));
  await buyMeeting(world, CLIENT);
  const owner = await admin(OWNER, 'schedule');
  assert.equal(owner.body.participants.moscow['1'][0].phone, '+79990001122');
  assert.equal((await admin(MANAGER, 'schedule')).body.participants.moscow['1'][0].name, 'Анна');
  const valeria = await admin(VALERIA, 'schedule');
  assert.equal(valeria.body.participants, null);
  assert.equal(valeria.body.counts['moscow:1'], 1);
});

test('payment and request alerts go to the owner and the manager, not to Valeria', async () => {
  const world = await withTeam();
  await setDate(MANAGER, 0, '2', inDays(12));
  await buyMeeting(world, CLIENT, 'moscow', '2');
  const alerts = world.sent('sendMessage').filter((m) => /Новая оплата/.test(m.text)).map((m) => String(m.chat_id)).sort();
  assert.deepEqual(alerts, ['5002', '900']);
});

test('Valeria and the manager edit dates but not prices, and cannot remove cities', async () => {
  await withTeam();
  const loaded = await admin(VALERIA, 'schedule');
  const doc = loaded.body.schedule;
  doc.prices.single = 1;
  doc.cities[0].meetings['3'].date = inDays(20);
  const saved = await admin(VALERIA, 'schedule', { action: 'save', schedule: doc });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.schedule.prices.single, 5555, 'price change ignored');
  assert.equal(saved.body.schedule.cities[0].meetings['3'].date, inDays(20));

  const without = { ...saved.body.schedule, cities: saved.body.schedule.cities.slice(1) };
  const removed = await admin(MANAGER, 'schedule', { action: 'save', schedule: without });
  assert.equal(removed.status, 403);
  assert.match(removed.body.errors[0], /только владелец/);
  const ownerRemoves = await admin(OWNER, 'schedule', { action: 'save', schedule: without });
  assert.equal(ownerRemoves.status, 200);
});

test('team editor validates IDs and roles; owners from settings cannot be removed', async () => {
  createWorld();
  const bad = await admin(OWNER, 'team', { action: 'save', members: [{ id: 'abc', role: 'analyst' }, { id: '5003', role: 'owner' }, { id: '900', role: 'manager' }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors.length, 3);
  const ok = await admin(OWNER, 'team', { action: 'save', members: [] });
  assert.equal(ok.body.members[0].id, '900');
  assert.equal(ok.body.members[0].fixed, true);
});

test('/admin opens the admin page for every team member', async () => {
  const world = await withTeam();
  for (const user of [VALERIA, MANAGER]) {
    await deliver({ message: { chat: { id: user.id, type: 'private' }, from: user, text: '/admin' } });
    assert.ok(world.sent('sendMessage').at(-1).reply_markup, `${user.first_name} gets the button`);
  }
});

test('analytics: funnel, joins, club and meeting revenue', async () => {
  const world = await withTeam();
  world.memberCounts['@test_channel'] = 120;
  world.memberCounts['-1000000000001'] = 35;
  world.tributeSubscribers = [
    { telegramUserId: 1, status: 'active', activatedAt: new Date(Date.now() - 5 * DAY).toISOString(), expireAt: new Date(Date.now() + 3 * DAY).toISOString() },
    { telegramUserId: 2, status: 'pre_cancelled', activatedAt: new Date(Date.now() - 60 * DAY).toISOString(), expireAt: new Date(Date.now() + 20 * DAY).toISOString() },
    { telegramUserId: 3, status: 'cancelled', activatedAt: new Date(Date.now() - 90 * DAY).toISOString(), expireAt: new Date(Date.now() - 30 * DAY).toISOString() }
  ];
  world.members.add(String(CLIENT.id));
  await deliver({ message: { chat: { id: CLIENT.id, type: 'private' }, from: CLIENT, text: '/start' } });
  await deliver({ message: { chat: { id: 7002, type: 'private' }, from: { id: 7002, first_name: 'Ольга' }, text: '/start' } });
  await call(access, { method: 'POST', body: { initData: initData(CLIENT), mark: 'ritual_done' } });
  await deliver({ chat_member: { chat: { id: -100555, username: 'test_channel' }, date: Math.floor(Date.now() / 1000),
    old_chat_member: { status: 'left', user: { id: 7003 } }, new_chat_member: { status: 'member', user: { id: 7003 } } } });
  await setDate(OWNER, 1, '1', inDays(8));
  await buyMeeting(world, CLIENT, 'krasnoyarsk', '1');
  await call(meetingsRoute, { method: 'POST', query: { action: 'waitlist' }, body: { initData: initData(CLIENT), city: 'dubai', meeting: '4' } });

  const { status, body } = await admin(VALERIA, 'analytics');
  assert.equal(status, 200);
  assert.deepEqual(body.community, { channel_members: 120, club_members: 35 });
  assert.deepEqual(body.funnel, { started: 2, app_users: 1, onboarded: 1 });
  assert.equal(body.growth.joins_7d, 1);
  assert.equal(body.growth.starts_7d, 2);
  assert.equal(body.growth.joins_daily.length, 30);
  assert.deepEqual(body.club, { active: 1, cancelling: 1, cancelled: 1, new_30d: 1, ending_7d: 1 });
  assert.equal(body.meetings.orders, 1);
  assert.equal(body.meetings.revenue, 5555);
  assert.equal(body.meetings.waitlist, 1);
  const krsk = body.meetings.by_city.find((c) => c.name === 'Красноярск');
  assert.deepEqual([krsk.orders, krsk.revenue], [1, 5555]);
  assert.equal(body.meetings.by_meeting[0].seats, 1);
});

test('club events: owner edits, the public schedule shows only upcoming ones', async () => {
  await withTeam();
  const bad = await admin(OWNER, 'events', { action: 'save', events: [{ date: '', title: '' }] });
  assert.equal(bad.status, 400);
  const saved = await admin(OWNER, 'events', { action: 'save', events: [
    { date: inDays(6), title: 'День дружбы', text: 'Ритуал поддержки' },
    { date: inDays(-2), title: 'Прошедшее' },
    { date: inDays(2), title: 'Новый ритуал пары' }] });
  assert.equal(saved.status, 200);
  const pub = await call(scheduleApi, { method: 'GET' });
  assert.deepEqual(pub.body.events.map((e) => e.title), ['Новый ритуал пары', 'День дружбы']);
  assert.ok(pub.body.events[0].date_label);
  assert.equal((await admin(MANAGER, 'events', { action: 'save', events: [{ date: inDays(9), title: 'Встреча всего пространства' }] })).status, 200);
  assert.equal((await admin(VALERIA, 'events', { action: 'save', events: [] })).status, 403);
});
