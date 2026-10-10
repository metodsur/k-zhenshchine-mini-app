const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv({ QSTASH_TOKEN: 'q', TELEGRAM_REMINDER_SECRET: 'rs' });
const me = require('../api/auth/me');
const webhook = require('../api/telegram/webhook');
const reminder = require('../api/telegram/reminder');
const pairs = require('../lib/pairs');
const tribute = require('../lib/tribute');

const W = (id, first_name, extra = {}) => ({ id, first_name, username: `u${id}`, ...extra });
const ANNA = W(201, 'Анна'), BELLA = W(202, 'Белла'), VERA = W(203, 'Вера'), GALA = W(204, 'Гала'), DINA = W(205, 'Дина');
const app = (u, body) => call(me, { method: 'POST', body: { initData: initData(u), action: 'pairs', ...body } });
const deliver = (update) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: update });
const press = (u, data) => deliver({ callback_query: { id: 'cb' + Math.random(), from: u, data, message: { chat: { id: u.id }, message_id: 1 } } });

function club(world, users) {
  tribute.resetCache();
  process.env.TRIBUTE_API_KEY = 'k';
  world.tributeSubscribers = users.map((u) => ({ telegramUserId: u.id, status: 'active', activatedAt: '2026-01-01T00:00:00Z', expireAt: '2027-01-01T00:00:00Z' }));
}

test('pairs: matching prefers new partners, then resources, city and newcomer + experienced', () => {
  const e = (id, extra) => ({ id, resources: [], words: [], city: '', rounds_before: 2, ...extra });
  const met = { a: new Set(['b']), b: new Set(['a']), c: new Set(), d: new Set() };
  const { pairs: p } = pairs.matchEntries([e('a', { resources: ['Идеи'] }), e('b', { resources: ['Идеи'] }), e('c', {}), e('d', {})], met, () => 0);
  assert.ok(!p.some(([x, y]) => [x, y].sort().join() === 'a,b'), 'never the same pair again when avoidable');
  const s1 = pairs.score(e('x', { city: 'Москва' }), e('y', { city: 'москва' }), new Set());
  const s2 = pairs.score(e('x', { city: 'Москва' }), e('y', { city: 'Казань' }), new Set());
  const s3 = pairs.score(e('x', { city: 'Москва' }), e('y', { city: 'Новосибирск' }), new Set());
  assert.ok(s1 > s2 && s2 > s3, 'same city > same time zone > far away');
  const fresh = e('n', { rounds_before: 0, club_since: new Date().toISOString() });
  const old = e('o', { rounds_before: 5 });
  assert.ok(pairs.score(fresh, old, new Set()) > pairs.score(fresh, e('n2', { rounds_before: 0, club_since: new Date().toISOString() }), new Set()));
  assert.deepEqual(pairs.taskWords([{ text: 'Запустить продажи курса', done: false }, { text: 'Старое', done: true }]), ['запус', 'прода', 'курса']);
});

test('pairs: round opens after the call, self choice via invite, auto match with a three, done marks', async () => {
  const world = createWorld();
  club(world, [ANNA, BELLA, VERA, GALA, DINA]);
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  assert.equal((await pairs.saveConfig({ enabled: true, first_date: today, time: '00:00', duration_min: 15, every_weeks: 2, ritual_url: 'https://t.me/ritual' })).status, 200);

  // Cron after the call → round open, members invited, match scheduled.
  const run = await pairs.runScheduled(Date.now());
  assert.equal(run.opened, 1);
  const invites = world.sent('sendMessage').filter((m) => /ритуал в паре/.test(m.text));
  assert.equal(invites.length, 5);
  assert.equal(invites[0].reply_markup.inline_keyboard[0][0].callback_data, `p:j:${today}`);
  assert.ok(world.qstash.some((q) => q.body.kind === 'pairs' && q.body.step === 'match'));
  assert.equal((await pairs.runScheduled(Date.now())).opened, 0, 'opens once');

  // Not a club member → refused.
  assert.equal((await app(W(299, 'Чужая'), { op: 'join', mode: 'auto' })).status, 403);

  // Анна and Белла choose each other; the rest ask us.
  let r = await app(ANNA, { op: 'join', mode: 'self', city: 'Москва' });
  assert.equal(r.body.round.joined, true);
  await app(BELLA, { op: 'join', mode: 'self', city: 'Казань' });
  r = await app(ANNA, { op: 'state' });
  assert.deepEqual(r.body.round.available.map((x) => x.name), ['Белла']);
  assert.equal(r.body.city, 'Москва', 'city remembered');
  r = await app(ANNA, { op: 'invite', to: BELLA.id });
  assert.deepEqual(r.body.round.outgoing, [String(BELLA.id)]);
  const inv = world.sent('sendMessage').filter((m) => m.chat_id === String(BELLA.id)).pop();
  assert.match(inv.text, /Анна \(Москва\) приглашает/);
  await press(BELLA, inv.reply_markup.inline_keyboard[0][0].callback_data);
  r = await app(ANNA, { op: 'state' });
  assert.equal(r.body.round.pair.partners[0].name, 'Белла');
  assert.equal(r.body.round.pair.partners[0].contact_url, 'https://t.me/u202');
  const pairMsg = world.sent('sendMessage').filter((m) => m.chat_id === String(ANNA.id)).pop();
  assert.match(pairMsg.text, /Ваша пара на ритуал — Белла \(Казань\)/);
  assert.ok(pairMsg.reply_markup.inline_keyboard.flat().some((b) => b.url === 'https://t.me/ritual'));

  for (const u of [VERA, GALA]) await press(u, `p:j:${today}`);
  await app(DINA, { op: 'join', mode: 'auto', city: 'Новосибирск' });

  // Delayed call: automatic matching; 3 left → pair + one joins as a three.
  const res = { statusCode: 0, setHeader() {}, end(v) { this.out = JSON.parse(v); } };
  await reminder({ method: 'POST', headers: { 'x-reminder-secret': 'rs' }, body: { kind: 'pairs', step: 'match', round: today } }, res);
  assert.equal(res.statusCode, 200);
  const st = await pairs.roundDetails(today);
  assert.equal(st.waiting.length, 0);
  assert.deepEqual(st.pairs.map((p) => p.members.length).sort(), [2, 3]);
  assert.ok(st.pairs.some((p) => p.by === 'self'));

  // Done mark from the bot; partner gets a thank-you.
  await press(ANNA, `p:d:${today}`);
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === String(BELLA.id)).pop().text, /Анна отметила ритуал пройденным/);
  assert.equal((await pairs.roundDetails(today)).pairs.find((p) => p.by === 'self').members.find((m) => m.name === 'Анна').done, true);

  // Month counter.
  assert.equal((await app(ANNA, { op: 'state' })).body.month_count, 1);
  const vera = (await app(VERA, { op: 'state' })).body;
  assert.equal(vera.round.pair.partners.length, 2, 'Вера is in the three');
});

test('pairs: next round avoids last partners; team can unpair and pair manually', async () => {
  const world = createWorld();
  club(world, [ANNA, BELLA, VERA, GALA]);
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  await pairs.saveConfig({ enabled: true, first_date: today, time: '00:00', duration_min: 15 });
  // First round, manual opening from the dashboard.
  await pairs.openRound('2026-01-01', { manual: true });
  for (const u of [ANNA, BELLA, VERA, GALA]) await pairs.join('2026-01-01', u, { mode: 'auto' });
  await pairs.match('2026-01-01');
  const first = (await pairs.roundDetails('2026-01-01')).pairs.map((p) => p.members.map((m) => m.id).sort().join());
  // Second round: nobody gets a partner from the first round.
  await pairs.openRound('2026-01-15', { manual: true });
  for (const u of [ANNA, BELLA, VERA, GALA]) await pairs.join('2026-01-15', u, { mode: 'auto' });
  await pairs.match('2026-01-15');
  const second = (await pairs.roundDetails('2026-01-15')).pairs.map((p) => p.members.map((m) => m.id).sort().join());
  assert.equal(second.length, 2);
  assert.ok(second.every((p) => !first.includes(p)), `${first} vs ${second}`);
  // Team: unpair and re-pair.
  const d = await pairs.roundDetails('2026-01-15');
  assert.equal((await pairs.unpair('2026-01-15', d.pairs[0].id)).status, 200);
  const freed = d.pairs[0].members.map((m) => m.id);
  assert.equal((await pairs.roundDetails('2026-01-15')).waiting.length, 2);
  assert.equal((await pairs.pairManually('2026-01-15', freed[0], freed[1])).status, 200);
  assert.equal((await pairs.pairManually('2026-01-15', freed[0], d.pairs[1].members[0].id)).status, 409);
});

test('pairs: test round invites only the team, matches in 10 minutes and can be deleted without a trace', async () => {
  const world = createWorld();
  club(world, [ANNA, BELLA]);
  const adminRoute = require('../api/admin/[section]');
  await call(adminRoute, { method: 'POST', query: { section: 'team' }, body: { initData: initData({ id: 900, first_name: 'Варвара' }), action: 'save', members: [{ id: '5101', name: 'Анастасия', role: 'director' }] } });
  const id = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10) + 't';
  const r = await pairs.openRound(id, { manual: true, test: true });
  assert.equal(r.sent, 2, 'owner + director only');
  const inv = world.sent('sendMessage').filter((m) => /Тестовый раунд/.test(m.text));
  assert.deepEqual(inv.map((m) => String(m.chat_id)).sort(), ['5101', '900']);
  assert.equal(inv[0].reply_markup.inline_keyboard[0][0].callback_data, `p:j:${id}`);
  assert.ok(world.qstash.some((q) => q.body.round === id && q.headers['Upstash-Delay'] === '600s'));
  const VARVARA = W(900, 'Варвара'), NASTYA = W(5101, 'Анастасия');
  await press(VARVARA, `p:j:${id}`);
  await press(NASTYA, `p:j:${id}`);
  const res = { statusCode: 0, setHeader() {}, end() {} };
  await reminder({ method: 'POST', headers: { 'x-reminder-secret': 'rs' }, body: { kind: 'pairs', step: 'match', round: id } }, res);
  assert.equal((await pairs.roundDetails(id)).pairs.length, 1);
  assert.match(world.sent('sendMessage').filter((m) => m.chat_id === '900').pop().text, /Ваша пара на ритуал — Анастасия/);
  await press(VARVARA, `p:d:${id}`);
  assert.equal((await app(VARVARA, { op: 'state' })).body.month_count, 1);
  assert.equal((await pairs.deleteTestRound(id)).status, 200);
  const after = (await app(VARVARA, { op: 'state' })).body;
  assert.equal(after.month_count, 0);
  assert.equal(after.total_count, 0);
  assert.equal(after.round, null);
  assert.equal((await pairs.listRounds()).length, 0);
  assert.equal((await pairs.deleteTestRound('2026-01-01')).status, 400, 'real rounds cannot be deleted');
});
