// The two daily jobs that were Vercel crons, run inside the server on Timeweb.
// Each job runs once a day (claimed in storage, so a restart or a second copy of the
// server does not repeat it); if the server was down at the exact time, it catches up
// within the next three hours.
const store = require("./store");

const SCHEDULE = [
  { job: "meeting-reminders", hour: 6 }, // 09:00 Moscow
  { job: "club-reminders", hour: 15 } // 18:00 Moscow
];
const CATCH_UP_HOURS = 3;
const ranLocally = new Set(); // used only when storage is not configured

async function claim(key) {
  if (store.isConfigured()) return store.claimOnce(key, 2 * 24 * 3600);
  if (ranLocally.has(key)) return false;
  ranLocally.add(key);
  return true;
}

async function tick(now = new Date()) {
  const { jobs } = require("../api/cron/[job].js");
  const day = now.toISOString().slice(0, 10);
  const ran = [];
  for (const { job, hour } of SCHEDULE) {
    const h = now.getUTCHours();
    if (h < hour || h >= hour + CATCH_UP_HOURS) continue;
    if (!(await claim(`cron:run:${job}:${day}`))) continue;
    ran.push(job);
    try {
      const result = await jobs[job]();
      console.log(`Cron ${job}`, JSON.stringify(result));
    } catch (error) {
      console.error(`Cron ${job} failed`, error.message);
    }
  }
  return ran;
}

let timer = null;
function start() {
  if (timer || process.env.DISABLE_SCHEDULER) return;
  const run = () => tick().catch((error) => console.error("Scheduler failed", error.message));
  timer = setInterval(run, 60 * 1000);
  setTimeout(run, 15 * 1000);
}

module.exports = { start, tick, SCHEDULE };
