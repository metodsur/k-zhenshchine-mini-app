const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv({ TELEGRAM_CLUB_CHAT_ID: '-1004375885816', TELEGRAM_CLUB_URL: 'https://t.me/+club', TRIBUTE_API_KEY: 'test-tribute' });
const webhook = require('../api/telegram/webhook');
const me = require('../api/auth/me');
const cron = require('../api/cron/[job]');
const referrals = require('../lib/referrals');
const tribute = require('../lib/tribute');

const DAY = 864e5;
const ANNA = { id: 501, first_name: 'Анна' };
const CHANNEL = { id: -1001, type: 'channel', username: 'test_channel' };
const myLink = async (user = ANNA) => (await call(me, { method: 'POST', body: { initData: initData(user), action: 'referral' } })).body;
const join = (userId, inviteName) => call(webhook, {
  method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
  body: { update_id: 1, chat_member: {
    chat: CHANNEL, from: { id: userId }, date: Math.floor(Date.now() / 1000),
    old_chat_member: { status: 'left', user: { id: userId } },
    new_chat_member: { status: 'member', user: { id: userId, first_name: 'Гостья' } },
    ...(inviteName ? { invite_link: { invite_link: 'https://t.me/+x', name: inviteName } } : {})
  } }
});
const evening = () => call(cron, { method: 'GET', query: { job: 'club-reminders' }, headers: { authorization: 'Bearer test-cron-secret' } });
const toAnna = (world) => world.sent('sendMessage').filter((m) => String(m.chat_id) === '501');

test('each woman gets one personal channel link, created once', async () => {
  const world = createWorld();
  const first = await myLink();
  assert.equal(first.ok, true);
  assert.match(first.referral.link, /^https:\/\/t\.me\/\+ref:501/);
  assert.deepEqual({ ...first.referral, link: undefined }, { link: undefined, count: 0, club_goal: 10, expert_goal: 20, trial: null });
  const again = await myLink();
  assert.equal(again.referral.link, first.referral.link);
  const created = world.sent('createChatInviteLink');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], { chat_id: '@test_channel', name: 'ref:501' });
});

test('only new women who came through her link are counted, once each', async () => {
  const world = createWorld();
  await join(601, 'ref:501');
  await join(601, 'ref:501'); // left and came back
  await join(501, 'ref:501'); // her own link
  await join(602, 'ref:999'); // someone else's link
  await join(603); // no link
  await join(604, 'Реклама в инстаграме'); // a team link
  world.members.add('605');
  await call(me, { method: 'POST', body: { initData: initData({ id: 605 }) } }); // already in the space, seen in the app
  await join(605, 'ref:501');
  assert.equal((await myLink()).referral.count, 1);
  assert.equal((await myLink({ id: 999 })).referral.count, 1);
  const notes = toAnna(world).filter((m) => /ещё одна женщина/.test(m.text));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /Уже 1 из 10/);
});

test('ten invited women open two weeks of the club; the gift ends without a subscription', async () => {
  const world = createWorld();
  world.tributeSubscribers = [];
  tribute.resetCache();
  for (let i = 1; i <= 10; i++) await join(700 + i, 'ref:501');
  const gift = world.sent('createChatInviteLink').find((p) => p.chat_id === '-1004375885816');
  assert.equal(gift.member_limit, 1);
  assert.equal(gift.name, 'gift:501');
  const giftNote = toAnna(world).find((m) => /две недели онлайн-клуба/.test(m.text));
  assert.ok(giftNote, 'she is told about the gift');
  assert.match(giftNote.reply_markup.inline_keyboard[0][0].url, /gift:501/);
  assert.ok(world.sent('sendMessage').some((m) => m.chat_id === '900' && /получила 2 недели клуба/.test(m.text)), 'the team is told');
  const status = (await myLink()).referral;
  assert.equal(status.count, 10);
  assert.equal(status.trial.ended, false);

  await join(711, 'ref:501'); // the 11th does not grant a second gift
  assert.equal(world.sent('createChatInviteLink').filter((p) => p.chat_id === '-1004375885816').length, 1);

  // Two days before the end: one reminder.
  assert.deepEqual(await referrals.runTrials(Date.now() + 12.5 * DAY), { reminded: 1, ended: 0, removed: 0 });
  assert.deepEqual(await referrals.runTrials(Date.now() + 13 * DAY), { reminded: 0, ended: 0, removed: 0 });
  // The end: removed from the club group (ban + unban, so she can come back by subscribing).
  assert.deepEqual(await referrals.runTrials(Date.now() + 14.1 * DAY), { reminded: 0, ended: 1, removed: 1 });
  assert.deepEqual(world.sent('banChatMember').map((p) => [p.chat_id, p.user_id]), [['-1004375885816', 501]]);
  assert.equal(world.sent('unbanChatMember')[0].only_if_banned, true);
  assert.deepEqual(await referrals.runTrials(Date.now() + 15 * DAY), { reminded: 0, ended: 0, removed: 0 });
  assert.equal((await myLink()).referral.trial.ended, true);
});

test('a woman who subscribed during the gift stays in the club', async () => {
  const world = createWorld();
  world.tributeSubscribers = [];
  tribute.resetCache();
  for (let i = 1; i <= 10; i++) await join(800 + i, 'ref:501');
  world.tributeSubscribers = [{ telegramUserId: 501, status: 'active', expireAt: new Date(Date.now() + 40 * DAY).toISOString() }];
  tribute.resetCache();
  assert.deepEqual(await referrals.runTrials(Date.now() + 14.1 * DAY), { reminded: 0, ended: 1, removed: 0 });
  assert.equal(world.sent('banChatMember').length, 0);
});

test('the evening job ends gifts too', async () => {
  createWorld();
  const r = await evening();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.club_gifts, { reminded: 0, ended: 0, removed: 0 });
});

test('twenty invited women make her a possible broadcast expert, announced once', async () => {
  const world = createWorld();
  world.tributeSubscribers = [];
  tribute.resetCache();
  for (let i = 1; i <= 21; i++) await join(900 + i + 1000, 'ref:501');
  const expert = toAnna(world).filter((m) => /экспертом в День эфиров/.test(m.text));
  assert.equal(expert.length, 1);
  assert.equal(world.sent('sendMessage').filter((m) => m.chat_id === '900' && /может стать экспертом/.test(m.text)).length, 1);
  assert.equal((await myLink()).referral.count, 21);
});
