// Numbers for the analytics tab. Every block is computed independently: if one source
// (Telegram, Tribute, storage) is down, the others still show and that block says so.
const store = require("./store");
const stats = require("./stats");
const schedule = require("./schedule");
const orders = require("./orders");
const tribute = require("./tribute");
const { telegram } = require("./telegram");

const DAY_MS = 24 * 60 * 60 * 1000;

async function safe(task) {
  try { return await task(); } catch (error) { return { error: "Нет данных" }; }
}

async function community() {
  const count = async (chatId) => (chatId ? Number(await telegram("getChatMemberCount", { chat_id: chatId })) : null);
  const [channel, club] = await Promise.all([
    count(String(process.env.TELEGRAM_CHANNEL_ID || "").trim()).catch(() => null),
    count(String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim()).catch(() => null)
  ]);
  return { channel_members: channel, club_members: club };
}

async function funnel() {
  const [started, appUsers, onboarded] = await Promise.all([
    store.command("SCARD", stats.KEYS.started), store.command("SCARD", stats.KEYS.appUsers), store.command("SCARD", stats.KEYS.onboarded)
  ]);
  return { started: Number(started) || 0, app_users: Number(appUsers) || 0, onboarded: Number(onboarded) || 0 };
}

// Daily series for the last `days` days (oldest first).
async function daily(keyFor, days, now) {
  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) dates.push(stats.day(new Date(now - i * DAY_MS)));
  const values = await store.command("MGET", ...dates.map(keyFor));
  return dates.map((date, i) => ({ date, value: Number((values || [])[i]) || 0 }));
}

async function growth(now) {
  const [joins, starts] = await Promise.all([daily(stats.KEYS.joinsOn, 30, now), daily(stats.KEYS.startsOn, 30, now)]);
  const sum = (series, n) => series.slice(-n).reduce((a, x) => a + x.value, 0);
  return { joins_7d: sum(joins, 7), joins_30d: sum(joins, 30), starts_7d: sum(starts, 7), starts_30d: sum(starts, 30), joins_daily: joins };
}

async function club(now) {
  const list = await tribute.listSubscribers();
  const by = (status) => list.filter((s) => s.status === status).length;
  const within = (iso, from, to) => { const t = new Date(iso || 0).getTime(); return t >= from && t < to; };
  return {
    active: by("active"),
    cancelling: by("pre_cancelled"),
    cancelled: by("cancelled"),
    new_30d: list.filter((s) => within(s.activatedAt, now - 30 * DAY_MS, now + 1)).length,
    ending_7d: list.filter((s) => (s.status === "active" || s.status === "pre_cancelled") && within(s.expireAt, now, now + 7 * DAY_MS)).length
  };
}

async function meetings(now) {
  const ids = (await store.command("SMEMBERS", stats.KEYS.paidOrders)) || [];
  const paid = ids.length
    ? ((await store.command("MGET", ...ids.map((id) => `order:${id}`))) || []).filter(Boolean).map((raw) => JSON.parse(raw)).filter((o) => o.status === "paid")
    : [];
  const doc = await schedule.loadSchedule();
  const cities = {};
  for (const city of doc.cities) cities[city.id] = { name: city.name, orders: 0, revenue: 0, waitlist: 0 };
  let packages = 0;
  const perMeeting = Object.fromEntries(schedule.MEETING_IDS.map((mid) => [mid, { title: schedule.MEETINGS[mid].title, seats: 0 }]));
  for (const o of paid) {
    const c = cities[o.city_id] || (cities[o.city_id] = { name: o.city_name, orders: 0, revenue: 0, waitlist: 0 });
    c.orders += 1; c.revenue += o.amount;
    if (o.kind === "package") packages += 1;
    for (const mid of orders.meetingsOf(o)) if (perMeeting[mid]) perMeeting[mid].seats += 1;
  }
  let waitlistTotal = 0;
  for (const city of doc.cities) {
    for (const target of ["package", ...schedule.MEETING_IDS]) {
      const n = await orders.waitlistSize(city.id, target);
      cities[city.id].waitlist += n; waitlistTotal += n;
    }
  }
  const last30 = paid.filter((o) => new Date(o.paid_at).getTime() >= now - 30 * DAY_MS);
  return {
    orders: paid.length,
    revenue: paid.reduce((a, o) => a + o.amount, 0),
    orders_30d: last30.length,
    revenue_30d: last30.reduce((a, o) => a + o.amount, 0),
    packages,
    waitlist: waitlistTotal,
    by_city: Object.values(cities),
    by_meeting: Object.values(perMeeting)
  };
}

async function buildAnalytics(now = Date.now()) {
  const [c, f, g, cl, m] = await Promise.all([safe(community), safe(funnel), safe(() => growth(now)), safe(() => club(now)), safe(() => meetings(now))]);
  return { generated_at: new Date(now).toISOString(), community: c, funnel: f, growth: g, club: cl, meetings: m };
}

module.exports = { buildAnalytics };
