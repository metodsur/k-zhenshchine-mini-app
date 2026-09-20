const { verifyInitData, isChannelMember } = require("../../lib/telegram");
function send(res, status, body) { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); }
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const user = verifyInitData(body.initData);
    const subscribed = await isChannelMember(user.id);
    return send(res, 200, { ok: true, subscribed, full_access: subscribed, entitlements: subscribed ? ["channel_member"] : [] });
  } catch { return send(res, 401, { ok: false, error: "Invalid Telegram authorization" }); }
};
