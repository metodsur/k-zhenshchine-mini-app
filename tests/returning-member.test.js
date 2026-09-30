const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv();
const access = require('../api/auth/access');
const webhook = require('../api/telegram/webhook');

const MARIA = { id: 301, first_name: 'Мария' };

const deliver = (message) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
  body: { message: { chat: { id: message.from.id, type: 'private' }, ...message } } });
const lastButtonUrl = (world) => world.sent('sendMessage').at(-1).reply_markup.inline_keyboard[0][0];

test('access: onboarding is remembered once a member reaches the main pages', async () => {
  const world = createWorld();
  world.members.add('301');
  const check = (mark) => call(access, { method: 'POST', body: { initData: initData(MARIA), mark } });
  assert.equal((await check()).body.onboarded, false);
  const marked = await check('onboarded');
  assert.equal(marked.body.full_access, true);
  assert.equal(marked.body.onboarded, true);
  assert.equal((await check()).body.onboarded, true);
});

test('access: non-members are never marked as onboarded', async () => {
  createWorld();
  const res = await call(access, { method: 'POST', body: { initData: initData(MARIA), mark: 'onboarded' } });
  assert.equal(res.body.full_access, false);
  assert.equal(res.body.onboarded, false);
  assert.equal((await call(access, { method: 'POST', body: { initData: initData(MARIA) } })).body.onboarded, false);
});

test('/start: a new visitor gets the usual start flow', async () => {
  const world = createWorld();
  await deliver({ from: MARIA, text: '/start' });
  assert.match(world.sent('sendMessage').at(-1).text, /Добро пожаловать/);
  assert.equal(lastButtonUrl(world).web_app.url, 'https://app.example.test');
});

test('/start: a member who has not seen the start pages begins with them', async () => {
  const world = createWorld();
  world.members.add('301');
  await deliver({ from: MARIA, text: '/start' });
  assert.equal(lastButtonUrl(world).web_app.url, 'https://app.example.test/welcome-personal-telegram-ready.html');
});

test('/start: a returning member goes straight to the space page', async () => {
  const world = createWorld();
  world.members.add('301');
  await call(access, { method: 'POST', body: { initData: initData(MARIA), mark: 'onboarded' } });
  await deliver({ from: MARIA, text: '/start' });
  assert.match(world.sent('sendMessage').at(-1).text, /С возвращением/);
  assert.equal(lastButtonUrl(world).web_app.url, 'https://app.example.test/space.html');
  assert.equal(world.sent('sendMessage').length, 1, 'no "join the channel" reminder for members');
});

test('/space opens the space for members and invites others to the channel', async () => {
  const world = createWorld();
  await deliver({ from: MARIA, text: '/space' });
  assert.equal(lastButtonUrl(world).url, 'https://t.me/test_channel');
  world.members.add('301');
  await deliver({ from: MARIA, text: '/space' });
  assert.equal(lastButtonUrl(world).web_app.url, 'https://app.example.test/space.html');
});
