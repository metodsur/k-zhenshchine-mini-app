const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CRON_SECRET = 'test-cron-secret';
const handler = require('../lib/handlers/club-reminders');
const cronRoute = require('../api/cron/[job]');

test('Tribute club subscription reminders are disabled', async () => {
  assert.deepEqual(await handler.runReminders(), { checked: 0, sent: 0, skipped: 0, failed: 0, disabled: true });
});

test('club reminder cron route remains protected and reports disabled status', async () => {
  const invoke = async (authorization) => {
    const res = { statusCode: 0, setHeader() {}, end(value) { this.body = value ? JSON.parse(value) : undefined; } };
    await cronRoute({ method: 'GET', query: { job: 'club-reminders' }, headers: authorization ? { authorization } : {} }, res);
    return res;
  };
  assert.equal((await invoke()).statusCode, 403);
  const result = await invoke('Bearer test-cron-secret');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.disabled, true);
  assert.deepEqual([result.body.checked, result.body.sent, result.body.skipped, result.body.failed], [0, 0, 0, 0]);
});
