// Team task tracker: dashboard «Задачи», bot /tasks, notifications, deadline reminders
// and the Friday summary. Tasks live in the same list as the old «Задачи и блокеры»
// (key os:tasks), so «Сегодня», the digest and the checklists keep working.
const crypto = require("crypto");
const store = require("./store");
const team = require("./team");
const { telegram } = require("./telegram");

const KEY = "os:tasks";
const STATUSES = { todo: "Нужно сделать", doing: "В работе", done: "Выполнено" };
const TZ = "Europe/Moscow";
const mskDay = (ms = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const human = (day) => { if (!day) return ""; const [, m, d] = day.split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };
const clean = (v, max = 200) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

async function load() {
  const raw = await store.command("GET", KEY);
  let list = [];
  try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
  // Older simple tasks: status from the done flag.
  return list.map((t) => ({ status: t.done ? "done" : "todo", area: "", description: "", checklist: [], comments: [], ...t }));
}
async function save(list) {
  // Finished tasks are kept 60 days (for the summaries), then dropped.
  const cutoff = Date.now() - 60 * 864e5;
  const kept = list.filter((t) => t.status !== "done" || new Date(t.done_at || t.updated_at || 0).getTime() > cutoff);
  await store.command("SET", KEY, JSON.stringify(kept));
  return kept;
}

function normalize(src, before) {
  const s = src && typeof src === "object" ? src : {};
  const errors = [];
  const pick = (k, fn, fallback) => (k in s ? fn(s[k]) : before ? before[k] : fallback);
  const title = pick("title", (v) => clean(v, 200), "");
  if (!title) errors.push("Опишите задачу");
  const due = pick("due", (v) => clean(v, 10) || null, null);
  if (due && !isDate(due)) errors.push("Дедлайн в формате ГГГГ-ММ-ДД");
  let status = pick("status", (v) => (STATUSES[v] ? v : null), "todo");
  if (!("status" in s) && "done" in s) status = s.done ? "done" : (before && before.status !== "done" ? before.status : "todo");
  if (!status) errors.push("Неизвестный статус");
  const checklist = pick("checklist", (v) => (Array.isArray(v) ? v : []).map((c) => ({ text: clean(c && c.text, 200), done: Boolean(c && c.done) })).filter((c) => c.text).slice(0, 40), []);
  return {
    errors,
    task: {
      title, due, status, done: status === "done", checklist,
      owner: pick("owner", (v) => clean(v, 80), ""),
      area: pick("area", (v) => clean(v, 60), ""),
      description: pick("description", (v) => String(v == null ? "" : v).trim().slice(0, 3000), ""),
      blocker: pick("blocker", Boolean, false)
    }
  };
}

// Create or update. `actor` = { name, id }.
async function saveTask(input, actor) {
  const list = await load();
  const id = input && input.id;
  const i = id ? list.findIndex((t) => t.id === id) : -1;
  if (id && i === -1) return { status: 404, errors: ["Задача не найдена"] };
  const before = i >= 0 ? list[i] : null;
  const { errors, task } = normalize(input, before);
  if (errors.length) return { status: 400, errors };
  const at = nowIso();
  let saved;
  if (before) {
    saved = { ...before, ...task, updated_at: at };
    if (task.status !== before.status) {
      saved.done_at = task.status === "done" ? at : null;
      saved.done_by = task.status === "done" ? actor.name : null;
      saved.history = [...(before.history || []), { at, by: actor.name, text: `${STATUSES[before.status]} → ${STATUSES[task.status]}` }].slice(-50);
    }
    list[i] = saved;
  } else {
    saved = { id: crypto.randomBytes(5).toString("hex"), ...task, comments: [], history: [{ at, by: actor.name, text: "Создана" }],
      created_by: actor.name, created_by_id: actor.id ? String(actor.id) : null, created_at: at, updated_at: at, done_at: task.status === "done" ? at : null };
    list.push(saved);
  }
  const tasks = await save(list);
  if (!actor.silent) await notifyChange(before, saved, actor);
  return { status: 200, task: saved, tasks };
}

async function setStatus(id, status, actor, comment) {
  if (!STATUSES[status]) return { status: 400, errors: ["Неизвестный статус"] };
  const r = await saveTask({ id, status }, actor);
  if (r.status === 200 && comment) return addComment(id, comment, actor, { silent: true });
  return r;
}

async function addComment(id, text, actor, { silent = false } = {}) {
  const body = String(text || "").trim().slice(0, 2000);
  if (!body) return { status: 400, errors: ["Пустой комментарий"] };
  const list = await load();
  const t = list.find((x) => x.id === id);
  if (!t) return { status: 404, errors: ["Задача не найдена"] };
  t.comments = [...(t.comments || []), { at: nowIso(), by: actor.name, text: body }].slice(-100);
  t.updated_at = nowIso();
  const tasks = await save(list);
  if (!silent) {
    const msg = `💬 Комментарий к задаче «${t.title}»\n${actor.name}: ${body.slice(0, 1500)}`;
    await notifyPeople(t, actor, msg, ["assignee", "creator"]);
  }
  return { status: 200, task: t, tasks };
}

async function removeTask(id) {
  const list = await load();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return { status: 404, errors: ["Задача не найдена"] };
  return { status: 200, tasks: await save(next) };
}

// ---------- notifications ----------

const cabinetLine = "Кабинет: /dashboard · мои задачи: /tasks";

async function recipients(task, actor, who) {
  const members = await team.listMembers();
  const ids = new Set();
  const byName = (n) => members.find((m) => clean(m.name).toLowerCase() === clean(n).toLowerCase() && clean(n));
  if (who.includes("assignee")) { const m = byName(task.owner); if (m) ids.add(String(m.id)); }
  if (who.includes("creator") && task.created_by_id) ids.add(String(task.created_by_id));
  if (who.includes("owners")) members.filter((m) => m.role === "owner").forEach((m) => ids.add(String(m.id)));
  if (actor && actor.id) ids.delete(String(actor.id));
  return [...ids];
}

async function notifyPeople(task, actor, text, who) {
  for (const id of await recipients(task, actor, who)) {
    try { await telegram("sendMessage", { chat_id: id, text: `${text}\n\n${cabinetLine}`, reply_markup: taskButtons(task) }); } catch { /* never started the bot */ }
  }
}

async function notifyChange(before, task, actor) {
  if (task.status === "done" && (!before || before.status !== "done")) {
    const last = (task.comments || []).slice(-1)[0];
    await notifyPeople(task, actor, `✅ Задача выполнена: «${task.title}»\nВыполнила: ${actor.name}${last && last.by === actor.name ? `\nКомментарий: ${last.text}` : ""}`, ["owners", "creator"]);
    return;
  }
  if (task.owner && task.status !== "done" && (!before || clean(before.owner).toLowerCase() !== clean(task.owner).toLowerCase())) {
    await notifyPeople(task, actor, `📌 Вам назначена задача: «${task.title}»${task.area ? `\nНаправление: ${task.area}` : ""}${task.due ? `\nДедлайн: ${human(task.due)}` : ""}\nНазначил(а): ${actor.name}`, ["assignee"]);
  }
}

// ---------- bot: /tasks and buttons ----------

function taskButtons(task) {
  if (task.status === "done") return { inline_keyboard: [[{ text: "💬 Комментарий", callback_data: `t:c:${task.id}` }]] };
  const row = [];
  if (task.status === "todo") row.push({ text: "▶️ В работу", callback_data: `t:w:${task.id}` });
  row.push({ text: "✅ Выполнено", callback_data: `t:d:${task.id}` });
  return { inline_keyboard: [row, [{ text: "💬 Комментарий", callback_data: `t:c:${task.id}` }]] };
}

function taskText(t, today = mskDay()) {
  const late = t.due && t.due < today && t.status !== "done";
  const done = (t.checklist || []).filter((c) => c.done).length;
  return [
    `${t.status === "done" ? "✅" : t.status === "doing" ? "🔸" : "▫️"} ${t.title}`,
    [t.area, STATUSES[t.status], t.due ? `дедлайн ${human(t.due)}${late ? " — просрочено" : ""}` : "без дедлайна"].filter(Boolean).join(" · "),
    t.checklist && t.checklist.length ? `Чек-лист: ${done} из ${t.checklist.length}` : null,
    t.comments && t.comments.length ? `Последний комментарий — ${t.comments.slice(-1)[0].by}: ${t.comments.slice(-1)[0].text.slice(0, 200)}` : null
  ].filter(Boolean).join("\n");
}

const sortOpen = (a, b) => (a.status === "doing" ? 0 : 1) - (b.status === "doing" ? 0 : 1) || String(a.due || "9").localeCompare(String(b.due || "9"));

async function handleCommand(message) {
  if (!message || !message.chat || message.chat.type !== "private" || typeof message.text !== "string") return false;
  if (!/^\/tasks(@\w+)?(\s|$)/.test(message.text)) return false;
  const member = await team.getMember(message.from.id);
  if (!member || !team.can(member, "os.access")) {
    await telegram("sendMessage", { chat_id: message.chat.id, text: "Задачи доступны команде «к Женщине»." });
    return true;
  }
  const list = (await load()).filter((t) => t.status !== "done");
  const mine = list.filter((t) => clean(t.owner).toLowerCase() === clean(member.name).toLowerCase() && clean(member.name)).sort(sortOpen);
  const lead = team.can(member, "analytics.view");
  const today = mskDay();
  const late = list.filter((t) => t.due && t.due < today).length;
  await telegram("sendMessage", { chat_id: message.chat.id, text: mine.length
    ? `Ваши открытые задачи: ${mine.length}${lead ? `\nВсего открытых в команде: ${list.length}${late ? `, просрочено: ${late}` : ""}` : ""}`
    : `У вас нет открытых задач 🤍${lead ? `\nВсего открытых в команде: ${list.length}${late ? `, просрочено: ${late}` : ""} — смотрите в кабинете (/dashboard → «Задачи»).` : ""}` });
  for (const t of mine.slice(0, 15)) {
    await telegram("sendMessage", { chat_id: message.chat.id, text: taskText(t, today), reply_markup: taskButtons(t) });
  }
  if (mine.length > 15) await telegram("sendMessage", { chat_id: message.chat.id, text: `И ещё ${mine.length - 15} — в кабинете (/dashboard → «Задачи»).` });
  return true;
}

// Inline buttons under task messages.
async function handleCallback(query) {
  const m = /^t:([wdc]):([a-f0-9]{10})$/.exec(String(query.data || ""));
  if (!m) return false;
  const answer = (text) => telegram("answerCallbackQuery", { callback_query_id: query.id, text }).catch(() => null);
  const member = await team.getMember(query.from.id);
  if (!member || !team.can(member, "os.access")) { await answer("Нет доступа"); return true; }
  const actor = { name: member.name || member.role_label, id: member.id };
  const [, action, id] = m;
  if (action === "c") {
    await require("./conversations").open(query.from.id, "task_comment", { task_id: id }, 3600);
    await answer("Напишите комментарий");
    const t = (await load()).find((x) => x.id === id);
    await telegram("sendMessage", { chat_id: query.from.id, text: `Напишите комментарий к задаче «${t ? t.title : ""}» одним сообщением.` });
    return true;
  }
  if (!team.can(member, "tasks.edit")) { await answer("Нет прав менять задачи"); return true; }
  const r = await setStatus(id, action === "d" ? "done" : "doing", actor);
  if (r.status !== 200) { await answer(r.errors[0]); return true; }
  await answer(action === "d" ? "Отмечено: выполнено ✅" : "Взяла в работу");
  if (query.message) {
    try { await telegram("editMessageText", { chat_id: query.message.chat.id, message_id: query.message.message_id, text: taskText(r.task), reply_markup: taskButtons(r.task) }); } catch { /* message too old */ }
  }
  if (action === "d") {
    await require("./conversations").open(query.from.id, "task_comment", { task_id: id }, 3600);
    await telegram("sendMessage", { chat_id: query.from.id, text: "Спасибо! Если хотите, напишите коротко результат — он придёт вместе с уведомлением в историю задачи." });
  }
  return true;
}

async function handleCommentReply(message, state) {
  await require("./conversations").close(message.from.id);
  const member = await team.getMember(message.from.id);
  if (!member) return false;
  const r = await addComment(state.task_id, message.text, { name: member.name || member.role_label, id: member.id });
  await telegram("sendMessage", { chat_id: message.chat.id, text: r.status === 200 ? "Комментарий добавлен 🤍" : r.errors[0] });
  return true;
}

// ---------- reminders and summary ----------

// Morning: deadline tomorrow and overdue tasks → their assignee (once a day each).
async function runDeadlineReminders(now = Date.now()) {
  const today = mskDay(now);
  const tomorrow = mskDay(now + 864e5);
  const members = await team.listMembers();
  let sent = 0;
  for (const t of (await load()).filter((x) => x.status !== "done" && x.due && x.due <= tomorrow)) {
    const m = members.find((x) => clean(x.name).toLowerCase() === clean(t.owner).toLowerCase() && clean(t.owner));
    if (!m) continue;
    if (!(await store.claimOnce(`task-remind:${t.id}:${today}`, 2 * 86400))) continue;
    const head = t.due === tomorrow ? "⏰ Завтра дедлайн" : t.due === today ? "⏰ Сегодня дедлайн" : "⚠️ Задача просрочена";
    try { await telegram("sendMessage", { chat_id: m.id, text: `${head}\n${taskText(t, today)}`, reply_markup: taskButtons(t) }); sent += 1; } catch { /* never started the bot */ }
  }
  return { sent };
}

function weekStart(now) {
  const today = mskDay(now);
  const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
  return mskDay(now - ((wd + 6) % 7) * 864e5);
}

async function buildSummary(now = Date.now()) {
  const list = await load();
  const today = mskDay(now);
  const from = weekStart(now);
  const nextWeekEnd = mskDay(now + 9 * 864e5);
  const done = list.filter((t) => t.status === "done" && t.done_at && mskDay(new Date(t.done_at).getTime()) >= from);
  const open = list.filter((t) => t.status !== "done");
  const late = open.filter((t) => t.due && t.due < today);
  const doing = open.filter((t) => t.status === "doing");
  const upcoming = open.filter((t) => t.due && t.due >= today && t.due <= nextWeekEnd).sort(sortOpen);
  const noDue = open.filter((t) => !t.due).length;
  const byOwner = {};
  for (const t of open) { const k = t.owner || "без ответственного"; byOwner[k] = (byOwner[k] || 0) + 1; }
  const line = (t) => `• ${t.title}${t.owner ? ` — ${t.owner}` : ""}${t.due ? ` (${human(t.due)})` : ""}`;
  const block = (title, items, max = 10) => (items.length ? ["", `${title} (${items.length}):`, ...items.slice(0, max).map(line), items.length > max ? `• и ещё ${items.length - max}` : null] : []);
  return [
    "📋 Сводка задач за неделю «к Женщине»",
    `Выполнено: ${done.length} · в работе: ${doing.length} · открыто всего: ${open.length}${late.length ? ` · просрочено: ${late.length}` : ""}`,
    ...block("✅ Выполнено на этой неделе", done),
    ...block("⚠️ Просрочено", late),
    ...block("🔸 В работе", doing),
    ...block("📅 Дедлайны на следующей неделе", upcoming),
    noDue ? `\nБез дедлайна: ${noDue} — стоит поставить сроки.` : null,
    "", "Открытые задачи по людям: " + Object.entries(byOwner).map(([k, v]) => `${k} — ${v}`).join(", "),
    "", "Подробнее: /dashboard → «Задачи»"
  ].filter((l) => l !== null).join("\n");
}

// Friday evening: the summary to the owner(s) and everyone who can see analytics (the director).
async function runWeeklySummary(now = Date.now()) {
  const today = mskDay(now);
  if (new Date(`${today}T12:00:00Z`).getUTCDay() !== 5) return { skipped: "not friday" };
  if (!(await store.claimOnce(`tasks-summary:${today}`, 10 * 86400))) return { skipped: "sent" };
  const text = await buildSummary(now);
  const people = (await team.listMembers()).filter((m) => m.role === "owner" || (team.can(m, "analytics.view") && team.can(m, "os.access")));
  let sent = 0;
  for (const p of people) { try { await telegram("sendMessage", { chat_id: p.id, text }); sent += 1; } catch { /* never started the bot */ } }
  return { sent };
}

module.exports = { STATUSES, load, saveTask, setStatus, addComment, removeTask, handleCommand, handleCallback, handleCommentReply, runDeadlineReminders, runWeeklySummary, buildSummary, taskText };
