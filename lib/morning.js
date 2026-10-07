// Everything that runs every morning at 9:00 Moscow (one Vercel cron). Each part is independent:
// if one fails, the others still run. The digest goes last so it includes fresh automatic steps.
const steps = [
  ["meetings", () => require("./handlers/meeting-reminders").runMeetingReminders()],
  ["auto_followups", () => require("./crm-automation").runAutoFollowups()],
  ["reviews", () => require("./reviews").runReviewRequests()],
  ["training", () => require("./handlers/master").runTrainingReminders()],
  ["rhythm", () => require("./os-rhythm").runReminders()],
  ["weekly_report", () => require("./weekly-report").runWeeklyReport()],
  ["digest", () => require("./digest").runDigest()]
];

async function runMorning() {
  const result = {};
  for (const [name, run] of steps) {
    try { result[name] = await run(); } catch (error) { console.error(`Morning step ${name} failed`, error.message); result[name] = { error: true }; }
  }
  return result;
}

module.exports = { runMorning };
