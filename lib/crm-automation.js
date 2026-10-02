// Daily automatic follow-ups along a woman's path (run by the morning cron):
//  • after her 1st meeting (single tickets, no package) → offer the full path of 6;
//  • after her 6th meeting → offer the Master path and the club;
//  • 3 days in the free channel without any purchase → invite to the nearest cycle;
//  • club subscription cancelled → ask why.
const crm = require("./crm");
const cycles = require("./cycles");
const schedule = require("./schedule");
const orders = require("./orders");

const DAY_MS = 864e5;
const mskDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

async function runAutoFollowups(now = Date.now()) {
  const today = mskDay(now);
  const step = (action) => ({ date: today, action });
  const result = { after_first: 0, after_sixth: 0, welcome: 0, club_cancel: 0 };
  const [paid, view, doc, cards] = await Promise.all([cycles.paidOrders(), cycles.overview(false), schedule.loadSchedule(), crm.listCards()]);
  const cycleById = new Map(view.cycles.map((c) => [c.id, c]));

  // Start of a meeting for an order: the cycle's dates if it has one, otherwise the city schedule.
  function startOf(order, mid) {
    const c = order.cycle_id && cycleById.get(order.cycle_id);
    if (c) { const iso = c.starts_at[Number(mid) - 1]; return iso ? new Date(iso).getTime() : null; }
    const city = schedule.findCity(doc, order.city_id);
    return city ? schedule.meetingStart(city.meetings[mid], city.timezone) : null;
  }

  // Group a woman's paid orders by cycle (or city for orders before cycles).
  const groups = new Map();
  for (const o of paid) {
    const key = `${o.user_id}|${o.cycle_id || o.city_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  for (const [key, list] of groups) {
    const [userId, group] = key.split("|");
    const first = list[0];
    const user = { id: userId, first_name: first.name || undefined, username: first.username || undefined };
    const covers = (mid) => list.some((o) => orders.meetingsOf(o).includes(mid));
    const hasPackage = list.some((o) => o.kind === "package");
    const passed = (mid) => {
      const o = list.find((x) => orders.meetingsOf(x).includes(mid));
      const t = o ? startOf(o, mid) : null;
      return t !== null && t < now && t > now - 21 * DAY_MS;
    };
    if (!hasPackage && covers("1") && passed("1")) {
      if (await crm.applyAuto(user, `after1:${group}`, step(`После 1-й встречи (${first.city_name}): предложить пакет «Все 6 встреч» и следующую встречу`), { interest: "cycle" })) result.after_first += 1;
    }
    if (covers("6") && passed("6")) {
      if (await crm.applyAuto(user, `after6:${group}`, step(`Прошла 6-ю встречу (${first.city_name}): предложить путь Мастера и клуб «к Женщине»`), { interest: "master" })) result.after_sixth += 1;
    }
  }

  for (const card of cards) {
    if (!card.tg_id) continue;
    const user = { id: card.tg_id };
    const joined = (card.history || []).find((h) => h.type === "channel");
    const joinedAt = joined ? new Date(joined.at).getTime() : null;
    if (joinedAt && joinedAt < now - 3 * DAY_MS && joinedAt > now - 14 * DAY_MS && !card.payments.length && !(card.club && card.club.status === "active")) {
      if (await crm.applyAuto(user, "welcome3", step("3 дня в канале без покупки: пригласить на ближайший цикл или в клуб"))) result.welcome += 1;
    }
    if (card.club && ["pre_cancelled", "cancelled"].includes(card.club.status)) {
      if (await crm.applyAuto(user, `club_cancel:${card.club.expire_at || ""}`, step("Отменила подписку на клуб: бережно узнать причину и предложить остаться"), { interest: "club", evenIfRefused: true })) result.club_cancel += 1;
    }
  }
  return result;
}

module.exports = { runAutoFollowups };
