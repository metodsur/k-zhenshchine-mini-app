const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv({ QSTASH_TOKEN: 'test-qstash', TELEGRAM_REMINDER_SECRET: 'test-reminder-secret' });
const access = require('../api/auth/access');
const webhook = require('../api/telegram/webhook');
const reminder = require('../api/telegram/reminder');

const MARIA = { id: 301, first_name: 'Мария' };

const deliver = (message) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
  body: { message: { chat: { id: message.from.id, type: 'private' }, ...message } } });
const lastButton = (world) => world.sent('sendMessage').at(-1).reply_markup.inline_keyboard[0][0];
const check = (mark) => call(access, { method: 'POST', body: { initData: initData(MARIA), mark } });

test('start flow: nothing → ritual page seen → ritual button pressed', async () => {
  const world = createWorld();
  world.members.add('301');
  let r = await check();
  assert.deepEqual([r.body.rituals_seen, r.body.onboarded], [false, false]);
  r = await check('rituals_seen');
  assert.deepEqual([r.body.rituals_seen, r.body.onboarded], [true, false]);
  r = await check();
  assert.deepEqual([r.body.rituals_seen, r.body.onboarded], [true, false], 'visiting other pages does not complete the flow');
  r = await check('ritual_done');
  assert.deepEqual([r.body.rituals_seen, r.body.onboarded], [true, true]);
});

test('non-members are never marked', async () => {
  createWorld();
  const r = await check('ritual_done');
  assert.equal(r.body.full_access, false);
  assert.equal(r.body.onboarded, false);
  assert.equal((await check()).body.onboarded, false);
});

test('/start for a new visitor: start flow and two reminders (10 min, 24 h), scheduled once', async () => {
  const world = createWorld();
  await deliver({ from: MARIA, text: '/start' });
  assert.match(world.sent('sendMessage').at(-1).text, /Добро пожаловать/);
  assert.equal(lastButton(world).web_app.url, 'https://app.example.test');
  assert.deepEqual(world.qstash.map((q) => [q.headers['Upstash-Delay'], q.body.stage]), [['10m', '10m'], ['24h', '24h']]);
  assert.match(world.qstash[0].url, /api%2Ftelegram%2Freminder/);
  await deliver({ from: MARIA, text: '/start' });
  assert.equal(world.qstash.length, 2, 'pressing /start again does not add more reminders');
});

test('reminders go only to people who still have not joined', async () => {
  const world = createWorld();
  const fire = (stage) => call(reminder, { method: 'POST', headers: { 'x-reminder-secret': 'test-reminder-secret' }, body: { chatId: 301, userId: 301, stage } });
  assert.equal((await call(reminder, { method: 'POST', headers: {}, body: { chatId: 301, userId: 301 } })).status, 403);
  await fire('10m');
  assert.match(world.sent('sendMessage').at(-1).text, /очень хотим видеть тебя/);
  await fire('24h');
  assert.match(world.sent('sendMessage').at(-1).text, /всё ещё ждём тебя/);
  assert.equal(lastButton(world).url, 'https://t.me/test_channel');
  world.members.add('301');
  const before = world.sent('sendMessage').length;
  const res = await fire('24h');
  assert.equal(res.body.skipped, 'member');
  assert.equal(world.sent('sendMessage').length, before);
});

test('/start for a member who has not reached the ritual page: start pages', async () => {
  const world = createWorld();
  world.members.add('301');
  await deliver({ from: MARIA, text: '/start' });
  assert.equal(lastButton(world).web_app.url, 'https://app.example.test/welcome-personal-telegram-ready.html');
  assert.equal(world.qstash.length, 0, 'members get no join reminders');
});

test('/start for a member who saw the ritual page but did not press the button: ritual page', async () => {
  const world = createWorld();
  world.members.add('301');
  await check('rituals_seen');
  await deliver({ from: MARIA, text: '/start' });
  assert.equal(lastButton(world).web_app.url, 'https://app.example.test/rituals.html');
});

test('/start after the ritual button: straight to the space page', async () => {
  const world = createWorld();
  world.members.add('301');
  await check('ritual_done');
  await deliver({ from: MARIA, text: '/start' });
  assert.match(world.sent('sendMessage').at(-1).text, /С возвращением/);
  assert.equal(lastButton(world).web_app.url, 'https://app.example.test/space.html');
});

test('/space opens the space for members and invites others to the channel', async () => {
  const world = createWorld();
  await deliver({ from: MARIA, text: '/space' });
  assert.equal(lastButton(world).url, 'https://t.me/test_channel');
  world.members.add('301');
  await deliver({ from: MARIA, text: '/space' });
  assert.equal(lastButton(world).web_app.url, 'https://app.example.test/space.html');
});
