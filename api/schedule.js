const schedule = require("../lib/schedule");
const events = require("../lib/events");
const settings = require("../lib/settings");
const clubActivity = require("../lib/club-activity");
const { send } = require("../lib/http");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { ok: false });
  try {
    const doc = await schedule.loadSchedule();
    const counts = await schedule.soldCounts(doc);
    let clubEvents = [];
    try { clubEvents = events.upcoming(await events.loadEvents()); } catch { clubEvents = []; }
    let links = {};
    try { links = await settings.loadSettings(); } catch { /* buttons show "скоро" */ }
    let clubStats = null;
    try { clubStats = await clubActivity.summary(); } catch { clubStats = null; }
    return send(res, 200, { ok: true, ...schedule.publicView(doc, counts), events: clubEvents, links, club_stats: clubStats });
  } catch (error) {
    console.error("Schedule read failed", error.message);
    // Storage outage: still show the meetings, all as "date coming soon".
    return send(res, 200, { ok: true, degraded: true, ...schedule.publicView(schedule.defaultSchedule(), {}), events: [], links: {} });
  }
};
