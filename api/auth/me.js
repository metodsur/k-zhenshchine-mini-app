const { verifyInitData, isChannelMember, isClubMember } = require("../../lib/telegram");
const store = require("../../lib/store");
const tribute = require("../../lib/tribute");

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// Each source is optional: a failure in one must not hide the others.
async function safely(task) {
  try { return await task(); } catch { return undefined; }
}

async function spaceInfo(userId) {
  const member = await safely(() => isChannelMember(userId));
  let joinedAt = await safely(() => store.getChannelJoin(userId));
  let source = joinedAt ? "recorded" : null;
  if (!joinedAt && member) {
    // Joined before join dates were recorded: from now on count from the first visit.
    const now = new Date().toISOString();
    const saved = await safely(() => store.rememberChannelJoin(userId, now));
    if (saved !== undefined && saved !== null) {
      joinedAt = saved === 1 ? now : await safely(() => store.getChannelJoin(userId));
      source = "first_seen";
    }
  }
  return { member: member === undefined ? null : member, joined_at: joinedAt || null, joined_at_source: joinedAt ? source : null };
}

async function clubInfo(userId) {
  const [member, subscriber] = await Promise.all([
    safely(() => isClubMember(userId)),
    safely(() => tribute.getSubscriber(userId))
  ]);
  const clubUrl = String(process.env.TELEGRAM_CLUB_URL || "").trim();
  return {
    member: member === undefined ? null : member,
    // The club invite link is only revealed to confirmed members.
    url: member === true && clubUrl ? clubUrl : null,
    status: subscriber ? subscriber.status || null : null,
    activated_at: subscriber ? subscriber.activatedAt || null : null,
    expires_at: subscriber ? subscriber.expireAt || null : null
  };
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

  const [space, club] = await Promise.all([spaceInfo(user.id), clubInfo(user.id)]);
  return send(res, 200, {
    ok: true,
    user: { first_name: user.first_name || null, last_name: user.last_name || null },
    space,
    club
  });
};
