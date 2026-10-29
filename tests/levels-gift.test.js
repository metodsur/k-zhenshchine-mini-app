const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, call } = require('./helpers/fake-world');

setupEnv({ TELEGRAM_CLUB_CHAT_ID: '-1004375885816', TRIBUTE_API_KEY: 'test-tribute', LEVELS_URL: 'https://levels.example.test', LEVELS_SYNC_SECRET: 'levels-secret' });
const webhook = require('../api/telegram/webhook');
const gift = require('../lib/levels-gift');
const referrals = require('../lib/referrals');
const tribute = require('../lib/tribute');

const DAY = 864e5;
const MEMBER = 'cmh1abcde0000xyz12345678';
const OLGA = { id: 701, first_name: 'Ольга' };
const start = (from, param) => call(webhook, {
  method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
  body: { update_id: 1, message: { message_id: 1, chat: { id: from.id, type: 'private' }, from, text: `/start ${param}` } }
});
const param = (id = MEMBER) => `yr_${id}_${gift.signature(id, 'levels-secret')}`;
const to = (world, id) => world.sent('sendMessage').filter((m) => String(m.chat_id) === String(id));

test('the signature is the same as on «Уровни» and cannot be made up', () => {
  // Same HMAC as src/lib/club-gift.ts on the platform
  assert.equal(gift.verify(param()), MEMBER);
  assert.equal(gift.verify(param(), 'other'), null);
  assert.equal(gift.verify(`yr_${MEMBER}_0000000000000000`), null);
  assert.equal(gift.verify('go_space'), null);
});

test('a platform member gets a one-person club link for 7 days; «Уровни» learn until when; then she is removed', async () => {
  const world = createWorld();
  world.tributeSubscribers = [];
  tribute.resetCache();
  await start(OLGA, param());
  const link = world.sent('createChatInviteLink').find((p) => p.chat_id === '-1004375885816');
  assert.equal(link.member_limit, 1);
  assert.equal(link.name, 'levels:701');
  const note = to(world, 701).find((m) => /Неделя клуба «Наполнение» в подарок/.test(m.text));
  assert.ok(note, 'she is told');
  assert.equal(note.reply_markup.inline_keyboard[0][0].text, 'Войти в клуб 🌸');
  assert.ok(world.sent('sendMessage').some((m) => m.chat_id === '900' && /платформы «Уровни»/.test(m.text)), 'the team is told');
  assert.equal(world.levels.length, 1);
  assert.equal(world.levels[0].url, 'https://levels.example.test/api/club-gift');
  assert.equal(world.levels[0].body.userId, MEMBER);
  const until = Date.parse(world.levels[0].body.until);
  assert.ok(until >= Date.now() + 7 * DAY - 60_000);

  // Again: the same link, no second gift
  await start(OLGA, param());
  assert.equal(world.sent('createChatInviteLink').filter((p) => p.chat_id === '-1004375885816').length, 1);
  assert.match(to(world, 701).at(-1).text, /уже ждёт тебя/);

  const days = (until - Date.now()) / DAY;
  assert.deepEqual(await referrals.runTrials(Date.now() + (days - 1.5) * DAY), { reminded: 1, ended: 0, removed: 0 });
  assert.match(to(world, 701).at(-1).text, /Твоя неделя клуба «к Женщине» в подарок закончится/);
  assert.deepEqual(await referrals.runTrials(until + 3_600_000), { reminded: 0, ended: 1, removed: 1 });
  assert.match(to(world, 701).at(-1).text, /Неделя клуба «к Женщине» в подарок закончилась/);

  await start(OLGA, param());
  assert.match(to(world, 701).at(-1).text, /уже была у тебя/);
});

test('one gift per platform member: another Telegram account cannot take it', async () => {
  const world = createWorld();
  world.tributeSubscribers = [];
  tribute.resetCache();
  const other = 'cmh1zzzzz0000xyz12345678';
  await start({ id: 702, first_name: 'Ира' }, param(other));
  await start({ id: 703, first_name: 'Не Ира' }, param(other));
  assert.match(to(world, 703).at(-1).text, /с другого аккаунта/);
  assert.equal(world.sent('createChatInviteLink').filter((p) => p.name === 'levels:703').length, 0);
});

test('a wrong link gives no gift', async () => {
  const world = createWorld();
  await start({ id: 704 }, `yr_${MEMBER}_ffffffffffffffff`);
  assert.match(to(world, 704).at(-1).text, /не сработала/);
  assert.equal(world.sent('createChatInviteLink').length, 0);
});

test('she already pays: the team extends the subscription; «Уровни» down — retried in the evening', async () => {
  const world = createWorld();
  world.tributeSubscribers = [{ telegramUserId: 705, status: 'active', expireAt: new Date(Date.now() + 40 * DAY).toISOString() }];
  tribute.resetCache();
  world.levelsDown = true;
  const id = 'cmh1yyyyy0000xyz12345678';
  await start({ id: 705, first_name: 'Света' }, param(id));
  assert.match(to(world, 705).at(-1).text, /продлим твою подписку на 7 дней/);
  assert.ok(world.sent('sendMessage').some((m) => m.chat_id === '900' && /продлите ей подписку в Tribute на 7 дней/.test(m.text)));
  assert.equal(world.sent('createChatInviteLink').filter((p) => p.name === 'levels:705').length, 0);
  world.levelsDown = false;
  assert.deepEqual(await gift.retrySync(), { pending: 1, sent: 1 });
  assert.equal(world.levels.at(-1).body.userId, id);
});
