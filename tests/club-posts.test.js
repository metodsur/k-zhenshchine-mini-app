const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, call } = require('./helpers/fake-world');

setupEnv({ TELEGRAM_CLUB_CHAT_ID: '-1004375885816', TELEGRAM_REMINDER_SECRET: 'rem-secret', QSTASH_TOKEN: 'q' });
const posts = require('../lib/club-posts');
const webhook = require('../api/telegram/webhook');

const CLUB = { id: -1004375885816, type: 'supergroup' };
const at = (date, time) => Date.parse(`${date}T${time}:00+03:00`);
const toClub = (world) => world.sent('sendMessage').filter((m) => String(m.chat_id) === '-1004375885816');

test('the plan: ritual at 10:00 and «Волшебство дня» at 20:00; networking every 2nd Thursday from 05.11', async () => {
  createWorld();
  assert.deepEqual(await posts.plan('2026-11-01'), [], 'nothing before the club grid starts');
  assert.deepEqual((await posts.plan('2026-11-02')).map((p) => p.post), ['ritual', 'magic']);
  assert.deepEqual((await posts.plan('2026-11-04')).map((p) => `${p.slot} ${p.post}`), ['10:00 ritual', '17:00 announce', '20:00 magic']);
  assert.deepEqual((await posts.plan('2026-11-05')).map((p) => `${p.slot} ${p.post}`), ['10:00 report', '10:05 experts', '11:50 call_soon', '20:00 magic']);
  assert.deepEqual((await posts.plan('2026-11-12')).map((p) => p.post), ['ritual', 'magic'], 'the week between networkings');
  assert.equal((await posts.plan('2026-11-19'))[0].post, 'report');
});

test('every week of a 4-week round has its own text; then it repeats', async () => {
  createWorld();
  const monday = async (date) => (await posts.build(date, '10:00')).texts[0].split('\n\n🤍')[0].slice(0, 60);
  const weeks = await Promise.all(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'].map(monday));
  assert.equal(new Set(weeks.slice(0, 4)).size, 4);
  assert.equal(weeks[4], weeks[0]);
  const wed = (await posts.build('2026-11-11', '10:00')).texts[0];
  assert.match(wed, /День коллабораций/);
  assert.match(wed, /«Мои ресурсы»/);
  assert.match(wed, /10 подруг/);
});

test('posts go to the club group once and never early; the welcome is pinned once', async () => {
  const world = createWorld();
  assert.deepEqual(await posts.publish('2026-11-02', '10:00', at('2026-11-02', '09:59')), { skipped: 'early' });
  assert.equal((await posts.publish('2026-11-02', '10:00', at('2026-11-02', '10:00'))).sent, 'ritual');
  assert.deepEqual(await posts.publish('2026-11-02', '10:00', at('2026-11-02', '10:01')), { skipped: 'already_sent' });
  assert.match(toClub(world)[0].text, /Я говорю ДА/);

  assert.deepEqual(await posts.schedule(at('2026-10-28', '09:00')), []);
  assert.equal(world.sent('pinChatMessage').length, 0, 'no pin before the club starts');
  await posts.schedule(at('2026-11-02', '09:00'));
  await posts.schedule(at('2026-11-03', '09:00'));
  assert.equal(toClub(world).filter((m) => /Добро пожаловать в клуб «Наполнение»/.test(m.text)).length, 1);
  assert.equal(world.sent('pinChatMessage').length, 1);
  assert.deepEqual(world.qstash.filter((q) => q.body.kind === 'club_post').map((q) => q.body.slot), ['10:00', '20:00', '10:00', '20:00']);
});

test('networking day: the two-week results count collaborations, new members and new experts', async () => {
  const world = createWorld();
  const now = at('2026-11-05', '10:00');
  world.kv.set('stats:club:collabs:2026-11-04', '2');
  world.kv.set('stats:club:collabs:2026-10-20', '5');
  await posts.onJoin({ id: 11, first_name: 'Аня' }, now - 3 * 864e5);
  await posts.onJoin({ id: 12, first_name: 'Оля' }, now - 864e5);
  await posts.onJoin({ id: 11, first_name: 'Аня' }, now - 864e5);
  world.kv.set('os:col:experts', JSON.stringify([
    { id: 'a', name: 'Мария', title: 'Деньги и женственность', invited: 23, levels_url: 'https://yrovni.ru/u/1', stage: 'slot', updated_at: new Date(now - 864e5).toISOString() },
    { id: 'b', name: 'Старая', title: 'x', stage: 'done', updated_at: new Date(now - 30 * 864e5).toISOString() },
    { id: 'c', name: 'Новая анкета', title: 'y', stage: 'new', updated_at: new Date(now).toISOString() }
  ]));
  await posts.publish('2026-11-05', '10:00', now);
  await posts.publish('2026-11-05', '10:05', now + 5 * 60e3);
  const sent = toClub(world).map((m) => m.text);
  const welcomes = sent.filter((t) => /добро пожаловать в клуб/.test(t));
  assert.equal(welcomes.length, 2, 'each new member is welcomed once');
  const report = sent.find((t) => t.startsWith('Итоги двух недель'));
  assert.match(report, /Коллабораций: 2\n/);
  assert.match(report, /Новых участниц клуба: 2\n/);
  assert.match(report, /Новых экспертов пространства: 1\n/);
  assert.match(report, /ссылка придёт перед стартом/);
  const expert = sent.find((t) => t.startsWith('Знакомьтесь: Мария'));
  assert.match(expert, /23 женщин/);
  assert.match(expert, /yrovni\.ru\/u\/1/);
});

test('a new club member arriving by chat_member update is welcomed in the group from the club start', async () => {
  const world = createWorld();
  const join = (id, name) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: { chat_member: { chat: CLUB, date: 1, old_chat_member: { status: 'left', user: { id } }, new_chat_member: { status: 'member', user: { id, first_name: name } } } } });
  const realNow = Date.now;
  try {
    Date.now = () => at('2026-10-30', '12:00');
    await join(20, 'Ира');
    assert.equal(toClub(world).length, 0, 'no welcome before the club starts');
    Date.now = () => at('2026-11-02', '12:00');
    await join(21, 'Вера');
  } finally { Date.now = realNow; }
  assert.match(toClub(world).at(-1).text, /^Вера, добро пожаловать в клуб «Наполнение»/);
});

test('replies to «Волшебство дня» are counted for Sunday', async () => {
  const world = createWorld();
  await posts.publish('2026-11-07', '20:00', at('2026-11-07', '20:00'));
  const magicId = 100 + world.telegramCalls.length;
  const deliver = (message) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: { message: { chat: CLUB, ...message } } });
  await deliver({ from: { id: 1 }, text: 'Сегодня подписала договор!', reply_to_message: { message_id: magicId } });
  await deliver({ from: { id: 2 }, text: 'Просто привет' });
  await deliver({ from: { id: 3 }, text: 'Встретила подругу детства #волшебстводня' });
  const sunday = (await posts.build('2026-11-08', '20:00', Date.now())).texts[0];
  assert.match(sunday, /было 2 историй волшебства/);
});
