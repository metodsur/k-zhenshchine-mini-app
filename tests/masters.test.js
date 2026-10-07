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
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === LENA.id).pop().text, /оплатил обучение Мастеров/);
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

  // Instructions tab: starter structure for meetings and the women's circle.
  cab = await act('master', LENA);
  assert.deepEqual([...new Set(cab.body.instructions.map((i) => i.section))], ['meetings', 'circle']);
  // /master now opens the cabinet.
  await say(LENA, '/master');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === LENA.id).pop().reply_markup.inline_keyboard[0][0].web_app.url, /master-cabinet/);
});

test('Master finance: referral link, 3500 / 2500 per participant per held meeting, payouts', async () => {
  const world = createWorld();
  const owner = await ownerCookie(world);
  const masters = require('../lib/masters');
  const finance = require('../lib/master-finance');
  await os('masters', { action: 'add', id: '7401', name: 'Ирина', status: 'master' }, owner);
  const IRINA = { id: 7401, first_name: 'Ирина' };
  let cab = await act('master', IRINA);
  const link = cab.body.finance.link;
  assert.match(link, /^https:\/\/t\.me\/K_zhenshcine_bot\?start=m_[a-f0-9]{8}$/);
  const param = link.split('start=')[1];

  // Anna comes by Irina's link; Olga comes on her own; another Master's link does not override.
  const OLGA = { id: 7403, first_name: 'Ольга' };
  await say(ANNA, `/start ${param}`);
  await say(OLGA, '/start');
  await os('masters', { action: 'add', id: '7402', name: 'Другая', status: 'master' }, owner);
  const other = await masters.getPerson('7402');
  await say(ANNA, `/start m_${await finance.ensureCode(other)}`);
  await say(IRINA, `/start ${param}`); // own link: ignored
  assert.equal(world.kv.get('user:7202').includes('"ref_master":"7401"'), true);
  assert.equal(world.kv.has('user:7401') && world.kv.get('user:7401').includes('ref_master'), false);

  // Irina leads a published Moscow cycle; meeting 1 already happened, meeting 2 ahead.
  const meetings = Object.fromEntries(['1', '2', '3', '4', '5', '6'].map((m, i) => [m, { date: inDays(i === 0 ? 1 : 2 + i * 7), time: '12:00' }]));
  const c = (await os('cycles', { action: 'save', cycle: { city_id: 'moscow', status: 'selling', capacity: 15, master: { name: 'Ирина' }, master_id: '7401', meetings } }, owner)).body.cycles[0];
  await os('cycles', { action: 'publish', id: c.id }, owner);
  for (const [u, kind, meeting] of [[ANNA, 'single', '1'], [OLGA, 'single', '1'], [OLGA, 'single', '2']]) {
    const inv = await act('invoice', u, { city: 'moscow', kind, meeting });
    await deliver({ pre_checkout_query: { id: 'q', from: { id: u.id }, currency: 'RUB', total_amount: 555500, invoice_payload: inv.body.order_id } });
    await deliver({ message: { chat: { id: u.id, type: 'private' }, from: u, successful_payment: { invoice_payload: inv.body.order_id, total_amount: 555500, currency: 'RUB', order_info: {} } } });
  }
  const person = await masters.getPerson('7401');
  const f = await finance.forMaster(person, Date.now() + 2 * DAY);
  assert.equal(f.earned, 3500 + 2500, 'meeting 1: Anna by link + Olga from the space');
  assert.equal(f.expected, 2500, 'meeting 2 not held yet');
  assert.deepEqual(f.stats, { came: 1, bought: 1 });

  // No self-employed / IP data and no accepted contract → no payout.
  let r = await os('masters', { action: 'payout', id: '7401', amount: 6000 }, owner);
  assert.equal(r.status, 400);
  const bad = await act('master', IRINA, { action: 'payout_info', payout: { legal: 'self', full_name: 'Ирина', inn: '123', bank: 'карта', accepted: false } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /12 цифр.*договора/s);
  const okInfo = await act('master', IRINA, { action: 'payout_info', payout: { legal: 'self', full_name: 'Светлова Ирина Петровна', inn: '123456789012', bank: 'карта 2202', accepted: true } });
  assert.equal(okInfo.status, 200, JSON.stringify(okInfo.body));
  assert.equal(okInfo.body.finance.eligible, true);
  // Payout from the dashboard → balance and a bot message.
  r = await os('masters', { action: 'payout', id: '7401', amount: 6000, note: 'за октябрь' }, owner);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '7401').pop().text, /выплачено 6/);
  const after = await finance.forMaster(await masters.getPerson('7401'), Date.now() + 2 * DAY);
  assert.equal(after.paid, 6000);
  assert.equal(after.due, 0);
  assert.equal((await os('masters', { action: 'payout', id: '7401', amount: 0 }, owner)).status, 400);
  // CRM shows where she came from.
  const crm = require('../lib/crm');
  assert.equal((await crm.getCard('tg7202')).source, 'Мастер: Ирина');
});
