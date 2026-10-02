const { safeEqualString } = require("../../lib/telegram");
const { send } = require("../../lib/http");

// One function for all daily jobs (keeps the deployment within Vercel Hobby function limits).
const jobs = {
  "club-reminders": require("../../lib/handlers/club-reminders").runReminders,
  // The morning job also sends the team its end-of-week / end-of-month checklist reminder.
  "meeting-reminders": async () => {
    const result = await require("../../lib/handlers/meeting-reminders").runMeetingReminders();
    try { result.rhythm = await require("../../lib/os-rhythm").runReminders(); } catch (error) { console.error("Rhythm reminders failed", error.message); }
    return result;
  }
};

module.exports = async function handler(req, res) {
  const job = jobs[String((req.query && req.query.job) || "")];
  if (!job) return send(res, 404, { ok: false });
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqualString(req.headers.authorization, `Bearer ${secret}`)) return send(res, 403, { ok: false });
  try {
    const result = await job();
    console.log(`Cron ${req.query.job}`, JSON.stringify(result));
    return send(res, 200, { ok: true, ...result });
  } catch (error) {
    console.error(`Cron ${req.query.job} failed`, error.message);
    return send(res, 500, { ok: false });
  }
};
