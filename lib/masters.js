// Masters of multidimensionality: training streams (3 meetings, up to 15 students), students who
// bought the training, certified Masters with a public card, and «Зеркало» bookings from the club.
const crypto = require("crypto");
const store = require("./store");

const TRAININGS_KEY = "trainings:v1";
const IDS_KEY = "masters:ids";
const personKey = (id) => `master:${id}`;
const MEETING_IDS = ["1", "2", "3"];
const TRAINING_STATUSES = { planned: "Планируется", selling: "Набор", running: "Идёт", done: "Завершён", cancelled: "Отменён" };
const SPECIALTIES = ["Практика «Зеркало»", "Женский круг", "Встречи многомерности", "Онлайн", "Офлайн"];
const MIRROR_STATUSES = { new: "Новая", confirmed: "Подтверждена", done: "Проведена", cancelled: "Отменена" };

const clean = (v, max = 200) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const cleanText = (v, max = 2000) => String(v == null ? "" : v).trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const nowIso = () => new Date().toISOString();

async function loadJson(key, fallback) {
  const raw = await store.command("GET", key);
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

// ---------- training streams ----------

const loadTrainings = () => loadJson(TRAININGS_KEY, []);

function normalizeTraining(src) {
  const errors = [];
  const s = src && typeof src === "object" ? src : {};
  const title = clean(s.title, 80);
  if (!title) errors.push("Укажите название потока");
  const price = Math.round(Number(s.price));
  if (!(price > 0)) errors.push("Укажите цену обучения");
  const capacity = s.capacity === "" || s.capacity == null ? 15 : Math.round(Number(s.capacity));
  if (!(capacity >= 1 && capacity <= 50)) errors.push("Мест — от 1 до 50");
  const meetings = {};
  for (const mid of MEETING_IDS) {
    const m = (s.meetings && s.meetings[mid]) || {};
    const date = clean(m.date, 10), time = clean(m.time, 5);
    if (date && !isDate(date)) errors.push(`Встреча ${mid}: дата в формате ГГГГ-ММ-ДД`);
    if (time && !/^\d{2}:\d{2}$/.test(time)) errors.push(`Встреча ${mid}: время в формате ЧЧ:ММ`);
    meetings[mid] = { date, time };
  }
  const chat = clean(s.chat_url, 300);
  if (chat && !/^https:\/\/\S+$/.test(chat)) errors.push("Ссылка на чат группы должна начинаться с https://");
  return {
    errors,
    training: {
      title, price, capacity, meetings,
      status: TRAINING_STATUSES[s.status] ? s.status : "planned",
      sell: Boolean(s.sell),
      city: clean(s.city, 60), format: clean(s.format, 60),
      venue: clean(s.venue, 120), address: clean(s.address, 240),
      chat_url: chat,
      curator: { name: clean(s.curator && s.curator.name, 80), contact: clean(s.curator && s.curator.contact, 120) },
      about: cleanText(s.about, 1500)
    }
  };
}

async function saveTraining(input, id) {
  const { errors, training } = normalizeTraining(input);
  if (errors.length) return { status: 400, errors };
  const list = await loadTrainings();
  const at = nowIso();
  let saved;
  if (id) {
    const i = list.findIndex((t) => t.id === id);
    if (i === -1) return { status: 404, errors: ["Поток не найден"] };
    saved = list[i] = { ...list[i], ...training, updated_at: at };
  } else {
    saved = { id: crypto.randomBytes(5).toString("hex"), ...training, created_at: at, updated_at: at };
    list.push(saved);
  }
  await store.command("SET", TRAININGS_KEY, JSON.stringify(list));
  return { status: 200, training: saved };
}

const findTraining = async (id) => (await loadTrainings()).find((t) => t.id === id) || null;

function meetingLabel(m) {
  if (!m || !m.date) return "Дата скоро появится";
  const [y, mo, d] = m.date.split("-").map(Number);
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  return `${d} ${months[mo - 1]}${m.time ? `, ${m.time}` : ""}`;
}

// ---------- people (students and Masters) ----------

async function getPerson(id) {
  if (!/^\d{3,15}$/.test(String(id || ""))) return null;
  return loadJson(personKey(id), null);
}

async function savePerson(p) {
  p.updated_at = nowIso();
  await store.command("SET", personKey(p.id), JSON.stringify(p));
  await store.command("SADD", IDS_KEY, String(p.id));
  return p;
}

async function listPeople() {
  const ids = (await store.command("SMEMBERS", IDS_KEY)) || [];
  if (!ids.length) return [];
  const raws = (await store.command("MGET", ...ids.map(personKey))) || [];
  return raws.filter(Boolean).map((r) => JSON.parse(r));
}

function emptyPerson(id, fields = {}) {
  return {
    id: String(id), name: "", username: null, status: "student", training_id: null,
    enrolled_at: nowIso(), certified_at: null, attendance: [], tasks: {}, final_review: false,
    profile: { city: "", about: "", specialties: [], contact: "", photo_file_id: null, accepting: true, visible: true },
    ...fields
  };
}

// After the training is paid: she becomes a student of that stream (repeat payments do not reset progress).
async function enroll(user, trainingId, source = "payment") {
  let p = await getPerson(user.id);
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  if (!p) p = emptyPerson(user.id, { name: clean(name, 80), username: user.username || null });
  if (!p.name && name) p.name = clean(name, 80);
  if (user.username) p.username = user.username;
  if (p.status !== "master") p.training_id = trainingId || p.training_id;
  p.source = p.source || source;
  return savePerson(p);
}

async function certify(id) {
  const p = await getPerson(id);
  if (!p) return null;
  p.status = "master";
  p.certified_at = p.certified_at || nowIso();
  return savePerson(p);
}

const seatsTaken = async (trainingId) => (await listPeople()).filter((p) => p.training_id === trainingId).length;

// The certification path: what is done and what is left.
function pathOf(person, training, materials) {
  const tasks = materials.filter((m) => m.kind === "task" && m.audience !== "master");
  const doneTasks = tasks.filter((t) => person.tasks && person.tasks[t.id] && person.tasks[t.id].done_at).length;
  const attended = (person.attendance || []).length;
  const steps = [
    { id: "paid", title: "Обучение оплачено", done: true },
    { id: "meetings", title: "Пройдены 3 встречи обучения", done: attended >= 3, note: `${attended} из 3` },
    { id: "tasks", title: "Выполнены задания", done: tasks.length > 0 && doneTasks >= tasks.length, note: `${doneTasks} из ${tasks.length}` },
    { id: "review", title: "Итоговая встреча с куратором", done: Boolean(person.final_review) },
    { id: "master", title: "Статус Мастера многомерности", done: person.status === "master" }
  ];
  return { steps, ready: steps.slice(0, 4).every((s) => s.done), done_count: steps.filter((s) => s.done).length, total: steps.length };
}

function normalizeProfile(src) {
  const s = src && typeof src === "object" ? src : {};
  return {
    city: clean(s.city, 60),
    about: cleanText(s.about, 700),
    specialties: (Array.isArray(s.specialties) ? s.specialties : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 6),
    contact: clean(s.contact, 120),
    accepting: s.accepting !== false,
    visible: s.visible !== false
  };
}

async function saveProfile(id, input) {
  const p = await getPerson(id);
  if (!p) return null;
  p.profile = { ...p.profile, ...normalizeProfile(input) };
  return savePerson(p);
}

async function setPhoto(id, fileId) {
  const p = await getPerson(id);
  if (!p) return null;
  p.profile = { ...p.profile, photo_file_id: String(fileId).slice(0, 300) };
  return savePerson(p);
}

async function markTask(id, materialId, done, answer) {
  const p = await getPerson(id);
  if (!p) return null;
  p.tasks = { ...(p.tasks || {}) };
  if (done) p.tasks[materialId] = { done_at: (p.tasks[materialId] && p.tasks[materialId].done_at) || nowIso(), answer: cleanText(answer, 2000) };
  else delete p.tasks[materialId];
  return savePerson(p);
}

// What the club sees: certified Masters who chose to show their card.
function publicCard(p) {
  return {
    id: p.id, name: p.name, city: p.profile.city, about: p.profile.about, specialties: p.profile.specialties,
    accepting: p.profile.accepting,
    // Own photo sent to the bot first; the owner (Varvara) otherwise has her portrait from the app.
    photo: p.profile.photo_file_id ? `/api/meetings/master-photo?id=${p.id}` : (require("./http").adminIds().includes(String(p.id)) || /^варвара(\s|$)/i.test(String(p.name || "").trim())) ? "/img/varvara-master.webp" : null
  };
}
async function publicMasters() {
  return (await listPeople()).filter((p) => p.status === "master" && p.profile && p.profile.visible && p.name).map(publicCard)
    .sort((a, b) => Number(b.accepting) - Number(a.accepting) || a.name.localeCompare(b.name, "ru"));
}

// ---------- «Зеркало» bookings ----------

const mirrorKey = (id) => `mirror:${id}`;

async function createMirror({ client, masterId, wish, format, contact, comment }) {
  const master = await getPerson(masterId);
  if (!master || master.status !== "master" || !master.profile.visible) return { status: 404, errors: ["Мастер не найдена"] };
  if (!master.profile.accepting) return { status: 409, errors: ["Мастер сейчас не принимает записи — выберите другую"] };
  if (!clean(contact, 120)) return { status: 400, errors: ["Укажите, как с вами связаться"] };
  const b = {
    id: crypto.randomBytes(6).toString("hex"), status: "new",
    client_id: String(client.id), client_name: clean([client.first_name, client.last_name].filter(Boolean).join(" "), 80), username: client.username || null,
    master_id: String(masterId), master_name: master.name,
    wish: clean(wish, 200), format: ["online", "offline"].includes(format) ? format : "online",
    contact: clean(contact, 120), comment: cleanText(comment, 600), created_at: nowIso(), updated_at: nowIso()
  };
  await store.command("SET", mirrorKey(b.id), JSON.stringify(b));
  await store.command("SADD", `mirror:master:${masterId}`, b.id);
  await store.command("SADD", "mirror:ids", b.id);
  return { status: 200, booking: b, master };
}

async function listMirror(masterId) {
  const ids = (await store.command("SMEMBERS", masterId ? `mirror:master:${masterId}` : "mirror:ids")) || [];
  if (!ids.length) return [];
  const raws = (await store.command("MGET", ...ids.map(mirrorKey))) || [];
  return raws.filter(Boolean).map((r) => JSON.parse(r)).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function setMirrorStatus(id, status, masterId, note) {
  const b = await loadJson(mirrorKey(id), null);
  if (!b) return { status: 404, errors: ["Запись не найдена"] };
  if (masterId && b.master_id !== String(masterId)) return { status: 403, errors: ["Это не ваша запись"] };
  if (!MIRROR_STATUSES[status]) return { status: 400, errors: ["Неизвестный статус"] };
  b.status = status;
  if (note !== undefined) b.master_note = cleanText(note, 500);
  b.updated_at = nowIso();
  await store.command("SET", mirrorKey(id), JSON.stringify(b));
  return { status: 200, booking: b };
}

module.exports = {
  MEETING_IDS, TRAINING_STATUSES, SPECIALTIES, MIRROR_STATUSES,
  loadTrainings, saveTraining, findTraining, normalizeTraining, meetingLabel,
  getPerson, savePerson, listPeople, emptyPerson, enroll, certify, seatsTaken, pathOf,
  saveProfile, setPhoto, markTask, publicMasters, publicCard,
  createMirror, listMirror, setMirrorStatus
};
