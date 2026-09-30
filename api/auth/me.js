const { verifyInitData, isChannelMember, isClubMember } = require("../../lib/telegram");
const store = require("../../lib/store");
const tribute = require("../../lib/tribute");
const profile = require("../../lib/profile");
const settings = require("../../lib/settings");
const orders = require("../../lib/orders");
const schedule = require("../../lib/schedule");

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

// Paid tickets as one row per meeting (a package gives six rows), upcoming first.
async function ticketsInfo(userId, now = Date.now()) {
  const paid = await orders.userOrders(userId);
  if (!paid.length) return { items: [], passed: 0 };
  const doc = await schedule.loadSchedule();
  const items = [];
  for (const order of paid) {
    const city = schedule.findCity(doc, order.city_id);
    for (const mid of orders.meetingsOf(order)) {
      const m = city ? city.meetings[mid] : null;
      const start = m ? schedule.meetingStart(m, city.timezone) : null;
      items.push({
        meeting: mid,
        title: schedule.MEETINGS[mid].title,
        city: city ? city.name : order.city_name,
        kind: order.kind,
        date_label: m ? schedule.formatMeetingDate(m, city.timezone) : "Дата скоро появится",
        starts_at: start ? new Date(start).toISOString() : null,
        venue: m && m.venue || null,
        address: m && m.address || null,
        status: start === null ? "soon" : now > start + 3 * 60 * 60 * 1000 ? "past" : "upcoming"
      });
    }
  }
  const rank = { upcoming: 0, soon: 1, past: 2 };
  items.sort((a, b) => rank[a.status] - rank[b.status] || (a.status === "past" ? -1 : 1) * (new Date(a.starts_at || 0) - new Date(b.starts_at || 0)));
  const passed = new Set(items.filter((t) => t.status === "past").map((t) => t.meeting)).size;
  return { items, passed };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });

  let user;
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    user = verifyInitData(body.initData);
  } catch {
    return send(res, 401, { ok: false, error: "Invalid Telegram authorization" });
  }

  if (body.action === "save_profile") {
    try { return send(res, 200, { ok: true, profile: await profile.saveProfile(user.id, body.profile || {}) }); }
    catch { return send(res, 500, { ok: false, error: "Не получилось сохранить. Попробуйте ещё раз." }); }
  }

  const [space, club, tickets, saved, links, progress] = await Promise.all([
    spaceInfo(user.id), clubInfo(user.id),
    safely(() => ticketsInfo(user.id)), safely(() => profile.loadProfile(user.id)),
    safely(() => settings.loadSettings()), safely(() => store.onboardingState(user.id))
  ]);
  return send(res, 200, {
    ok: true,
    user: { first_name: user.first_name || null, last_name: user.last_name || null, photo_url: user.photo_url || null },
    space,
    club,
    tickets: tickets || { items: [], passed: 0 },
    profile: saved || null,
    links: links || { materials_url: "", ritual_url: "" },
    start_flow: progress || null
  });
};
