// Dashboard: team tasks (with blockers) and manual calendar entries
// (Varvara's shoots, consultations, media appearances, other events).
const crypto = require("crypto");
const store = require("./store");

const TASKS_KEY = "os:tasks";
const CALENDAR_KEY = "os:calendar";
const CALENDAR_TYPES = { shoot: "Съёмка", consult: "Консультация", media: "Медийный выход", event: "Событие", training: "Обучение Мастеров", other: "Другое" };

const clean = (value, max = 200) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const newId = () => crypto.randomBytes(5).toString("hex");

async function load(key) {
  const raw = await store.command("GET", key);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
const save = (key, list) => store.command("SET", key, JSON.stringify(list)).then(() => list);

// ---------- tasks ----------

function normalizeTask(src) {
  const errors = [];
  const title = clean(src && src.title, 200);
  const due = clean(src && src.due, 10);
  if (!title) errors.push("Опишите задачу");
  if (due && !isDate(due)) errors.push("Срок в формате ГГГГ-ММ-ДД");
  return { errors, task: { title, owner: clean(src && src.owner, 80), due: due || null, blocker: Boolean(src && src.blocker), done: Boolean(src && src.done) } };
}

async function saveTask(input, by) {
  const { errors, task } = normalizeTask(input);
  if (errors.length) return { status: 400, errors };
  const list = await load(TASKS_KEY);
  const at = new Date().toISOString();
  if (input.id) {
    const i = list.findIndex((t) => t.id === input.id);
    if (i === -1) return { status: 404, errors: ["Задача не найдена"] };
    list[i] = { ...list[i], ...task, done_at: task.done ? list[i].done_at || at : null, updated_at: at };
  } else {
    list.push({ id: newId(), ...task, created_by: by, created_at: at, updated_at: at, done_at: task.done ? at : null });
  }
  // Finished tasks are kept for two weeks, then dropped.
  const cutoff = Date.now() - 14 * 864e5;
  return { status: 200, tasks: await save(TASKS_KEY, list.filter((t) => !t.done || new Date(t.done_at || 0).getTime() > cutoff)) };
}

async function removeTask(id) {
  return { status: 200, tasks: await save(TASKS_KEY, (await load(TASKS_KEY)).filter((t) => t.id !== id)) };
}

// ---------- calendar ----------

function normalizeEntry(src) {
  const errors = [];
  const date = clean(src && src.date, 10);
  const time = clean(src && src.time, 5);
  const title = clean(src && src.title, 160);
  if (!isDate(date)) errors.push("Дата в формате ГГГГ-ММ-ДД");
  if (time && !/^\d{2}:\d{2}$/.test(time)) errors.push("Время в формате ЧЧ:ММ");
  if (!title) errors.push("Укажите название");
  const type = CALENDAR_TYPES[src && src.type] ? src.type : "other";
  return { errors, entry: { date, time, title, type, place: clean(src && src.place, 160), notes: clean(src && src.notes, 600), varvara: Boolean(src && src.varvara) } };
}

async function saveEntry(input, by) {
  const { errors, entry } = normalizeEntry(input);
  if (errors.length) return { status: 400, errors };
  const list = await load(CALENDAR_KEY);
  if (input.id) {
    const i = list.findIndex((e) => e.id === input.id);
    if (i === -1) return { status: 404, errors: ["Запись не найдена"] };
    list[i] = { ...list[i], ...entry };
  } else {
    list.push({ id: newId(), ...entry, created_by: by });
  }
  // Entries older than a year are dropped.
  const cutoff = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  return { status: 200, entries: await save(CALENDAR_KEY, list.filter((e) => e.date >= cutoff)) };
}

async function removeEntry(id) {
  return { status: 200, entries: await save(CALENDAR_KEY, (await load(CALENDAR_KEY)).filter((e) => e.id !== id)) };
}

module.exports = {
  CALENDAR_TYPES,
  loadTasks: () => load(TASKS_KEY), saveTask, removeTask,
  loadEntries: () => load(CALENDAR_KEY), saveEntry, removeEntry
};
