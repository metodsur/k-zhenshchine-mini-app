// Club events for "Дальше в пространстве" on the Space page, edited by the owner.
const store = require("./store");

const EVENTS_KEY = "club_events:v1";
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

async function loadEvents() {
  const raw = await store.command("GET", EVENTS_KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

async function saveEvents(events) {
  await store.command("SET", EVENTS_KEY, JSON.stringify(events));
  return events;
}

function normalizeEvents(input) {
  const errors = [];
  const events = (Array.isArray(input) ? input : []).map((e, i) => {
    const date = clean(e && e.date, 10);
    const title = clean(e && e.title, 80);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`Событие ${i + 1}: укажите дату`);
    if (!title) errors.push(`Событие ${i + 1}: укажите название`);
    return { date, title, text: clean(e && e.text, 400) };
  });
  events.sort((a, b) => a.date.localeCompare(b.date));
  return { errors, events };
}

// Today and later (Moscow date), soonest first.
function upcoming(events, now = Date.now()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  return events.filter((e) => e.date >= today).map((e) => ({
    ...e,
    date_label: new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${e.date}T12:00:00Z`))
  }));
}

module.exports = { loadEvents, saveEvents, normalizeEvents, upcoming };
