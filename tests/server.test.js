const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupEnv, createWorld } = require('./helpers/fake-world');

setupEnv({});
process.env.DISABLE_SCHEDULER = '1';
const { handle, matchRoute } = require('../server');
const scheduler = require('../lib/scheduler');

function request(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: options.method || 'GET', headers: options.headers || {} }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('routes api functions like Vercel: exact files first, then [param] folders', () => {
  assert.match(matchRoute('/api/telegram/webhook').route.file, /webhook\.js$/);
  assert.deepEqual(matchRoute('/api/os/tasks').params, { section: 'tasks' });
  assert.deepEqual(matchRoute('/api/cron/club-reminders').params, { job: 'club-reminders' });
  assert.equal(matchRoute('/api/nothing/here'), null);
});

test('serves clean URLs, hides server files, supports ranges', async () => {
  const server = http.createServer(handle).listen(0);
  try {
    assert.equal((await request(server, '/space')).status, 200);
    const old = await request(server, '/space.html?x=1');
    assert.equal(old.status, 308); assert.equal(old.headers.location, '/space?x=1');
    assert.equal((await request(server, '/index.html')).headers.location, '/');
    for (const p of ['/lib/store.js', '/api', '/server.js', '/package.json', '/CLAUDE.md', '/.git/HEAD', '/tests/server.test.js']) {
      assert.equal((await request(server, p)).status, 404, p);
    }
    const part = await request(server, '/telegram-web-app.js', { headers: { Range: 'bytes=0-9' } });
    assert.equal(part.status, 206); assert.equal(part.body.length, 10);
    const cron = await request(server, '/api/cron/club-reminders', { method: 'POST' });
    assert.equal(cron.status, 403);
  } finally { server.close(); }
});

test('daily jobs run once in their window and catch up after a restart', async () => {
  createWorld();
  const { jobs } = require('../api/cron/[job].js');
  const calls = [];
  const saved = { ...jobs };
  jobs['meeting-reminders'] = async () => { calls.push('morning'); return {}; };
  jobs['club-reminders'] = async () => { calls.push('evening'); return {}; };
  try {
    assert.deepEqual(await scheduler.tick(new Date('2026-10-28T05:59:00Z')), []);
    assert.deepEqual(await scheduler.tick(new Date('2026-10-28T06:00:30Z')), ['meeting-reminders']);
    assert.deepEqual(await scheduler.tick(new Date('2026-10-28T06:01:30Z')), [], 'not twice a day');
    assert.deepEqual(await scheduler.tick(new Date('2026-10-28T16:40:00Z')), ['club-reminders'], 'late start still runs');
    assert.deepEqual(await scheduler.tick(new Date('2026-10-28T19:00:00Z')), []);
    assert.deepEqual(await scheduler.tick(new Date('2026-10-29T06:00:00Z')), ['meeting-reminders']);
    assert.deepEqual(calls, ['morning', 'evening', 'morning']);
  } finally { Object.assign(jobs, saved); }
});
