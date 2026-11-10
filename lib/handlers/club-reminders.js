const { safeEqualString } = require("../telegram");

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// Tribute subscription reminders are intentionally disabled. YooKassa reminders are sent via
// the authenticated club-access API, which only accepts fixed server-owned reminder templates.
async function runReminders() {
  return { checked: 0, sent: 0, skipped: 0, failed: 0, disabled: true };
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqualString(req.headers.authorization, `Bearer ${secret}`)) return send(res, 403, { ok: false });
  return send(res, 200, { ok: true, ...await runReminders() });
};
module.exports.runReminders = runReminders;
