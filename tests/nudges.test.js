const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld } = require('./helpers/fake-world');

setupEnv({ TRIBUTE_API_KEY: 'test-tribute', QSTASH_TOKEN: 'q', TELEGRAM_REMINDER_SECRET: 'rs' });
const nudges = require('../lib/nudges');
const crm = require('../lib/crm');
const store = require('../lib/store');
const tribute = require('../lib/tribute');

// 11:00 Moscow = 08:00 UTC.
const MONDAY = Date.parse('2026-11-02T08:00:00Z');
const TUESDAY = Date.parse('2026-11-03T08:00:00Z');
const SUNDAY = Date.parse('2026-11-08T08:00:00Z');

async function women() {
  await crm.touch({ id: 701, first_name: 'Анна' }, { force: true });
  await crm.touch({ id: 702, first_name: 'Мария' }, { force: true });
  await crm.touch({ id: 703, first_name: 'Ольга' }, { force: true });
  await crm.setOptOut(703, true);
}
const to = (world, id) => world.sent('sendMessage').filter((m) => String(m.chat_id) === String(id));

test('no daily rituals in private messages: a usual weekday sends nothing', async () => {
  const world = createWorld();
  await women();
  const r = await nudges.runDaily(MONDAY);
  assert.equal(r.recipients, 2);
  assert.equal(r.sent, 0);
  assert.equal(world.sent('sendMessage').length, 0);
});

test('Sunday asks her to write down the win of the week, never to those who sent /stop', async () => {
  const world = createWorld();
  await women();
  await nudges.runDaily(SUNDAY);
  const [anna] = to(world, 701);
  assert.match(anna.text, /Анна, что получилось у тебя на этой неделе/);
  assert.match(anna.text, /\/stop/);
  assert.ok(anna.reply_markup.inline_keyboard[0][0].web_app.url.endsWith('/about.html'));
  assert.equal(to(world, 703).length, 0);
  assert.deepEqual(await nudges.runDaily(SUNDAY + 3600e3), { skipped: true });
});

test('moving to a new stage brings congratulations', async () => {
  const world = createWorld();
  await women();
  await nudges.runDaily(MONDAY); // baseline: nobody is congratulated on where she already is
  assert.equal(world.sent('sendMessage').length, 0);
  await store.markRitualDone('701');
  world.tributeSubscribers = [{ telegramUserId: 702, status: 'active', expireAt: new Date(Date.now() + 864e6).toISOString() }];
  tribute.resetCache();
  const r = await nudges.runDaily(TUESDAY);
  assert.equal(r.stage, 2);
  assert.match(to(world, 701)[0].text, /этап «Целостность»/);
  assert.match(to(world, 702)[0].text, /Добро пожаловать в «Наполнение», Мария/);
});

test('scheduled for 11:00 Moscow; nothing earlier and nothing before the launch on 27 October', async () => {
  const world = createWorld();
  await women();
  const nine = Date.parse('2026-11-08T06:00:00Z');
  assert.deepEqual(await nudges.schedule(nine), { scheduled_in_s: 7200 });
  assert.deepEqual(world.qstash.map((q) => q.body), [{ kind: 'nudges' }]);
  assert.deepEqual(await nudges.runDaily(nine), { early: true });
  assert.deepEqual(await nudges.runDaily(Date.parse('2026-10-26T08:00:00Z')), { before_launch: true });
  assert.equal(world.sent('sendMessage').length, 0);
});
