const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld } = require('./helpers/fake-world');

setupEnv({ TRIBUTE_API_KEY: 'test-tribute', QSTASH_TOKEN: 'q', TELEGRAM_REMINDER_SECRET: 'rs' });
const nudges = require('../lib/nudges');
const crm = require('../lib/crm');
const store = require('../lib/store');
const tribute = require('../lib/tribute');

// 11:00 Moscow = 08:00 UTC.
const MONDAY = Date.parse('2026-10-26T08:00:00Z');
const TUESDAY = Date.parse('2026-10-27T08:00:00Z');
const SUNDAY = Date.parse('2026-11-01T08:00:00Z');

async function women() {
  await crm.touch({ id: 701, first_name: 'Анна' }, { force: true });
  await crm.touch({ id: 702, first_name: 'Мария' }, { force: true });
  await crm.touch({ id: 703, first_name: 'Ольга' }, { force: true });
  await crm.setOptOut(703, true);
}
const to = (world, id) => world.sent('sendMessage').filter((m) => String(m.chat_id) === String(id));

test('one caring message a day by the weekly grid, never to those who sent /stop', async () => {
  const world = createWorld();
  world.memberCounts[process.env.TELEGRAM_CHANNEL_ID] = 37;
  await women();
  const r = await nudges.runDaily(MONDAY);
  assert.equal(r.sent, 2);
  const [anna] = to(world, 701);
  assert.match(anna.text, /Доброе утро, Анна/);
  assert.match(anna.text, /день видимости/);
  assert.match(anna.text, /Нас уже 37 из 100/);
  assert.match(anna.text, /\/stop/);
  assert.ok(anna.reply_markup.inline_keyboard[0][0].web_app.url.endsWith('/about.html'));
  assert.equal(to(world, 703).length, 0);

  // The same day again: nothing more.
  assert.deepEqual(await nudges.runDaily(MONDAY + 3600e3), { skipped: true });
  assert.equal(to(world, 701).length, 1);

  // Tuesday: broadcast day, no counter (no new ten reached).
  await nudges.runDaily(TUESDAY);
  const tue = to(world, 701)[1];
  assert.match(tue.text, /День эфиров/);
  assert.doesNotMatch(tue.text, /из 100/);
});

test('a new ten is announced once, any day; Sunday asks for the win of the week', async () => {
  const world = createWorld();
  await women();
  world.memberCounts[process.env.TELEGRAM_CHANNEL_ID] = 41;
  await nudges.runDaily(MONDAY);
  world.memberCounts[process.env.TELEGRAM_CHANNEL_ID] = 52;
  await nudges.runDaily(TUESDAY);
  assert.match(to(world, 701)[1].text, /🎉 Нас уже 52 из 100/);
  await nudges.runDaily(SUNDAY);
  const sun = to(world, 701)[2];
  assert.match(sun.text, /запиши свою победу/);
  assert.match(sun.text, /Нас уже 52 из 100/);
});

test('moving to a new stage replaces the ritual of the day with congratulations', async () => {
  const world = createWorld();
  await women();
  await nudges.runDaily(MONDAY); // baseline: nobody is congratulated on where she already is
  assert.ok(to(world, 701).every((m) => !/Поздравляем/.test(m.text)));

  await store.markRitualDone('701');
  world.tributeSubscribers = [{ telegramUserId: 702, status: 'active', expireAt: new Date(Date.now() + 864e6).toISOString() }];
  tribute.resetCache();
  const r = await nudges.runDaily(TUESDAY);
  assert.equal(r.stage, 2);
  assert.match(to(world, 701)[1].text, /этап «Целостность»/);
  assert.match(to(world, 702)[1].text, /Добро пожаловать в «Наполнение», Мария/);
  assert.equal(to(world, 702).length, 2);
});

test('the 9:00 morning run schedules the messages for 11:00; nothing goes out earlier', async () => {
  const world = createWorld();
  await women();
  const nine = Date.parse('2026-10-26T06:00:00Z');
  assert.deepEqual(await nudges.schedule(nine), { scheduled_in_s: 7200 });
  assert.deepEqual(world.qstash.map((q) => q.body), [{ kind: 'nudges' }]);
  assert.deepEqual(await nudges.runDaily(nine), { early: true });
  assert.equal(world.sent('sendMessage').length, 0);
});

test('if the 11:00 call never came, the evening run sends them with an evening greeting', async () => {
  const world = createWorld();
  await women();
  await nudges.runDaily(Date.parse('2026-10-26T15:00:00Z'));
  assert.match(to(world, 701)[0].text, /^Добрый вечер, Анна/);
  assert.deepEqual(await nudges.runDaily(Date.parse('2026-10-26T15:05:00Z')), { skipped: true });
});
