const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, initData, call } = require('./helpers/fake-world');

setupEnv({ TELEGRAM_CLUB_CHAT_ID: '-1004375885816', TELEGRAM_CLUB_URL: 'https://t.me/+club' });
const webhook = require('../api/telegram/webhook');
const scheduleApi = require('../api/schedule');
const adminRoute = require('../api/admin/[section]');
const access = require('../api/auth/access');

const OWNER = { id: 900, first_name: 'Варвара' };
const CLUB = { id: -1004375885816, type: 'supergroup' };
const deliver = (message) => call(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, body: { message } });
const admin = (section, extra = {}) => call(adminRoute, { method: 'POST', query: { section }, body: { initData: initData(OWNER), ...extra } });

test('club group messages feed the weekly summary; #коллаборация counts collaborations', async () => {
  createWorld();
  await deliver({ chat: CLUB, from: { id: 1 }, text: 'Всем привет!' });
  await deliver({ chat: CLUB, from: { id: 2 }, text: 'Договорились с Анной о съёмке #коллаборация' });
  await deliver({ chat: CLUB, from: { id: 2 }, caption: 'Наш проект #Коллаб', photo: [{}] });
  await deliver({ chat: CLUB, from: { id: 3, is_bot: true }, text: '#коллаборация от бота не считается' });
  await deliver({ chat: { id: -100999, type: 'supergroup' }, from: { id: 4 }, text: '#коллаборация в другой группе' });
  await deliver({ chat: { id: 5, type: 'private' }, from: { id: 5 }, text: '#коллаборация в личке' });

  const doc = (await admin('schedule')).body.schedule;
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  Object.assign(doc.cities[0].meetings['1'], { date: yesterday, time: '10:00' });
  Object.assign(doc.cities[1].meetings['2'], { date: yesterday, time: '10:00' });
  await admin('schedule', { action: 'save', schedule: doc });

  const { body } = await call(scheduleApi, { method: 'GET' });
  assert.deepEqual(body.club_stats, { collabs_total: 2, week: { collabs: 2, meetings: 2, women: 2, cities: 2 } });
});

test('new admin links reach the public schedule', async () => {
  createWorld();
  const saved = await admin('settings', { action: 'save', settings: {
    friendship_url: 'https://t.me/+friends', abundance_video_1: 'https://vkvideo.ru/video-1_2', accept_video_url: 'https://vkvideo.ru/video-3_4' } });
  assert.equal(saved.status, 200);
  assert.ok(saved.body.fields.friendship_url);
  const pub = await call(scheduleApi, { method: 'GET' });
  assert.equal(pub.body.links.friendship_url, 'https://t.me/+friends');
  assert.equal(pub.body.links.abundance_video_1, 'https://vkvideo.ru/video-1_2');
  assert.equal(pub.body.links.accept_video_url, 'https://vkvideo.ru/video-3_4');
  assert.equal(pub.body.links.materials_url, '');
});

test('access check tells club buttons whether she is already in the club', async () => {
  const world = createWorld();
  const ask = (club) => call(access, { method: 'POST', body: { initData: initData({ id: 77, first_name: 'Аня' }), club } });
  assert.equal((await ask()).body.club, undefined, 'only when asked');
  assert.deepEqual((await ask(true)).body.club, { member: false, url: null });
  world.members.add('77');
  assert.deepEqual((await ask(true)).body.club, { member: true, url: 'https://t.me/+club' });
});
