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
    const msg = `💬 Новый комментарий к задаче`;
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

const cabinetLine = "Ответьте на это сообщение — это будет комментарий к задаче.";

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
    try { await sendCard(id, task, `${text}\n\n${cabinetLine}\n———`); } catch { /* never started the bot */ }
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

// ---------- bot: /tasks, /task and buttons ----------
// Everything can be done from the bot: list, open a task, status, comment (button or a plain reply
// to any task message), assignee, deadline, and new tasks. It is the same list as the dashboard.

const msgKey = (chatId, messageId) => `tmsg:${chatId}:${messageId}`;

// Sends a task message and remembers which task it is about, so a reply becomes a comment.
async function sendCard(chatId, task, head) {
  const sent = await telegram("sendMessage", { chat_id: chatId, text: taskHtml(task, mskDay(), head), parse_mode: "HTML", reply_markup: taskButtons(task) });
  if (sent && sent.message_id) { try { await store.command("SET", msgKey(chatId, sent.message_id), task.id, "EX", 60 * 86400); } catch { /* replies just won't map */ } }
  return sent;
}

function taskButtons(task) {
  const rows = [];
  if (task.status !== "done") {
    const row = [];
    if (task.status === "todo") row.push({ text: "▶️ В работу", callback_data: `t:w:${task.id}` });
    row.push({ text: "✅ Выполнено", callback_data: `t:d:${task.id}` });
    rows.push(row);
  }
  rows.push([{ text: "💬 Комментарий", callback_data: `t:c:${task.id}` }]);
  if (task.status !== "done") rows.push([{ text: "👤 Кому", callback_data: `t:p:${task.id}` }, { text: "📅 Срок", callback_data: `t:s:${task.id}` }]);
  return { inline_keyboard: rows };
}

function taskText(t, today = mskDay()) {
  const late = t.due && t.due < today && t.status !== "done";
  const done = (t.checklist || []).filter((c) => c.done).length;
  return [
    `${t.status === "done" ? "✅" : t.status === "doing" ? "🔸" : "▫️"} ${t.title}`,
    [t.owner ? `👤 ${t.owner}` : "👤 не назначена", t.area, STATUSES[t.status], t.due ? `дедлайн ${human(t.due)}${late ? " — просрочено" : ""}` : "без дедлайна"].filter(Boolean).join(" · "),
    t.description ? t.description.slice(0, 600) : null,
    t.checklist && t.checklist.length ? `Чек-лист: ${done} из ${t.checklist.length}` : null,
    t.comments && t.comments.length ? `💬 ${t.comments.slice(-1)[0].by}: ${t.comments.slice(-1)[0].text.slice(0, 300)}${t.comments.length > 1 ? ` (комментариев: ${t.comments.length})` : ""}` : null
  ].filter(Boolean).join("\n");
}

const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Card text for Telegram (HTML): the latest comment stands out in bold.
function taskHtml(t, today = mskDay(), head = "") {
  const c = (t.comments || []).slice(-1)[0];
  const base = taskText({ ...t, comments: [] }, today);
  return `${head ? `${esc(head)}\n` : ""}${esc(base)}${c ? `\n\n💬 <b>${esc(c.by)}: ${esc(c.text.slice(0, 600))}</b>${t.comments.length > 1 ? `\n<i>комментариев: ${t.comments.length}</i>` : ""}` : ""}`;
}

const sortOpen = (a, b) => (a.status === "doing" ? 0 : 1) - (b.status === "doing" ? 0 : 1) || String(a.due || "9").localeCompare(String(b.due || "9"));
const short = (v, n) => (v.length > n ? v.slice(0, n - 1) + "…" : v);
const NEW_BUTTON = { text: "➕ Новая задача", callback_data: "t:n" };

async function teamMember(userId) {
  const member = await team.getMember(userId);
  return member && team.can(member, "os.access") ? member : null;
}
const actorOf = (member) => ({ name: member.name || member.role_label, id: member.id });

// Every private text message from the team goes through here first.
async function handleCommand(message) {
  if (!message || !message.chat || message.chat.type !== "private" || typeof message.text !== "string" || !message.from) return false;
  const text = message.text.trim();
  if (/^\/tasks(@\w+)?(\s|$)/.test(text)) return listCommand(message);
  const newCmd = /^\/(task|newtask|задача)(@\w+)?(\s+|$)([\s\S]*)$/i.exec(text);
  if (newCmd) {
    const member = await teamMember(message.from.id);
    if (!member) return false;
    if (!team.can(member, "tasks.edit")) { await telegram("sendMessage", { chat_id: message.chat.id, text: "Создавать задачи может команда с доступом к задачам." }); return true; }
    if (newCmd[4].trim()) return createFromText(message.chat.id, newCmd[4], member);
    await require("./conversations").open(message.from.id, "task_new", {}, 3600);
    await telegram("sendMessage", { chat_id: message.chat.id, text: "Напишите задачу одним сообщением.\nПервая строка — название, дальше (необязательно) — подробности." });
    return true;
  }
  if (text.startsWith("/")) return false;
  // A reply to any task message = a comment to that task.
  const reply = message.reply_to_message;
  if (reply && reply.message_id) {
    const taskId = await store.command("GET", msgKey(message.chat.id, reply.message_id));
    if (taskId) {
      const member = await teamMember(message.from.id);
      if (member) {
        const r = await addComment(taskId, text, actorOf(member));
        await telegram("sendMessage", { chat_id: message.chat.id, text: r.status === 200 ? "Комментарий добавлен 💬 Он уже виден в кабинете." : r.errors[0] });
        return true;
      }
    }
  }
  const state = await require("./conversations").get(message.from.id);
  if (state && state.topic === "task_comment") return handleCommentReply(message, state);
  if (state && state.topic === "task_new") {
    const member = await teamMember(message.from.id);
    if (!member) return false;
    await require("./conversations").close(message.from.id);
    return createFromText(message.chat.id, text, member);
  }
  return false;
}

async function createFromText(chatId, raw, member) {
  const lines = String(raw).split("\n").map((l) => l.trim()).filter(Boolean);
  const r = await saveTask({ title: lines[0] || "", description: lines.slice(1).join("\n") }, actorOf(member));
  if (r.status !== 200) { await telegram("sendMessage", { chat_id: chatId, text: r.errors[0] }); return true; }
  await telegram("sendMessage", { chat_id: chatId, text: `Задача создана ✅ Она уже в кабинете.\n\n«${r.task.title}»\n\nКому назначить?`, reply_markup: await assigneeKeyboard(r.task, true) });
  return true;
}

async function assigneeKeyboard(task, fresh = false) {
  const members = (await team.listMembers()).filter((m) => m.name && m.role !== "master");
  const rows = [];
  for (let i = 0; i < members.length; i += 2) rows.push(members.slice(i, i + 2).map((m) => ({ text: short(m.name, 28), callback_data: `t:a:${task.id}:${m.id}` })));
  rows.push([{ text: fresh ? "Пока без ответственного" : "Снять ответственного", callback_data: `t:a:${task.id}:0` }]);
  if (!fresh) rows.push([{ text: "← Назад", callback_data: `t:o:${task.id}` }]);
  return { inline_keyboard: rows };
}

function deadlineKeyboard(task) {
  return { inline_keyboard: [
    [{ text: "Сегодня", callback_data: `t:u:${task.id}:0` }, { text: "Завтра", callback_data: `t:u:${task.id}:1` }],
    [{ text: "В пятницу", callback_data: `t:u:${task.id}:5` }, { text: "Через неделю", callback_data: `t:u:${task.id}:7` }],
    [{ text: "Без дедлайна", callback_data: `t:u:${task.id}:9` }, { text: "← Назад", callback_data: `t:o:${task.id}` }]
  ] };
}

function dueFrom(code, now = Date.now()) {
  if (code === "9") return null;
  if (code === "5") { const today = mskDay(now); const wd = new Date(`${today}T12:00:00Z`).getUTCDay(); return mskDay(now + (((5 - wd) + 7) % 7) * 864e5); }
  return mskDay(now + Number(code) * 864e5);
}

async function listCommand(message) {
  const member = await teamMember(message.from.id);
  if (!member) {
    await telegram("sendMessage", { chat_id: message.chat.id, text: "Задачи доступны команде «к Женщине»." });
    return true;
  }
  const list = (await load()).filter((t) => t.status !== "done");
  const mine = list.filter((t) => clean(t.owner).toLowerCase() === clean(member.name).toLowerCase() && clean(member.name)).sort(sortOpen);
  const lead = member.role === "owner" || team.can(member, "analytics.view");
  const canEdit = team.can(member, "tasks.edit");
  const today = mskDay();
  if (lead) {
    // Owner and director: the whole team person by person, then every task as a button.
    for (const text of await teamOverview(list, today)) await telegram("sendMessage", { chat_id: message.chat.id, text });
    const sorted = list.slice().sort((a, b) => clean(a.owner).localeCompare(clean(b.owner)) || sortOpen(a, b));
    const rows = sorted.slice(0, 60).map((t) => [{ text: short(`${t.status === "doing" ? "🔸" : "▫️"} ${t.owner ? `${t.owner}: ` : ""}${t.title}`, 60), callback_data: `t:o:${t.id}` }]);
    if (canEdit) rows.push([NEW_BUTTON]);
    await telegram("sendMessage", { chat_id: message.chat.id, text: list.length ? "Нажмите на задачу, чтобы открыть её: комментарий, статус, ответственный, срок." + (list.length > 60 ? `\nПоказаны первые 60 из ${list.length}.` : "") : "Открытых задач нет.", reply_markup: { inline_keyboard: rows } });
    return true;
  }
  await telegram("sendMessage", { chat_id: message.chat.id, text: mine.length ? `Ваши открытые задачи: ${mine.length}\nЧтобы оставить комментарий — ответьте на сообщение с задачей или нажмите «💬 Комментарий».` : "У вас нет открытых задач 🤍", reply_markup: canEdit ? { inline_keyboard: [[NEW_BUTTON]] } : undefined });
  for (const t of mine.slice(0, 15)) await sendCard(message.chat.id, t);
  if (mine.length > 15) await telegram("sendMessage", { chat_id: message.chat.id, text: `И ещё ${mine.length - 15} — в кабинете (/dashboard → «Задачи»).` });
  return true;
}
// Team overview for /tasks: every person with her open tasks (split to fit Telegram's 4096 limit).
async function teamOverview(list, today) {
  const members = await team.listMembers();
  const done7 = (await load()).filter((t) => t.status === "done" && t.done_at && Date.now() - new Date(t.done_at).getTime() < 7 * 864e5);
  const late = list.filter((t) => t.due && t.due < today);
  const groups = new Map();
  for (const m of members) if (m.name && m.role !== "master") groups.set(clean(m.name).toLowerCase(), { name: m.name, items: [] });
  for (const t of list) {
    const k = clean(t.owner).toLowerCase() || "—";
    if (!groups.has(k)) groups.set(k, { name: t.owner || "Без ответственного", items: [] });
    groups.get(k).items.push(t);
  }
  const head = [`📋 Задачи команды`, `Открыто: ${list.length} · в работе: ${list.filter((t) => t.status === "doing").length}${late.length ? ` · просрочено: ${late.length}` : ""} · выполнено за 7 дней: ${done7.length}`].join("\n");
  const blocks = [...groups.values()].sort((a, b) => b.items.length - a.items.length).map((g) => {
    const items = g.items.sort(sortOpen);
    const gl = items.filter((t) => t.due && t.due < today).length;
    const lines = [`👤 ${g.name} — ${items.length ? `${items.length} ${items.length === 1 ? "задача" : items.length < 5 ? "задачи" : "задач"}` : "нет открытых задач"}${items.filter((t) => t.status === "doing").length ? ` · в работе ${items.filter((t) => t.status === "doing").length}` : ""}${gl ? ` · ⚠️ просрочено ${gl}` : ""}`];
    for (const t of items.slice(0, 12)) lines.push(`${t.status === "doing" ? "🔸" : "▫️"} ${t.title} — ${t.due ? `${human(t.due)}${t.due < today ? " ⚠️" : ""}` : "без дедлайна"}`);
    if (items.length > 12) lines.push(`… и ещё ${items.length - 12}`);
    return lines.join("\n");
  });
  const messages = [];
  let cur = head;
  for (const b of blocks) {
    if ((cur + "\n\n" + b).length > 3800) { messages.push(cur); cur = b; } else cur += "\n\n" + b;
  }
  messages.push(cur);
  return messages;
}

// Inline buttons under task messages.
async function handleCallback(query) {
  const m = /^t:([a-z])(?::([a-f0-9]{10}))?(?::(\d+))?$/.exec(String(query.data || ""));
  if (!m) return false;
  const answer = (text) => telegram("answerCallbackQuery", { callback_query_id: query.id, text }).catch(() => null);
  const member = await teamMember(query.from.id);
  if (!member) { await answer("Нет доступа"); return true; }
  const actor = actorOf(member);
  const [, action, id, arg] = m;
  const chatId = query.message ? query.message.chat.id : query.from.id;
  const edit = async (task, question, markup) => {
    const html = taskHtml(task) + (question ? `\n\n${esc(question)}` : "");
    if (!query.message) return telegram("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", reply_markup: markup || taskButtons(task) });
    try { await telegram("editMessageText", { chat_id: chatId, message_id: query.message.message_id, text: html, parse_mode: "HTML", reply_markup: markup || taskButtons(task) }); }
    catch { /* unchanged or too old */ }
    try { await store.command("SET", msgKey(chatId, query.message.message_id), task.id, "EX", 60 * 86400); } catch { /* ignore */ }
  };
  if (action === "n") {
    if (!team.can(member, "tasks.edit")) { await answer("Нет прав создавать задачи"); return true; }
    await require("./conversations").open(query.from.id, "task_new", {}, 3600);
    await answer("Напишите задачу");
    await telegram("sendMessage", { chat_id: chatId, text: "Напишите задачу одним сообщением.\nПервая строка — название, дальше (необязательно) — подробности." });
    return true;
  }
  const task = (await load()).find((x) => x.id === id);
  if (!task) { await answer("Задача не найдена — возможно, её удалили"); return true; }
  if (action === "o") { await answer(""); await sendCard(chatId, task); return true; }
  if (action === "c") {
    await require("./conversations").open(query.from.id, "task_comment", { task_id: id }, 3600);
    await answer("Напишите комментарий");
    await telegram("sendMessage", { chat_id: chatId, text: `Напишите комментарий к задаче «${task.title}» одним сообщением.` });
    return true;
  }
  if (!team.can(member, "tasks.edit")) { await answer("Нет прав менять задачи"); return true; }
  if (action === "p") { await answer(""); await edit(task, "Кому назначить?", await assigneeKeyboard(task)); return true; }
  if (action === "s") { await answer(""); await edit(task, "Какой срок?", deadlineKeyboard(task)); return true; }
  if (action === "a") {
    const target = arg && arg !== "0" ? (await team.listMembers()).find((x) => String(x.id) === arg) : null;
    const r = await saveTask({ id, owner: target ? target.name : "" }, actor);
    if (r.status !== 200) { await answer(r.errors[0]); return true; }
    await answer(target ? `Назначено: ${target.name}` : "Без ответственного");
    // Right after creating: go on to the deadline.
    const fresh = !task.due && Date.now() - new Date(task.created_at || 0).getTime() < 30 * 60e3 && (task.history || []).length <= 1;
    await edit(r.task, fresh ? "Какой срок?" : null, fresh ? deadlineKeyboard(r.task) : null);
    return true;
  }
  if (action === "u") {
    const r = await saveTask({ id, due: dueFrom(arg) }, actor);
    if (r.status !== 200) { await answer(r.errors[0]); return true; }
    await answer(r.task.due ? `Срок: ${human(r.task.due)}` : "Без дедлайна");
    await edit(r.task);
    return true;
  }
  if (action !== "w" && action !== "d") { await answer(""); return true; }
  const r = await setStatus(id, action === "d" ? "done" : "doing", actor);
  if (r.status !== 200) { await answer(r.errors[0]); return true; }
  await answer(action === "d" ? "Отмечено: выполнено ✅" : "Взяла в работу");
  await edit(r.task);
  if (action === "d") {
    await require("./conversations").open(query.from.id, "task_comment", { task_id: id }, 3600);
    await telegram("sendMessage", { chat_id: chatId, text: "Спасибо! Если хотите, напишите коротко результат — он сохранится комментарием к задаче." });
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
    try { await sendCard(m.id, t, head); sent += 1; } catch { /* never started the bot */ }
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

module.exports = { STATUSES, load, saveTask, setStatus, addComment, removeTask, handleCommand, handleCallback, handleCommentReply, sendCard, runDeadlineReminders, runWeeklySummary, buildSummary, taskText };
