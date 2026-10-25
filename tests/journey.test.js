const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv({ TELEGRAM_CLUB_CHAT_ID: '-1004375885816', TELEGRAM_CLUB_URL: 'https://t.me/+club' });
const me = require('../api/auth/me');

const OLGA = { id: 4242, first_name: 'Ольга' };
const journey = async () => (await call(me, { method: 'POST', body: { initData: initData(OLGA) } })).body.journey;

test('a new woman starts at visibility with an empty path', async () => {
  createWorld();
  const j = await journey();
  assert.equal(j.current, 0);
  assert.deepEqual(j.stages.map((s) => s.reached), [false, false, false, false, false]);
  assert.deepEqual([j.meetings, j.women, j.invited, j.tasks_done, j.facets, j.days], [0, 0, 0, 0, 7, null]);
});

test('the path moves with what she has lived', async () => {
  const world = createWorld();
  world.members.add('4242'); // in the channel and in the club group
  world.kv.set('user:4242', JSON.stringify({ ritual_done_at: '2026-10-01T10:00:00.000Z' }));
  world.sets.set('pairs:met:4242', new Set(['1', '2', '3']));
  world.sets.set('ref:invited:4242', new Set(['7', '8']));
  world.kv.set('profile:4242', JSON.stringify({ facets: ['Женщина', 'Творец'], tasks: [{ id: 'a', text: 'Сайт', done: true }, { id: 'b', text: 'Цена', done: false }] }));
  const j = await journey();
  assert.equal(j.current, 2, 'club → «Наполнение»');
  assert.deepEqual(j.stages.map((s) => s.reached), [true, true, true, false, false]);
  assert.deepEqual([j.women, j.invited, j.tasks_done, j.facets], [3, 2, 1, 2]);
  assert.ok(j.days >= 1);
});
