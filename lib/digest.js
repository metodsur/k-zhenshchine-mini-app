// Morning digest in the bot (9:00 Moscow): each team member gets only their own plan for the day —
// follow-ups, tasks, content and media deadlines, and what happens today.
const team = require("./team");
const crm = require("./crm");
const board = require("./os-board");
const collections = require("./os-collections");
const cycles = require("./cycles");
const events = require("./events");
const store = require("./store");
const { telegram } = require("./telegram");

const mskDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const human = (day) => { const [, m, d] = day.split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };
const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase() && String(a || "").trim() !== "";

function section(title, rows, limit = 6) {
  if (!rows.length) return [];
  const out = ["", `${title} (${rows.length}):`, ...rows.slice(0, limit).map((r) => `• ${r}`)];
  if (rows.length > limit) out.push(`• и ещё ${rows.length - limit}`);
  return out;
}

async function buildFor(member, data, today) {
  const lead = team.can(member, "analytics.view"); // owner and director also see what has no owner
  const mine = (owner) => same(owner, member.name) || (lead && !String(owner || "").trim());
  const late = (day) => (day < today ? " — просрочено" : "");
  const lines = [];

  if (team.can(member, "crm.view")) {
    const rows = data.cards
      .filter((c) => c.stage !== "refused" && c.next_step && c.next_step.date && c.next_step.date <= today && mine(c.owner))
      .sort((a, b) => a.next_step.date.localeCompare(b.next_step.date))
      .map((c) => `${c.name || (c.username ? "@" + c.username : "без имени")} — ${c.next_step.action || "следующий шаг"}${late(c.next_step.date)}`);
    lines.push(...section("📞 Follow-up", rows));
  }
  const taskRows = data.tasks
    .filter((t) => !t.done && mine(t.owner) && (t.blocker || (t.due && t.due <= today)))
    .map((t) => `${t.title}${t.blocker ? " (блокер)" : ""}${t.due ? late(t.due) : ""}`);
  lines.push(...section("✅ Задачи", taskRows));

  for (const [name, icon] of [["content", "🎬 Контент"], ["media", "🎙 Медиа"]]) {
    const schema = collections.SCHEMAS[name];
    const order = Object.keys(schema.stages);
    const rows = data[name]
      .filter((it) => it[schema.due_field] && it[schema.due_field] <= today && order.indexOf(it.stage) < order.indexOf(schema.done_from) && mine(it.owner))
      .map((it) => `${it.title} · ${schema.stages[it.stage]}${it.next_action ? ` · ${it.next_action}` : ""}${late(it[schema.due_field])}`);
    lines.push(...section(icon, rows));
  }

  if (!member.perms.includes("attendance.mark") || team.can(member, "os.workspace")) {
    const todayRows = [];
    for (const c of data.cycles) {
      for (const mid of ["1", "2", "3", "4", "5", "6"]) {
        const m = c.meetings[mid];
        if (m && m.date === today) todayRows.push(`${m.time ? m.time + " " : ""}${c.city_name}: встреча ${mid} из 6${c.venue ? ` · ${c.venue}` : ""} · мест занято ${c.seats_by_meeting[mid]}/${c.capacity}`);
      }
    }
    for (const e of data.entries) if (e.date === today) todayRows.push(`${e.time ? e.time + " " : ""}${e.title}${e.varvara ? " (Варвара)" : ""}`);
    for (const m of data.media) if (m.date === today) todayRows.push(`${m.time ? m.time + " " : ""}Медийный выход: ${m.title}`);
    for (const c of data.content) if (c.publish_date === today) todayRows.push(`${c.publish_time ? c.publish_time + " " : ""}Публикация: ${c.title}`);
    for (const e of data.clubEvents) if (e.date === today) todayRows.push(`Клуб: ${e.title}`);
    lines.push(...section("📅 Сегодня", todayRows, 8));
  }
  return lines;
}

async function runDigest(now = Date.now()) {
  const today = mskDay(now);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const members = (await team.listMembers()).filter((m) => team.can(m, "os.access"));
  const result = { members: members.length, sent: 0, empty: 0 };
  if (!members.length) return result;
  const [cards, tasks, content, media, entries, view, clubEvents] = await Promise.all([
    crm.listCards(), board.loadTasks(), collections.load("content"), collections.load("media"), board.loadEntries(), cycles.overview(false), events.loadEvents()
  ]);
  const data = { cards, tasks, content, media, entries, cycles: view.cycles.filter((c) => c.status !== "cancelled"), clubEvents };
  for (const member of members) {
    const lines = await buildFor(member, data, today);
    // Weekends: only when something actually happens or is overdue.
    if (!lines.length || ((weekday === 0 || weekday === 6) && !lines.some((l) => /Сегодня|просрочено/.test(l)))) { result.empty += 1; continue; }
    if (!(await store.claimOnce(`digest:${member.id}:${today}`, 2 * 86400))) continue;
    const hello = `Доброе утро${member.name ? `, ${member.name}` : ""} ☀️\nПлан на ${human(today)}:`;
    try {
      await telegram("sendMessage", { chat_id: member.id, text: [hello, ...lines, "", "Кабинет: /dashboard"].join("\n") });
      result.sent += 1;
    } catch { /* the member never started the bot */ }
  }
  return result;
}

module.exports = { runDigest, buildFor };
