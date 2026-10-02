// Admin: meetings schedule. Who may see client contacts, change prices or remove cities
// is decided by the member's role (lib/team.js).
const schedule = require("../schedule");
const orders = require("../orders");
const messages = require("../meeting-messages");
const team = require("../team");
const { telegram } = require("../telegram");

async function overview(doc, member) {
  const counts = await schedule.soldCounts(doc);
  const showContacts = team.can(member, "participants.view");
  const participants = {};
  const waitlists = {};
  await Promise.all(doc.cities.map(async (city) => {
    participants[city.id] = {};
    waitlists[city.id] = { package: await orders.waitlistSize(city.id, "package") };
    await Promise.all(schedule.MEETING_IDS.map(async (mid) => {
      waitlists[city.id][mid] = await orders.waitlistSize(city.id, mid);
      if (showContacts) {
        participants[city.id][mid] = (await orders.ordersFor(city.id, mid)).map((o) => ({
          name: o.name, username: o.username, kind: o.kind, amount: o.amount, phone: o.phone || null, email: o.email || null, paid_at: o.paid_at
        }));
      }
    }));
  }));
  return { counts, participants: showContacts ? participants : null, waitlists };
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

async function handle(member, body) {
  if (!team.can(member, "schedule.edit")) return { status: 403, body: { ok: false, error: "Нет доступа к расписанию" } };
  if (body.action !== "save") {
    const doc = await schedule.loadSchedule();
    return { status: 200, body: { ok: true, schedule: doc, ...(await overview(doc, member)) } };
  }
  const { errors, schedule: next } = schedule.normalizeSchedule(body.schedule);
  if (errors.length) return { status: 400, body: { ok: false, errors } };
  const before = await schedule.loadSchedule();
  // Which dashboard cycle a city is showing stays as it was.
  for (const city of next.cities) {
    const old = schedule.findCity(before, city.id);
    if (old && old.cycle_id) city.cycle_id = old.cycle_id;
  }
  if (!team.can(member, "prices.edit")) next.prices = before.prices;
  if (!team.can(member, "cities.remove")) {
    const missing = before.cities.filter((c) => !schedule.findCity(next, c.id));
    if (missing.length) return { status: 403, body: { ok: false, errors: [`Удалять города может только владелец (${missing.map((c) => c.name).join(", ")})`] } };
  }
  const saved = await schedule.saveSchedule(next);
  const notified = await notifyWaitlists(newlyDated(before, saved));
  return { status: 200, body: { ok: true, schedule: saved, notified, ...(await overview(saved, member)) } };
}

module.exports = { handle, newlyDated, notifyWaitlists };
