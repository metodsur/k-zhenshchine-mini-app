const schedule = require("../lib/schedule");
const { send } = require("../lib/http");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { ok: false });
  try {
    const doc = await schedule.loadSchedule();
    const counts = await schedule.soldCounts(doc);
    return send(res, 200, { ok: true, ...schedule.publicView(doc, counts) });
  } catch (error) {
    console.error("Schedule read failed", error.message);
    // Storage outage: still show the meetings, all as "date coming soon".
    return send(res, 200, { ok: true, degraded: true, ...schedule.publicView(schedule.defaultSchedule(), {}) });
  }
};
