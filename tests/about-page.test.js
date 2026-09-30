const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv();
const me = require('../api/auth/me');
const adminRoute = require('../api/admin/[section]');
const scheduleApi = require('../api/schedule');
const meetingsRoute = require('../api/meetings/[action]');
const webhook = require('../api/telegram/webhook');

const OWNER = { id: 900, first_name: 'Варвара' };
const MANAGER = { id: 5002, first_name: 'Ирина' };
const ANNA = { id: 7001, first_name: 'Анна', photo_url: 'https://t.me/i/userpic/anna.jpg' };
const DAY = 864e5;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const admin = (u, section, extra = {}) => call(adminRoute, { method: 'POST', query: { section }, body: { initData: initData(u), ...extra } });
const profileOf = (u, extra = {}) => call(me, { method: 'POST', body: { initData: initData(u), ...extra } });
const deliver = (update) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });

async function buy(user, city, kind, meeting) {
  const inv = await call(meetingsRoute, { method: 'POST', query: { action: 'invoice' }, body: { initData: initData(user), city, kind, meeting } });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const amount = kind === 'package' ? 25000 : 5555;
  await deliver({ pre_checkout_query: { id: 'q', from: { id: user.id }, currency: 'RUB', total_amount: amount * 100, invoice_payload: inv.body.order_id } });
  await deliver({ message: { chat: { id: user.id, type: 'private' }, from: user, successful_payment: { invoice_payload: inv.body.order_id, total_amount: amount * 100, currency: 'RUB' } } });
}

test('profile: vision, facets and resources are saved on the server', async () => {
  createWorld();
  const empty = await profileOf(ANNA);
  assert.equal(empty.body.profile.vision, '');
  assert.ok(empty.body.profile.facets.includes('Мама'));
  assert.equal(empty.body.user.photo_url, 'https://t.me/i/userpic/anna.jpg');
  await profileOf(ANNA, { action: 'save_profile', profile: { vision: 'Я создаю и вдохновляю', facets: ['Женщина', 'Художница', 'Художница', ''], resources: ['Партнёрство', 'Идеи'] } });
  const saved = (await profileOf(ANNA)).body.profile;
  assert.equal(saved.vision, 'Я создаю и вдохновляю');
  assert.ok(saved.vision_updated_at);
  assert.deepEqual(saved.facets, ['Женщина', 'Художница']);
  assert.deepEqual(saved.resources, ['Партнёрство', 'Идеи']);
  await profileOf(ANNA, { action: 'save_profile', profile: { resources: [] } });
  const after = (await profileOf(ANNA)).body.profile;
  assert.equal(after.vision, 'Я создаю и вдохновляю', 'partial save keeps other fields');
  assert.deepEqual(after.resources, []);
});

test('my meetings: tickets with dates, package rows and passed count', async () => {
  createWorld();
  const doc = (await admin(OWNER, 'schedule')).body.schedule;
  Object.assign(doc.cities[0].meetings['1'], { date: inDays(10), time: '19:00', venue: 'Студия Light', address: 'Тверская, 1' });
  Object.assign(doc.cities[2].meetings['1'], { date: inDays(20), time: '11:00' });
  await admin(OWNER, 'schedule', { action: 'save', schedule: doc });
  await buy(ANNA, 'moscow', 'single', '1');
  await buy(ANNA, 'dubai', 'package');
  // Move the Moscow meeting into the past: it must count as passed.
  const later = (await admin(OWNER, 'schedule')).body.schedule;
  later.cities[0].meetings['1'].date = inDays(-2);
  await admin(OWNER, 'schedule', { action: 'save', schedule: later });

  const { body } = await profileOf(ANNA);
  assert.equal(body.tickets.items.length, 7);
  assert.equal(body.tickets.passed, 1);
  assert.equal(body.tickets.items[0].status, 'upcoming');
  assert.equal(body.tickets.items[0].city, 'Дубай');
  assert.equal(body.tickets.items.filter((t) => t.status === 'soon').length, 5);
  const past = body.tickets.items.find((t) => t.status === 'past');
  assert.equal(past.title, 'Основы');
  assert.equal(past.address, 'Тверская, 1');
});

test('links: only the owner sets them; they reach the public schedule and the profile', async () => {
  createWorld();
  await admin(OWNER, 'team', { action: 'save', members: [{ id: '5002', name: 'Ирина', role: 'manager' }] });
  assert.equal((await admin(MANAGER, 'settings')).status, 403);
  const bad = await admin(OWNER, 'settings', { action: 'save', settings: { materials_url: 'not a link' } });
  assert.equal(bad.status, 400);
  const ok = await admin(OWNER, 'settings', { action: 'save', settings: { materials_url: 'https://t.me/k_zhenshcine/10', ritual_url: 'https://t.me/+ritual' } });
  assert.equal(ok.status, 200);
  const pub = await call(scheduleApi, { method: 'GET' });
  assert.equal(pub.body.links.materials_url, 'https://t.me/k_zhenshcine/10');
  assert.equal(pub.body.links.ritual_url, 'https://t.me/+ritual');
  assert.equal((await profileOf(ANNA)).body.links.materials_url, 'https://t.me/k_zhenshcine/10');
});
