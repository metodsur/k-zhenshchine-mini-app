const { verifyInitData, isChannelMember, isClubMember } = require("../../lib/telegram");
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

  // Storage problems must never block access: at worst the start pages are shown again.
  let state = { rituals_seen: false, ritual_done: false };
  try {
    if (subscribed && body.mark === "rituals_seen") await store.markRitualsSeen(user.id);
    if (subscribed && body.mark === "ritual_done" && Number(await store.markRitualDone(user.id)) === 1) await stats.trackOnboarded(user.id);
    if (subscribed) state = await store.onboardingState(user.id);
  } catch { state = { rituals_seen: false, ritual_done: false }; }

  // Optional: pages with club buttons ask whether she is already in the paid club.
  let club;
  if (body.club) {
    let member = false;
    try { member = await isClubMember(user.id); } catch { member = false; }
    const url = String(process.env.TELEGRAM_CLUB_URL || "").trim();
    club = { member, url: member && url ? url : null };
  }

  return send(res, 200, {
    ok: true,
    ...(club ? { club } : {}),
    subscribed,
    full_access: subscribed,
    onboarded: state.ritual_done,
    rituals_seen: state.rituals_seen,
    entitlements: subscribed ? ["channel_member"] : []
  });
};
