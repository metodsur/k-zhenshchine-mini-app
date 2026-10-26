const { safeEqualString } = require("../../lib/telegram");
const { send } = require("../../lib/http");

// One function for all daily jobs (keeps the deployment within Vercel Hobby function limits).
const jobs = {
  // Evening job (18:00 Moscow): club renewal reminders, the end of gifted club weeks and, on Fridays, the weekly tasks summary.
  "club-reminders": async () => {
    const result = await require("../../lib/handlers/club-reminders").runReminders();
    try { result.pairs = await require("../../lib/pairs").runScheduled(); } catch (error) { console.error("Pairs failed", error.message); }
    try { result.club_gifts = await require("../../lib/referrals").runTrials(); } catch (error) { console.error("Club gifts failed", error.message); }
    try { result.nudges = await require("../../lib/nudges").runDaily(); } catch (error) { console.error("Nudges failed", error.message); }
    try { result.channel_posts = await require("../../lib/channel-posts").catchUp(); } catch (error) { console.error("Channel posts failed", error.message); }
    try { result.launch_dm = await require("../../lib/launch-message").run(); } catch (error) { console.error("Launch message failed", error.message); }
    try { result.tasks_summary = await require("../../lib/tasks").runWeeklySummary(); } catch (error) { console.error("Tasks summary failed", error.message); }
    return result;
  },
  // The morning job: meeting reminders, automatic follow-ups, review requests, checklists, weekly report, digest.
  "meeting-reminders": () => require("../../lib/morning").runMorning()
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
