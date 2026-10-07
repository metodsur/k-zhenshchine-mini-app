const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv({ TELEGRAM_CLUB_CHAT_ID: '-1000000000001' });
const osRoute = require('../api/os/[section]');
const meetingsRoute = require('../api/meetings/[action]');
const webhook = require('../api/telegram/webhook');
const scheduleApi = require('../api/schedule');

const OWNER = { id: 900, first_name: 'Варвара' };
const LENA = { id: 7201, first_name: 'Лена', username: 'lena' };
const ANNA = { id: 7202, first_name: 'Анна', username: 'anna' };
const DAY = 864e5;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const deliver = (update) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });
const say = (user, text) => deliver({ message: { chat: { id: user.id, type: 'private' }, from: user, text } });
const act = (action, user, body = {}) => call(meetingsRoute, { method: 'POST', query: { action }, body: { initData: initData(user), ...body } });
async function os(section, body = {}, cookie = '') {
  let out; const set = {};
  const res = { statusCode: 0, setHeader(k, v) { set[k.toLowerCase()] = v; }, end(v) { out = v ? JSON.parse(v) : undefined; } };
  await osRoute({ method: 'POST', query: { section }, headers: { 'x-kz-os': '1', cookie }, body }, res);
  return { status: res.statusCode, body: out, cookie: set['set-cookie'] || '' };
}
async function ownerCookie(world) {
  await say(OWNER, '/dashboard');
  const msg = world.sent('sendMessage').filter((m) => String(m.chat_id) === '900').pop();
  return (await os('login', { token: msg.reply_markup.inline_keyboard[0][0].url.split('#login=')[1] })).cookie.split(';')[0];
}

test('Masters: buy training → student cabinet → tasks → certified Master → «Зеркало» from the club', async () => {
  const world = createWorld();
  const owner = await ownerCookie(world);

  // A stream on sale.
  const meetings = { 1: { date: inDays(3), time: '11:00' }, 2: { date: inDays(10), time: '11:00' }, 3: { date: inDays(17), time: '11:00' } };
  let r = await os('masters', { action: 'save_training', training: { title: 'Осень 2026', city: 'Москва', price: 45000, capacity: 1, sell: true, status: 'selling', meetings, chat_url: 'https://t.me/+chat', curator: { name: 'Валерия', contact: '@valeria' } } }, owner);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.trainings[0];
  assert.equal(t.labels.length, 3);

  // Not a student yet: /master points to the Master path page.
  await say(LENA, '/master');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === LENA.id).pop().text, /после покупки обучения/);
  let cab = await act('master', LENA);
  assert.equal(cab.body.person, null);
  assert.equal(cab.body.on_sale[0].id, t.id);

  // Buy it in the app.
  const inv = await act('invoice', LENA, { kind: 'training', meeting: t.id });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  await deliver({ pre_checkout_query: { id: 'q', from: { id: LENA.id }, currency: 'RUB', total_amount: 4500000, invoice_payload: inv.body.order_id } });
  assert.equal(world.sent('answerPreCheckoutQuery').pop().ok, true);
  await deliver({ message: { chat: { id: LENA.id, type: 'private' }, from: LENA, successful_payment: { invoice_payload: inv.body.order_id, total_amount: 4500000, currency: 'RUB', order_info: { phone_number: '+7999' } } } });
  const welcome = world.sent('sendMessage').filter((m) => m.chat_id === LENA.id).pop();
  assert.match(welcome.text, /добро пожаловать в обучение Мастеров/);
  assert.match(welcome.reply_markup.inline_keyboard[0][0].web_app.url, /master-cabinet\.html$/);
  assert.equal(welcome.reply_markup.inline_keyboard[1][0].url, 'https://t.me/+chat');
  assert.match(world.sent('sendMessage').filter((m) => String(m.chat_id) === '900').pop().text, /Оплата обучения Мастеров/);
  // Capacity 1 → the stream is full for the next woman.
  assert.equal((await act('invoice', ANNA, { kind: 'training', meeting: t.id })).status, 409);

  // Student cabinet: schedule, materials, path.
  const task = (await os('collection', { name: 'training', action: 'save', item: { title: 'Провести 3 практики', audience: 'student', module: '1', kind: 'task', text: 'Опишите опыт' } }, owner)).body.item;
  await os('collection', { name: 'training', action: 'save', item: { title: 'Сценарий 6 встреч', audience: 'master', module: 'method', kind: 'doc' } }, owner);
  cab = await act('master', LENA);
  assert.equal(cab.body.person.status, 'student');
  assert.equal(cab.body.training.meetings.length, 3);
  assert.deepEqual(cab.body.materials.map((m) => m.title), ['Провести 3 практики'], 'Master-only materials are hidden from students');
  assert.equal(cab.body.path.ready, false);
  cab = await act('master', LENA, { action: 'task', material_id: task.id, done: true, answer: 'Провела' });
  assert.ok(cab.body.person.tasks[task.id].done_at);
  assert.equal((await act('master', LENA, { action: 'mirror_status', id: 'x', status: 'done' })).status, 403, 'students have no Master actions');

  // Team: attendance + final review → ready → certify.
  r = await os('masters', { action: 'person', id: '7201', patch: { attendance: ['1', '2', '3'], final_review: true } }, owner);
  assert.equal(r.body.people[0].path.ready, true);
  r = await os('masters', { action: 'certify', id: '7201' }, owner);
  assert.equal(r.body.people[0].status, 'master');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '7201').pop().text, /статус Мастера/);

  // Master: card, photo via the bot, public list.
  cab = await act('master', LENA, { action: 'profile', profile: { city: 'Москва', about: 'Веду «Зеркало» бережно', specialties: ['Практика «Зеркало»', 'Онлайн'], contact: '@lena' } });
  assert.equal(cab.body.card.city, 'Москва');
  assert.ok(cab.body.materials.some((m) => m.title === 'Сценарий 6 встреч'));
  await deliver({ message: { chat: { id: LENA.id, type: 'private' }, from: LENA, photo: [{ file_id: 'small' }, { file_id: 'big' }] } });
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === LENA.id).pop().text, /Фото для карточки/);
  const pub = await call(scheduleApi, { method: 'GET' });
  assert.equal(pub.body.masters[0].name, 'Лена');
  assert.equal(pub.body.masters[0].photo, '/api/meetings/master-photo?id=7201');

  // «Зеркало»: only club members; the Master is notified and confirms; the client is told.
  assert.equal((await act('mirror', ANNA, { action: 'book', master_id: '7201', contact: '@anna' })).status, 403);
  world.members.add('7202');
  const list = await act('mirror', ANNA);
  assert.equal(list.body.club_member, true);
  const booked = await act('mirror', ANNA, { action: 'book', master_id: '7201', wish: 'вечером в будни', format: 'online', contact: '@anna' });
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '7201').pop().text, /Новая запись на «Зеркало»/);
  cab = await act('master', LENA);
  assert.equal(cab.body.mirror.length, 1);
  cab = await act('master', LENA, { action: 'mirror_status', id: cab.body.mirror[0].id, status: 'confirmed', note: 'Во вторник в 19:00' });
  assert.equal(cab.body.mirror[0].status, 'confirmed');
  const told = world.sent('sendMessage').filter((m) => m.chat_id === '7202').pop();
  assert.match(told.text, /подтвердила.*Во вторник/s);
  assert.match(told.text, /@lena/);
  // Not accepting → booking refused.
  await act('master', LENA, { action: 'profile', profile: { ...cab.body.person.profile, accepting: false } });
  assert.equal((await act('mirror', ANNA, { action: 'book', master_id: '7201', contact: '@anna' })).status, 409);

  // /master now opens the cabinet.
  await say(LENA, '/master');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === LENA.id).pop().reply_markup.inline_keyboard[0][0].web_app.url, /master-cabinet/);
});
