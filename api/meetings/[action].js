const { send } = require("../../lib/http");

// One function for all meeting actions (keeps the deployment within Vercel Hobby function limits).
const actions = {
  invoice: require("../../lib/handlers/invoice"),
  waitlist: require("../../lib/handlers/waitlist"),
  "circle-request": require("../../lib/handlers/circle-request"),
  application: require("../../lib/handlers/application"),
  // Masters cabinet, «Зеркало» bookings and Master photos (lib/handlers/master.js).
  master: (req, res) => require("../../lib/handlers/master").masterAction(req, res),
  mirror: (req, res) => require("../../lib/handlers/master").mirrorAction(req, res),
  "master-photo": (req, res) => require("../../lib/handlers/master").photoAction(req, res)
};

module.exports = async function handler(req, res) {
  const action = actions[String((req.query && req.query.action) || "")];
  if (!action) return send(res, 404, { ok: false });
  return action(req, res);
};
