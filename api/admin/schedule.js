const schedule = require("../../lib/schedule");
const orders = require("../../lib/orders");
const messages = require("../../lib/meeting-messages");
const { telegram } = require("../../lib/telegram");
const { send, readBody, telegramUser, isAdmin } = require("../../lib/http");

async function overview(doc) {
  const counts = await schedule.soldCounts(doc);
  const participants = {};
  const waitlists = {};
  await Promise.all(doc.cities.map(async (city) => {
    participants[city.id] = {};
    waitlists[city.id] = { package: await orders.waitlistSize(city.id, "package") };
    await Promise.all(schedule.MEETING_IDS.map(async (mid) => {
      waitlists[city.id][mid] = await orders.waitlistSize(city.id, mid);
      participants[city.id][mid] = (await orders.ordersFor(city.id, mid)).map((o) => ({
        name: o.name, username: o.username, kind: o.kind, amount: o.amount, phone: o.phone || null, email: o.email || null, paid_at: o.paid_at
      }));
    }));
  }));
  return { counts, participants, waitlists };
}

// Meetings that just got a date: their waitlist is told right away.
function newlyDated(before, after) {
  const found = [];
  for (const city of after.cities) {
    const old = schedule.findCity(before, city.id);
    for (const mid of schedule.MEETING_IDS) {
      const had = old && old.meetings[mid] && old.meetings[mid].date;
      if (!had && city.meetings[mid].date) found.push({ city, target: mid });
    }
    if (!(old && old.meetings["1"].date) && city.meetings["1"].date) found.push({ city, target: "package" });
  }
  return found;
}

async function notifyWaitlists(items) {
  let sent = 0;
  const now = Date.now();
  for (const { city, target } of items) {
    const first = city.meetings[target === "package" ? "1" : target];
    if (schedule.meetingStatus(first, city.timezone, 0, now) !== "open") continue;
    const message = messages.dateAnnouncedMessage(city, target);
    for (const userId of await orders.takeWaitlist(city.id, target)) {
      try { await telegram("sendMessage", { chat_id: userId, ...message }); sent += 1; } catch { /* user never started the bot */ }
    }
  }
  return sent;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const body = readBody(req);
  const user = telegramUser(body);
  if (!user) return send(res, 401, { ok: false, error: "Откройте страницу из Telegram" });
  if (!isAdmin(user)) return send(res, 403, { ok: false, error: "Нет доступа", your_id: user.id });

  try {
    if (body.action === "save") {
      const { errors, schedule: next } = schedule.normalizeSchedule(body.schedule);
      if (errors.length) return send(res, 400, { ok: false, errors });
      const before = await schedule.loadSchedule();
      const saved = await schedule.saveSchedule(next);
      const notified = await notifyWaitlists(newlyDated(before, saved));
      return send(res, 200, { ok: true, schedule: saved, notified, ...(await overview(saved)) });
    }
    const doc = await schedule.loadSchedule();
    return send(res, 200, { ok: true, schedule: doc, ...(await overview(doc)) });
  } catch (error) {
    console.error("Admin schedule failed", error.message);
    return send(res, 500, { ok: false, error: "Не удалось сохранить. Попробуйте ещё раз." });
  }
};

module.exports.newlyDated = newlyDated;
