const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld, call } = require('./helpers/fake-world');

setupEnv();
const handler = require('../api/site/club-application');
const crm = require('../lib/crm');
const ORIGIN = 'https://towomen.ru';
const VERSION = '2026-10-26';
const form = {
  name: 'Анна', phone: '+7 (999) 123-45-67', username: '@anna_woman',
  consent: true, consent_version: VERSION
};
const submit = (body = form, headers = {}) => call(handler, {
  method: 'POST',
  headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.10', ...headers },
  body
});

test('website club form creates a CRM card and records the consent in its history', async () => {
  createWorld();
  const response = await submit();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });

  const cards = await crm.listCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, 'Анна');
  assert.equal(cards[0].phone, form.phone);
  assert.equal(cards[0].username, 'anna_woman');
  assert.equal(cards[0].source, 'Сайт');
  assert.deepEqual(cards[0].interests, ['club']);
  assert.equal(cards[0].tg_id, null);
  assert.ok(cards[0].history.some((event) => event.text.includes('Заявка на вступление в онлайн-клуб')));
  assert.ok(cards[0].history.some((event) => event.text.includes(`Согласие на обработку персональных данных через форму онлайн-клуба (редакция ${VERSION})`)));
});

test('website lead with an existing Telegram username updates the same CRM card', async () => {
  createWorld();
  await crm.touch({ id: 7001, first_name: 'Аня', username: 'anna_woman' }, { force: true, source: 'podcast', type: 'start' });
  const response = await submit({ ...form, name: 'Анна Петрова' });
  assert.equal(response.status, 200);

  const cards = await crm.listCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, 'Анна Петрова');
  assert.equal(cards[0].phone, form.phone);
  assert.equal(cards[0].tg_id, '7001');
  assert.equal(cards[0].source, 'Подкаст');
  assert.deepEqual(cards[0].interests, ['club']);
});

test('the endpoint rejects unapproved origins and missing or stale consent without storing data', async () => {
  createWorld();
  assert.equal((await submit({ ...form, consent: false })).status, 400);
  assert.equal((await submit({ ...form, consent_version: 'older' })).status, 400);
  assert.equal((await submit(form, { origin: 'https://example.org' })).status, 403);
  assert.equal((await crm.listCards()).length, 0);
});

test('the bot honeypot is accepted without creating a CRM card', async () => {
  createWorld();
  assert.equal((await submit({ ...form, website: 'spam' })).status, 200);
  assert.equal((await crm.listCards()).length, 0);
});

test('the public form is rate limited by client address', async () => {
  createWorld();
  for (let i = 0; i < 8; i += 1) {
    const response = await submit({ ...form, name: `Анна ${i}`, username: `anna_woman${i}` });
    assert.equal(response.status, 200);
  }
  assert.equal((await submit({ ...form, username: 'anna_woman9' })).status, 429);
  assert.equal((await crm.listCards()).length, 8);
});

test('CORS preflight is allowed only for the website origin', async () => {
  const res = {
    statusCode: 0, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; }
  };
  await handler({ method: 'OPTIONS', headers: { origin: ORIGIN } }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], ORIGIN);
  assert.equal(res.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
});
