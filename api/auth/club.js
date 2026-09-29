const { verifyInitData, isClubMember } = require("../../lib/telegram");

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });

  let user;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    user = verifyInitData(body.initData);
  } catch {
    return send(res, 401, { ok: false, error: "Invalid Telegram authorization" });
  }

  try {
    const member = await isClubMember(user.id);
    const clubUrl = String(process.env.TELEGRAM_CLUB_URL || "").trim();
    // The club invite link is only revealed to confirmed members.
    return send(res, 200, { ok: true, club_member: member, club_url: member && clubUrl ? clubUrl : null });
  } catch {
    return send(res, 503, { ok: false, error: "Club membership check unavailable" });
  }
};
