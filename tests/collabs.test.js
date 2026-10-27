const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, call } = require('./helpers/fake-world');

setupEnv({ TELEGRAM_CLUB_CHAT_ID: '-1004375885816', LEVELS_URL: 'https://levels.example.test', LEVELS_SYNC_SECRET: 'levels-secret' });
const webhook = require('../api/telegram/webhook');
const collabs = require('../lib/collabs');
const journey = require('../lib/journey');

const CLUB = { id: -1004375885816, type: 'supergroup' };
const post = (body) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body });
const deliver = (message) => post({ message: { chat: CLUB, ...message } });
const tap = (from, msg) => post({ callback_query: { id: `q${from.id}`, from, data: `c:y:${msg}`, message: { chat: CLUB } } });
const MARIA = { id: 2, username: 'Maria_V', first_name: 'Мария' };
const ANNA = { id: 3, username: 'anna_k', first_name: 'Анна' };
const mention = (text, who) => ({ type: 'mention', offset: text.indexOf(who), length: who.length });

test('a tagged partner confirms: both get +1, the club counter grows, «Уровни» receive the pair', async () => {
  const world = createWorld();
  const text = 'Снимаем вместе курс с @anna_k #коллаборация';
  await deliver({ message_id: 50, from: MARIA, text, entities: [mention(text, '@anna_k')] });
  const ask = world.sent('sendMessage').find((m) => m.reply_to_message_id === 50);
  assert.match(ask.text, /@anna_k, подтверди/);
  assert.equal(ask.reply_markup.inline_keyboard[0][0].callback_data, 'c:y:50');

  await tap(MARIA, 50);
  assert.equal(await collabs.countFor(2), 0, 'the author cannot confirm alone');
  await tap({ id: 9, username: 'someone' }, 50);
  assert.equal(await collabs.countFor(9), 0, 'only a tagged partner confirms');

  await tap(ANNA, 50);
  await tap(ANNA, 50);
  assert.equal(await collabs.countFor(2), 1);
  assert.equal(await collabs.countFor(3), 1);
  assert.equal(world.kv.get('stats:club:collabs:total'), '1');
  assert.deepEqual(world.levels.map((l) => [l.auth, l.body]), [['Bearer levels-secret', { id: 'c:-1004375885816:50', handles: ['maria_v', 'anna_k'] }]]);
  assert.ok(world.sent('sendMessage').some((m) => /засчитана 🎉/.test(m.text) && /1-я коллаборация клуба/.test(m.text)));

  const j = await journey.build(2, { space: {}, club: { member: true }, tickets: {}, profile: {}, start: {} });
  assert.equal(j.collabs, 1);
  assert.ok(j.wins.includes('Создала 1 коллаборацию в клубе'));
});

test('no tags: the bot asks to tag; the author tags in a reply and the partner confirms', async () => {
  const world = createWorld();
  await deliver({ message_id: 60, from: MARIA, text: 'У нас коллаб! #коллаборация' });
  assert.match(world.sent('sendMessage').at(-1).text, /Отметь в ответе/);
  await tap(ANNA, 60);
  assert.equal(await collabs.countFor(3), 0);

  const reply = 'это мы с @anna_k';
  await deliver({ message_id: 61, from: { id: 7 }, text: reply, entities: [mention(reply, '@anna_k')], reply_to_message: { message_id: 60 } });
  assert.equal(world.sent('sendMessage').filter((m) => /подтверди/.test(m.text || '')).length, 0, 'only the author adds partners');
  await deliver({ message_id: 62, from: MARIA, text: reply, entities: [mention(reply, '@anna_k')], reply_to_message: { message_id: 60 } });
  await tap(ANNA, 60);
  assert.equal(await collabs.countFor(3), 1);
});

test('«Уровни» down: the pair waits and goes with the evening retry', async () => {
  const world = createWorld();
  world.levelsDown = true;
  const text = '@anna_k #коллаборация';
  await deliver({ message_id: 70, from: MARIA, text, entities: [mention(text, '@anna_k')] });
  await tap(ANNA, 70);
  assert.equal(await collabs.countFor(3), 1, 'counted in the app even when «Уровни» are down');
  world.levelsDown = false;
  assert.deepEqual(await collabs.retrySync(), { pending: 1, sent: 1 });
  assert.deepEqual(await collabs.retrySync(), { pending: 0, sent: 0 });
  assert.equal(world.levels.length, 2);
});

test('before the «Уровни» key is set, confirmed pairs wait and go once it is there', async () => {
  const world = createWorld();
  const key = process.env.LEVELS_SYNC_SECRET;
  delete process.env.LEVELS_SYNC_SECRET;
  try {
    const text = '@anna_k #коллаборация';
    await deliver({ message_id: 80, from: MARIA, text, entities: [mention(text, '@anna_k')] });
    await tap(ANNA, 80);
    assert.equal(world.levels.length, 0);
    assert.deepEqual(await collabs.retrySync(), { pending: 1, sent: 0 });
  } finally { process.env.LEVELS_SYNC_SECRET = key; }
  assert.deepEqual(await collabs.retrySync(), { pending: 1, sent: 1 });
  assert.equal(world.levels.length, 1);
});
