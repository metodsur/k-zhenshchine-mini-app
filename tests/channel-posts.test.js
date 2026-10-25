const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, call } = require('./helpers/fake-world');

setupEnv({ QSTASH_TOKEN: 'q', TELEGRAM_REMINDER_SECRET: 'rs' });
const posts = require('../lib/channel-posts');
const collections = require('../lib/os-collections');
const webhook = require('../api/telegram/webhook');

// Moscow time → timestamp.
const msk = (date, time) => Date.parse(`${date}T${time}:00+03:00`);
const toChannel = (world) => world.sent('sendMessage').filter((m) => m.chat_id === '@test_channel');

test('launch day: three posts at their time, the first one pinned, the counter filled in, each once', async () => {
  const world = createWorld();
  world.memberCounts['@test_channel'] = 37;
  assert.deepEqual(await posts.publish('2026-10-27', '10:00', msk('2026-10-26', '10:00')), { skipped: 'not_today' });
  assert.deepEqual(await posts.publish('2026-10-27', '13:00', msk('2026-10-27', '10:00')), { skipped: 'early' });
  assert.deepEqual(await posts.publish('2026-10-27', '10:00', msk('2026-10-27', '10:00')), { sent: 'ritual' });
  assert.deepEqual(await posts.publish('2026-10-27', '10:00', msk('2026-10-27', '10:01')), { skipped: 'already_sent' });
  const [ritual] = toChannel(world);
  assert.match(ritual.text, /^📌 Начни отсюда/);
  assert.match(ritual.text, /Ты уже достаточна, чтобы быть здесь\.$/);
  assert.equal(ritual.reply_markup.inline_keyboard[0][0].url, 'https://t.me/K_zhenshcine_bot?start=go_ritual');
  assert.equal(world.sent('pinChatMessage').length, 1);
  assert.equal(world.sent('pinChatMessage')[0].chat_id, '@test_channel');
  assert.equal(typeof world.sent('pinChatMessage')[0].message_id, 'number');

  // The evening run sends what QStash did not deliver.
  const late = await posts.catchUp(msk('2026-10-27', '18:00'));
  assert.deepEqual(late['13:00'], { sent: 'rubrics' });
  assert.deepEqual(late['17:00'], { sent: 'explore' });
  const rubrics = toChannel(world)[1];
  assert.match(rubrics.text, /сейчас нас 37 🤍/);
  assert.equal(rubrics.reply_markup, undefined);
  assert.equal(toChannel(world).length, 3);
});

test('morning schedules today\'s posts for 10:00 / 13:00 / 17:00 Moscow; nothing before the launch', async () => {
  const world = createWorld();
  assert.deepEqual(await posts.schedule(msk('2026-10-26', '09:00')), []);
  const r = await posts.schedule(msk('2026-10-27', '09:00'));
  assert.deepEqual(r.map((x) => x.in_s), [3600, 4 * 3600, 8 * 3600]);
  assert.deepEqual(world.qstash.map((q) => q.body.slot), ['10:00', '13:00', '17:00']);
  assert.equal(world.qstash[0].body.kind, 'channel_post');
});

test('weekly grid: rotating video and feature, Saturday announcement, affirmations never repeat within a week', async () => {
  createWorld();
  const wed1 = await posts.build('2026-10-28', '10:00');
  const wed2 = await posts.build('2026-11-04', '10:00');
  assert.match(wed1.text, /первое видео .*«Как притягивать нужные ресурсы в любом объёме»/);
  assert.match(wed2.text, /второе видео .*«Нюансы создания желаемой реальности»/);
  assert.match((await posts.build('2026-11-09', '10:00')).text, /Фишка недели 📱 «Пригласи подруг»/);
  assert.match((await posts.build('2026-10-31', '10:00')).text, /Сегодня Варвара делится сакральными знаниями и практиками многомерности/);
  const sunday = await posts.build('2026-11-01', '13:00');
  assert.match(sunday.text, /^Хочешь выйти в эфир/);
  assert.match(sunday.text, /Со следующей недели каждый вторник/);
  assert.deepEqual(sunday.reply_markup.inline_keyboard.map((r) => r[0].url.split('go_')[1]), ['about', 'expert']);
  assert.match((await posts.build('2026-11-08', '13:00')).text, /\n\nКаждый вторник — День эфиров/);
  for (const monday of ['2026-11-02', '2026-11-09', '2026-11-16']) {
    const lines = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(Date.parse(`${monday}T12:00:00Z`) + d * 864e5).toISOString().slice(0, 10);
      for (const p of posts.plan(date)) lines.push(posts.AFFIRMATIONS[p.aff]);
    }
    assert.equal(lines.length, 9);
    assert.equal(new Set(lines).size, 9);
  }
});

test('Tuesday broadcasts come from the dashboard «Эксперты»; without experts no post, the team is told', async () => {
  const world = createWorld();
  assert.deepEqual(await posts.publish('2026-11-03', '10:00', msk('2026-11-03', '10:00')), { skipped: 'no_experts' });
  assert.equal(toChannel(world).length, 0);
  assert.match(world.sent('sendMessage').find((m) => m.chat_id === '900').text, /нет ни одного назначенного слота/);
  await collections.saveItem('experts', { title: 'Энергия женщины', name: 'Анна', stage: 'slot', air_date: '2026-11-10', air_time: '16:30' }, 't');
  await collections.saveItem('experts', { title: 'Опора', name: 'Мария', stage: 'slot', air_date: '2026-11-10', air_time: '16:00' }, 't');
  await collections.saveItem('experts', { title: 'Не сейчас', name: 'Ольга', stage: 'new', air_date: '2026-11-10', air_time: '17:00' }, 't');
  const tue = await posts.build('2026-11-10', '10:00');
  assert.match(tue.text, /Расписание 🕐\n16:00 — Мария, «Опора»\n16:30 — Анна, «Энергия женщины»\n/);
  assert.doesNotMatch(tue.text, /Ольга/);
});

test('a post button opens the right page of the app through the bot', async () => {
  const world = createWorld();
  world.members.add('7001');
  const res = await call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
    body: { message: { chat: { id: 7001, type: 'private' }, from: { id: 7001, first_name: 'Анна' }, text: '/start go_abundance' } } });
  assert.equal(res.status, 200);
  const reply = world.sent('sendMessage').find((m) => m.chat_id === 7001);
  assert.equal(reply.reply_markup.inline_keyboard[0][0].web_app.url, 'https://app.example.test/abundance.html');
});
