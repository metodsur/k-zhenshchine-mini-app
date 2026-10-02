// Management dashboard API (os.html). Session cookie from a one-time bot link; every section
// checks the member's permissions (lib/team.js).
const team = require("../../lib/team");
const auth = require("../../lib/os-auth");
const crm = require("../../lib/crm");
const cycles = require("../../lib/cycles");
const board = require("../../lib/os-board");
const events = require("../../lib/events");
const tribute = require("../../lib/tribute");
const { send, readBody } = require("../../lib/http");

const DAY_MS = 864e5;
const TZ = "Europe/Moscow";
const dayOf = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const deny = (what) => ({ status: 403, body: { ok: false, error: `Нет доступа: ${what}` } });
const fail = (result) => ({ status: result.status || 400, body: { ok: false, errors: result.errors || [result.error || "Не получилось"] } });
const who = (member) => member.name || member.role_label;

function meView(member) {
  return {
    ok: true, id: member.id, name: member.name || null, role: member.role, role_label: member.role_label, perms: member.perms,
    dict: { stages: crm.STAGES, stage_order: crm.STAGE_ORDER, interests: crm.INTERESTS, sources: crm.SOURCES, cycle_statuses: cycles.STATUSES, calendar_types: board.CALENDAR_TYPES },
    bot_username: process.env.TELEGRAM_BOT_USERNAME || "K_zhenshcine_bot"
  };
}

async function clubStatusMap() {
  try {
    const list = await tribute.listSubscribers();
    const map = new Map();
    for (const s of list) {
      const id = String(s.telegramUserId || "");
      if (!id) continue;
      const picked = tribute.pickSubscriber(list, id);
      if (picked) map.set(id, { status: picked.status, expire_at: picked.expireAt || null });
    }
    return map;
  } catch { return null; }
}

// Everything dated in [from, to]: cycle meetings, club events, manual entries.
async function calendarItems(from, to, cycleView) {
  const items = [];
  const view = cycleView || (await cycles.overview(false));
  for (const c of view.cycles) {
    if (c.status === "cancelled") continue;
    for (const [i, mid] of ["1", "2", "3", "4", "5", "6"].entries()) {
      const m = c.meetings[mid];
      if (!m || !m.date || m.date < from || m.date > to) continue;
      items.push({ kind: "cycle", id: `${c.id}:${mid}`, cycle_id: c.id, date: m.date, time: m.time || "", title: `${c.city_name}: встреча ${mid} из 6`, place: c.venue || "", meta: c.master.name ? `Мастер: ${c.master.name}` : "", seats: `${c.seats_by_meeting[mid]}/${c.capacity}`, index: i });
    }
  }
  for (const e of await events.loadEvents()) {
    if (e.date >= from && e.date <= to) items.push({ kind: "club", id: `club:${e.date}:${e.title}`, date: e.date, time: "", title: e.title, place: "Клуб", meta: e.text || "" });
  }
  for (const e of await board.loadEntries()) {
    if (e.date >= from && e.date <= to) items.push({ kind: "entry", ...e, type_label: board.CALENDAR_TYPES[e.type] || "" });
  }
  items.sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")));
  return items;
}

const sections = {
  async me(member) { return { status: 200, body: meView(member) }; },

  async today(member) {
    const now = Date.now();
    const today = dayOf(now);
    const canCrm = team.can(member, "crm.view");
    const [cards, cycleView, tasks, club] = await Promise.all([
      canCrm ? crm.listCards() : [], cycles.overview(false), board.loadTasks(), clubStatusMap()
    ]);
    const week = now - 7 * DAY_MS;
    const followups = cards
      .filter((c) => c.stage !== "refused" && c.next_step && c.next_step.date && c.next_step.date <= today)
      .sort((a, b) => a.next_step.date.localeCompare(b.next_step.date))
      .map(crm.summary);
    const newLeads = cards.filter((c) => new Date(c.created_at).getTime() >= now - 2 * DAY_MS).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(crm.summary);
    const payments = [];
    for (const c of cards) for (const p of c.payments) if (new Date(p.at).getTime() >= week) payments.push({ ...p, card_id: c.id, name: c.name, username: c.username });
    payments.sort((a, b) => b.at.localeCompare(a.at));
    const activeCycles = cycleView.cycles.filter((c) => cycles.ACTIVE.includes(c.status));
    const upcoming = await calendarItems(today, dayOf(now + 7 * DAY_MS), cycleView);
    const kpi = {
      leads_7d: cards.filter((c) => new Date(c.created_at).getTime() >= week).length,
      payments_7d: payments.length,
      revenue_7d: payments.reduce((a, p) => a + p.amount, 0),
      club_active: club ? [...club.values()].filter((s) => s.status === "active").length : null,
      active_cycles: activeCycles.length,
      free_seats: activeCycles.reduce((a, c) => a + c.free_seats, 0)
    };
    return {
      status: 200,
      body: {
        ok: true, today, kpi, crm_visible: canCrm,
        followups, new_leads: newLeads, payments: payments.slice(0, 20), upcoming,
        cycles: activeCycles.map((c) => ({ id: c.id, city_name: c.city_name, status: c.status, capacity: c.capacity, free_seats: c.free_seats, master: c.master.name, published: c.published, next: c.meetings[["1", "2", "3", "4", "5", "6"].find((mid) => c.meetings[mid].date && c.meetings[mid].date >= today)] || null })),
        tasks: tasks.filter((t) => !t.done).sort((a, b) => Number(b.blocker) - Number(a.blocker) || String(a.due || "9").localeCompare(String(b.due || "9")))
      }
    };
  },

  async crm(member, body) {
    if (!team.can(member, "crm.view")) return deny("CRM");
    const action = body.action || "list";
    if (action === "list") {
      const [cards, club] = await Promise.all([crm.listCards(), clubStatusMap()]);
      const rows = cards.map((c) => {
        const live = club && c.tg_id ? club.get(String(c.tg_id)) : null;
        return crm.summary(live ? { ...c, club: live } : c);
      }).sort((a, b) => b.last_touch_at.localeCompare(a.last_touch_at));
      return { status: 200, body: { ok: true, cards: rows } };
    }
    if (action === "get") {
      const card = await crm.getCard(body.id);
      return card ? { status: 200, body: { ok: true, card } } : { status: 404, body: { ok: false, errors: ["Карточка не найдена"] } };
    }
    if (!team.can(member, "crm.edit")) return deny("ведение CRM");
    let result;
    if (action === "update") result = await crm.updateCard(body.id, body.patch, who(member));
    else if (action === "create") result = await crm.createCard(body.card, who(member));
    else if (action === "note") result = await crm.addNote(body.id, body.text, who(member), body.type);
    else return { status: 400, body: { ok: false, errors: ["Неизвестное действие"] } };
    return result.card ? { status: 200, body: { ok: true, card: result.card } } : fail(result);
  },

  async cycles(member, body) {
    const action = body.action || "list";
    const canEdit = team.can(member, "cycles.edit");
    const contacts = team.can(member, "participants.view") || team.can(member, "crm.view");
    if (action === "list") return { status: 200, body: { ok: true, can_edit: canEdit, ...(await cycles.overview(contacts)) } };
    if (!canEdit) return deny("циклы");
    let result;
    if (action === "save") result = await cycles.saveCycle(body.cycle, body.id || null);
    else if (action === "publish") result = await cycles.publish(String(body.id || ""));
    else if (action === "unpublish") result = await cycles.unpublish(String(body.id || ""));
    else return { status: 400, body: { ok: false, errors: ["Неизвестное действие"] } };
    if (result.status !== 200) return fail(result);
    return { status: 200, body: { ok: true, notified: result.notified || 0, warning: result.warning || null, can_edit: true, ...(await cycles.overview(contacts)) } };
  },

  async calendar(member, body) {
    const action = body.action || "list";
    if (action === "list") {
      const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const from = isDay(body.from) ? body.from : dayOf(Date.now() - 7 * DAY_MS);
      const to = isDay(body.to) ? body.to : dayOf(Date.now() + 60 * DAY_MS);
      return { status: 200, body: { ok: true, from, to, items: await calendarItems(from, to), can_edit: team.can(member, "cycles.edit") } };
    }
    if (!team.can(member, "cycles.edit")) return deny("календарь");
    const result = action === "save" ? await board.saveEntry(body.entry || {}, who(member)) : action === "remove" ? await board.removeEntry(String(body.id || "")) : { status: 400, errors: ["Неизвестное действие"] };
    return result.status === 200 ? { status: 200, body: { ok: true } } : fail(result);
  },

  async tasks(member, body) {
    const action = body.action || "list";
    if (action === "list") return { status: 200, body: { ok: true, tasks: await board.loadTasks() } };
    if (!team.can(member, "tasks.edit")) return deny("задачи");
    const result = action === "save" ? await board.saveTask(body.task || {}, who(member)) : action === "remove" ? await board.removeTask(String(body.id || "")) : { status: 400, errors: ["Неизвестное действие"] };
    return result.status === 200 ? { status: 200, body: { ok: true, tasks: result.tasks } } : fail(result);
  }
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  // Only the dashboard page sends this header (blocks cross-site form posts).
  if (String((req.headers && req.headers["x-kz-os"]) || "") !== "1") return send(res, 403, { ok: false });
  const name = String((req.query && req.query.section) || "");
  const body = readBody(req);
  try {
    if (name === "login") {
      const session = await auth.redeem(body.token);
      if (!session) return send(res, 401, { ok: false, error: "Ссылка для входа устарела. Напишите боту /dashboard и откройте новую." });
      res.setHeader("Set-Cookie", auth.sessionCookie(session.sid));
      return send(res, 200, meView(session.member));
    }
    if (name === "logout") {
      await auth.logout(req);
      res.setHeader("Set-Cookie", auth.clearCookie());
      return send(res, 200, { ok: true });
    }
    const section = sections[name];
    if (!section) return send(res, 404, { ok: false });
    const member = await auth.memberFromRequest(req);
    if (!member) return send(res, 401, { ok: false, error: "Войдите через бота: напишите /dashboard" });
    const result = await section(member, body);
    return send(res, result.status, result.body);
  } catch (error) {
    console.error("Dashboard section failed", name, error.message);
    return send(res, 500, { ok: false, error: "Не получилось. Попробуйте ещё раз." });
  }
};
