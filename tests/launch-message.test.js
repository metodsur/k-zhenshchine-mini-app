const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, createWorld } = require('./helpers/fake-world');

setupEnv({ QSTASH_TOKEN: 'q', TELEGRAM_REMINDER_SECRET: 'rs' });
const launch = require('../lib/launch-message');
const crm = require('../lib/crm');

const msk = (date, time) => Date.parse(`${date}T${time}:00+03:00`);

test('launch day: one message at 10:05 to every woman in the bot, never twice, not to those who sent /stop', async () => {
  const world = createWorld();
  await crm.touch({ id: 701, first_name: 'Анна' }, { force: true });
  await crm.touch({ id: 702, first_name: 'Мария' }, { force: true });
  await crm.setOptOut(702, true);

  assert.equal(await launch.schedule(msk('2026-10-26', '09:00')), null);
  assert.deepEqual(await launch.schedule(msk('2026-10-27', '09:00')), { scheduled_in_s: 3900 });
  assert.deepEqual(world.qstash.map((q) => q.body), [{ kind: 'launch_dm' }]);

  assert.deepEqual(await launch.run(msk('2026-10-27', '10:00')), { skipped: 'early' });
  assert.deepEqual(await launch.run(msk('2026-10-28', '10:00')), { skipped: 'not_launch_day' });
  const r = await launch.run(msk('2026-10-27', '10:05'));
  assert.equal(r.sent, 1);
  const [msg] = world.sent('sendMessage');
  assert.equal(String(msg.chat_id), '701');
  assert.match(msg.text, /^Мы начинаем историю «к Женщине» 🎉🤍\n\nАнна, мы так рады/);
  assert.equal(msg.reply_markup.inline_keyboard[0][0].url, 'https://t.me/test_channel');
  assert.ok(msg.reply_markup.inline_keyboard[1][0].web_app.url.endsWith('/rituals.html'));

  assert.equal((await launch.run(msk('2026-10-27', '18:00'))).sent, 0);
  assert.equal(world.sent('sendMessage').length, 1);
});
