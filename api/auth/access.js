const { verifyInitData, isChannelMember } = require("../../lib/telegram");
const store = require("../../lib/store");
const stats = require("../../lib/stats");

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });

  let body;
  let user;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    user = verifyInitData(body.initData);
  } catch {
    return send(res, 401, { ok: false, error: "Invalid Telegram authorization" });
  }

  await stats.trackAppUser(user.id);
  let subscribed;
  try {
    subscribed = await isChannelMember(user.id);
  } catch {
    return send(res, 503, { ok: false, error: "Membership check unavailable" });
  }

  // Storage problems must never block access: they only mean the start pages are shown again.
  let onboarded = false;
  try {
    if (subscribed && body.mark === "onboarded") {
      if (Number(await store.markOnboarded(user.id)) === 1) await stats.trackOnboarded(user.id);
      onboarded = true;
    }
    else if (subscribed) onboarded = await store.isOnboarded(user.id);
  } catch { onboarded = false; }

  return send(res, 200, {
    ok: true,
    subscribed,
    full_access: subscribed,
    onboarded,
    entitlements: subscribed ? ["channel_member"] : []
  });
};
