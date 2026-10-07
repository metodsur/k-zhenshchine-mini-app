// Cycles of the multidimensionality path: 6 meetings in ~2 months, one city, one Master,
// up to 15 women, up to 5 cycles in parallel. One cycle per city can be "в приложении":
// its dates, venue and seats become the city's schedule in the Mini App, and
// purchases made then are attributed to it (order.cycle_id).
const crypto = require("crypto");
const store = require("./store");
const schedule = require("./schedule");
const stats = require("./stats");
const orders = require("./orders");

const KEY = "cycles:v1";
const DEFAULT_CAPACITY = 15;
const MAX_PARALLEL = 5;
const STATUSES = { planned: "Планируется", selling: "Набор", running: "Идёт", done: "Завершён", cancelled: "Отменён" };
const ACTIVE = ["planned", "selling", "running"];

const clean = (value, max = 200) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);

async function loadCycles() {
  const raw = await store.command("GET", KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

async function saveCycles(list) {
  await store.command("SET", KEY, JSON.stringify(list));
  return list;
}

function normalizeCycle(input, cityIds) {
  const errors = [];
  const src = input && typeof input === "object" ? input : {};
  const cityId = clean(src.city_id, 40);
  if (!cityIds.includes(cityId)) errors.push("Выберите город (новые города добавляются в админке приложения → Встречи)");
  const status = STATUSES[src.status] ? src.status : "planned";
  const capRaw = src.capacity === "" || src.capacity == null ? DEFAULT_CAPACITY : Math.round(Number(src.capacity));
  if (!(capRaw >= 1 && capRaw <= 30)) errors.push("Мест в группе — от 1 до 30");
  const meetings = {};
  for (const mid of schedule.MEETING_IDS) {
    const m = (src.meetings && src.meetings[mid]) || {};
    const date = clean(m.date, 10);
    const time = clean(m.time, 5);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`Встреча ${mid}: дата в формате ГГГГ-ММ-ДД`);
    if (time && !/^\d{2}:\d{2}$/.test(time)) errors.push(`Встреча ${mid}: время в формате ЧЧ:ММ`);
    if (time && !date) errors.push(`Встреча ${mid}: время указано без даты`);
    meetings[mid] = { date, time };
  }
  const dates = schedule.MEETING_IDS.map((mid) => meetings[mid].date).filter(Boolean);
  for (let i = 1; i < dates.length; i += 1) {
    if (dates[i] < dates[i - 1]) { errors.push("Даты встреч должны идти по порядку: 1 → 6"); break; }
  }
  return {
    errors,
    cycle: {
      city_id: cityId,
      title: clean(src.title, 80),
      status,
      capacity: capRaw,
      master: { name: clean(src.master && src.master.name, 80), contact: clean(src.master && src.master.contact, 120) },
      master_id: /^\d{3,15}$/.test(String(src.master_id || "")) ? String(src.master_id) : null,
      venue: clean(src.venue, 120),
      address: clean(src.address, 240),
      notes: String(src.notes == null ? "" : src.notes).trim().slice(0, 2000),
      meetings
    }
  };
}

// Paid orders grouped by cycle (orders made before cycles existed have no cycle_id).
async function paidOrders() {
  const ids = (await store.command("SMEMBERS", stats.KEYS.paidOrders)) || [];
  if (!ids.length) return [];
  const raws = (await store.command("MGET", ...ids.map((id) => `order:${id}`))) || [];
  return raws.filter(Boolean).map((raw) => JSON.parse(raw)).filter((o) => o.status === "paid");
}

function cycleStats(cycle, paid) {
  const own = paid.filter((o) => o.cycle_id === cycle.id);
  const perMeeting = Object.fromEntries(schedule.MEETING_IDS.map((mid) => [mid, 0]));
  const women = new Map();
  for (const o of own) {
    for (const mid of orders.meetingsOf(o)) perMeeting[mid] += 1;
    const w = women.get(String(o.user_id)) || { user_id: String(o.user_id), name: o.name, username: o.username, phone: o.phone || null, email: o.email || null, paid: 0, package: false, meetings: [] };
    w.paid += o.amount;
    if (o.kind === "package") w.package = true;
    w.meetings = [...new Set([...w.meetings, ...orders.meetingsOf(o)])].sort();
    women.set(String(o.user_id), w);
  }
  const fullest = Math.max(0, ...Object.values(perMeeting));
  return {
    participants: [...women.values()],
    seats_by_meeting: perMeeting,
    revenue: own.reduce((a, o) => a + o.amount, 0),
    free_seats: Math.max(0, cycle.capacity - fullest)
  };
}

// Full view for the dashboard: each cycle with its city, publication state and participants.
async function overview(withContacts, onlyMasterId = null) {
  const [all, doc, paid] = await Promise.all([loadCycles(), schedule.loadSchedule(), paidOrders()]);
  const list = onlyMasterId ? all.filter((c) => c.master_id === String(onlyMasterId)) : all;
  const cycles = list.map((cycle) => {
    const city = schedule.findCity(doc, cycle.city_id);
    const published = Boolean(city && city.cycle_id === cycle.id);
    // While a cycle is in the app, the app schedule is the truth (dates may be edited on the phone).
    const meetings = published
      ? Object.fromEntries(schedule.MEETING_IDS.map((mid) => [mid, { date: city.meetings[mid].date || "", time: city.meetings[mid].time || "" }]))
      : cycle.meetings;
    const s = cycleStats(cycle, paid);
    const attendance = cycle.attendance || {};
    s.participants = s.participants.map((p) => ({ ...p, attended: schedule.MEETING_IDS.filter((mid) => (attendance[mid] || []).includes(p.user_id)) }));
    if (!withContacts) s.participants = s.participants.map((p) => ({ ...p, phone: null, email: null }));
    const starts = schedule.MEETING_IDS.map((mid) => (city ? schedule.meetingStart(meetings[mid], city.timezone) : null));
    return {
      ...cycle, meetings, published, attendance,
      city_name: city ? city.name : cycle.city_id,
      timezone: city ? city.timezone : "Europe/Moscow",
      starts_at: starts.map((t) => (t === null ? null : new Date(t).toISOString())),
      ...s
    };
  });
  const unassigned = paid.filter((o) => !o.cycle_id && o.kind !== "training").length;
  const active = cycles.filter((c) => ACTIVE.includes(c.status)).length;
  return {
    cycles, unassigned_orders: unassigned, active, max_parallel: MAX_PARALLEL,
    cities: doc.cities.map((c) => ({ id: c.id, name: c.name, cycle_id: c.cycle_id || null })),
    statuses: STATUSES, capacity_default: DEFAULT_CAPACITY
  };
}

async function saveCycle(input, existingId) {
  const doc = await schedule.loadSchedule();
  const { errors, cycle } = normalizeCycle(input, doc.cities.map((c) => c.id));
  if (errors.length) return { status: 400, errors };
  const list = await loadCycles();
  const at = new Date().toISOString();
  if (existingId) {
    const index = list.findIndex((c) => c.id === existingId);
    if (index === -1) return { status: 404, errors: ["Цикл не найден"] };
    const city = schedule.findCity(doc, list[index].city_id);
    if (city && city.cycle_id === existingId && cycle.city_id !== list[index].city_id) {
      return { status: 400, errors: ["Цикл сейчас в приложении — сначала снимите его с публикации, потом меняйте город"] };
    }
    list[index] = { ...list[index], ...cycle, updated_at: at };
  } else {
    list.push({ id: crypto.randomBytes(5).toString("hex"), ...cycle, created_at: at, updated_at: at });
  }
  await saveCycles(list);
  const saved = existingId ? list.find((c) => c.id === existingId) : list[list.length - 1];
  // A published cycle keeps the app in sync with what was just saved.
  const city = schedule.findCity(doc, saved.city_id);
  let notified = 0;
  if (city && city.cycle_id === saved.id) notified = (await publish(saved.id)).notified || 0;
  const active = list.filter((c) => ACTIVE.includes(c.status)).length;
  return { status: 200, cycle: saved, notified, warning: active > MAX_PARALLEL ? `Активных циклов: ${active} — больше ${MAX_PARALLEL} параллельных` : null };
}

// Who was present at a meeting (marked by the Master or the director).
async function markAttendance(id, mid, present) {
  if (!schedule.MEETING_IDS.includes(String(mid))) return { status: 400, errors: ["Неизвестная встреча"] };
  const list = await loadCycles();
  const cycle = list.find((c) => c.id === id);
  if (!cycle) return { status: 404, errors: ["Цикл не найден"] };
  cycle.attendance = { ...(cycle.attendance || {}), [mid]: [...new Set((Array.isArray(present) ? present : []).map(String))].slice(0, 100) };
  cycle.updated_at = new Date().toISOString();
  await saveCycles(list);
  return { status: 200, cycle };
}

// Puts the cycle into the Mini App as its city's schedule (replacing the cycle that was there).
async function publish(id) {
  const list = await loadCycles();
  const cycle = list.find((c) => c.id === id);
  if (!cycle) return { status: 404, errors: ["Цикл не найден"] };
  if (!ACTIVE.includes(cycle.status)) return { status: 400, errors: ["В приложение можно поставить только активный цикл (планируется, набор или идёт)"] };
  const before = await schedule.loadSchedule();
  const next = JSON.parse(JSON.stringify(before));
  const city = schedule.findCity(next, cycle.city_id);
  if (!city) return { status: 400, errors: ["Город цикла не найден в расписании"] };
  for (const mid of schedule.MEETING_IDS) {
    city.meetings[mid] = {
      ...city.meetings[mid],
      date: cycle.meetings[mid].date, time: cycle.meetings[mid].time,
      venue: cycle.venue || city.meetings[mid].venue, address: cycle.address || city.meetings[mid].address,
      seats: cycle.capacity
    };
  }
  if (!city.organizer || !city.organizer.name) city.organizer = { name: cycle.master.name, contact: cycle.master.contact };
  city.cycle_id = cycle.id;
  const saved = await schedule.saveSchedule(next);
  const { newlyDated, notifyWaitlists } = require("./handlers/admin-schedule");
  const notified = await notifyWaitlists(newlyDated(before, saved));
  return { status: 200, notified };
}

// Takes the cycle out of the app: the city's meetings go back to "Дата скоро появится".
async function unpublish(id) {
  const doc = await schedule.loadSchedule();
  const city = doc.cities.find((c) => c.cycle_id === id);
  if (!city) return { status: 200 };
  for (const mid of schedule.MEETING_IDS) city.meetings[mid] = { ...city.meetings[mid], date: "", time: "" };
  city.cycle_id = null;
  await schedule.saveSchedule(doc);
  return { status: 200 };
}

module.exports = { STATUSES, ACTIVE, MAX_PARALLEL, DEFAULT_CAPACITY, loadCycles, normalizeCycle, overview, saveCycle, publish, unpublish, paidOrders, markAttendance };
