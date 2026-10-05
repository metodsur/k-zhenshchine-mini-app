const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv({ QSTASH_TOKEN: 'test-qstash', TELEGRAM_REMINDER_SECRET: 'test-reminder-secret' });
const webhook = require('../api/telegram/webhook');
const access = require('../api/auth/access');
const crm = require('../lib/crm');

const ANNA = { id: 7101, first_name: 'Анна', username: 'anna' };
const deliver = (update) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });
const say = (user, text) => deliver({ message: { chat: { id: user.id, type: 'private' }, from: user, text } });

test('bot: consent before anything, then the original /start continues', async () => {
  const world = createWorld();
  world.autoConsent = false;
  await say(ANNA, '/start reels');
  let msgs = world.sent('sendMessage').filter((m) => m.chat_id === ANNA.id);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /согласие на обработку персональных данных/);
  assert.match(msgs[0].text, /href="https:\/\/app\.example\.test\/privacy\.html"/);
  assert.equal(msgs[0].reply_markup.keyboard[0][0].text, 'Согласна ✅');
  assert.equal(await crm.getCard('tg7101'), null, 'nothing stored before consent');
  assert.equal(world.qstash.length, 0);

  // Other text before consent: no reaction, still nothing stored.
  await say(ANNA, '/space');
  assert.equal(await crm.getCard('tg7101'), null);

  await say(ANNA, 'Согласна ✅');
  msgs = world.sent('sendMessage').filter((m) => m.chat_id === ANNA.id);
  assert.match(msgs[msgs.length - 2].text, /Спасибо/);
  assert.equal(msgs[msgs.length - 2].reply_markup.remove_keyboard, true);
  // The kept command was /space (the last one) → channel invitation for a non-member.
  assert.match(msgs[msgs.length - 1].text, /после вступления в канал/);
  assert.ok(world.kv.get('user:7101').includes('consent_at'));
  assert.equal((world.lists.consents || []).length, 1);

  // Next /start goes straight in; the source from the link is stored.
  await say(ANNA, '/start reels');
  const card = await crm.getCard('tg7101');
  assert.equal(card.source, 'Reels');
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === ANNA.id).pop().reply_markup.inline_keyboard[0][0].text, /Открыть приложение/);
  assert.equal(world.qstash.length, 2, 'join reminders after consent');
});

test('bot: «Согласна» right after /start continues with that /start', async () => {
  const world = createWorld();
  world.autoConsent = false;
  const OLGA = { id: 7102, first_name: 'Ольга' };
  await say(OLGA, '/start podcast');
  await say(OLGA, 'согласна');
  assert.equal((await crm.getCard('tg7102')).source, 'Подкаст');
  // Team members are not asked.
  await say({ id: 900, first_name: 'Варвара' }, '/start');
  assert.doesNotMatch(world.sent('sendMessage').filter((m) => m.chat_id === 900).pop().text, /персональных данных/);
});

test('app: overlay until she agrees; purchases are recorded regardless', async () => {
  const world = createWorld();
  world.autoConsent = false;
  const r1 = await call(access, { method: 'POST', body: { initData: initData(ANNA) } });
  assert.equal(r1.body.consent, false);
  assert.match(r1.body.policy_url, /privacy\.html$/);
  assert.equal(r1.body.subscribed, undefined, 'nothing checked or stored before consent');
  const r2 = await call(access, { method: 'POST', body: { initData: initData(ANNA), consent: true } });
  assert.equal(r2.body.consent, true);
  assert.equal(r2.body.subscribed, false);
  const r3 = await call(access, { method: 'POST', body: { initData: initData(ANNA) } });
  assert.equal(r3.body.consent, true);

  assert.equal(await crm.touch({ id: 7199 }, { type: 'x', text: 'x' }), null);
  assert.ok(await crm.touch({ id: 7199 }, { type: 'payment', force: true, payment: { product: 'Встреча', amount: 5555, ref: 'o1' } }));
});
