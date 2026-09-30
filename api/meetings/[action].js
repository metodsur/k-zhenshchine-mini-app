const { send } = require("../../lib/http");

// One function for all meeting actions (keeps the deployment within Vercel Hobby function limits).
const actions = {
  invoice: require("../../lib/handlers/invoice"),
  waitlist: require("../../lib/handlers/waitlist"),
  "circle-request": require("../../lib/handlers/circle-request")
};

module.exports = async function handler(req, res) {
  const action = actions[String((req.query && req.query.action) || "")];
  if (!action) return send(res, 404, { ok: false });
  return action(req, res);
};
