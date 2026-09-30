// Meetings schedule: 6 meetings × cities, edited on the admin page and stored in Redis.
const store = require("./store");

const SCHEDULE_KEY = "schedule:v1";
const MEETING_IDS = ["1", "2", "3", "4", "5", "6"];
const HOUR_MS = 60 * 60 * 1000;
// A meeting shows as "past" a few hours after it starts; sales close at the start time.
const PAST_AFTER_MS = 6 * HOUR_MS;

const MEETINGS = {
  "1": { title: "Основы", about: "Лекция о природе женщины и женских энергиях, затем телесная практика чистки и разблокировки." },
  "2": { title: "Целостность", about: "Собираем тело, душу и дух в целостность — внутреннюю опору в нестабильном мире." },
  "3": { title: "Опора и объём", about: "Прикасаемся к своему истинному объёму и чувствуем опору на истину внутри себя." },
  "4": { title: "Источник и коллективное поле", about: "Учимся чувствовать коллективное поле и различать, что ваше, а что к вам не относится." },
  "5": { title: "Безусловная любовь и принятие", about: "Поднимаемся к энергиям безусловной любви и принятия, работаем с кристаллической решёткой Земли." },
  "6": { title: "Исходный код", about: "Соединяемся со своей многомерной структурой и первородными кодами женщины." }
};

const DEFAULT_CITIES = [
  { id: "moscow", name: "Москва", timezone: "Europe/Moscow" },
  { id: "krasnoyarsk", name: "Красноярск", timezone: "Asia/Krasnoyarsk" },
  { id: "dubai", name: "Дубай", timezone: "Asia/Dubai" }
];

function emptyMeeting() {
  return { date: "", time: "", venue: "", address: "", seats: null, bring: "", details: "" };
}

function emptyCity(city) {
  const meetings = {};
  for (const id of MEETING_IDS) meetings[id] = emptyMeeting();
  return { id: city.id, name: city.name, timezone: city.timezone || "Europe/Moscow", organizer: { name: "", contact: "" }, meetings };
}

function defaultSchedule() {
  return { prices: { single: 5555, package: 25000 }, cities: DEFAULT_CITIES.map(emptyCity), updated_at: null };
}

// ---------- validation of admin input ----------

const clean = (value, max = 500) => String(value == null ? "" : value).trim().slice(0, max);

function validTimezone(tz) {
  try { new Intl.DateTimeFormat("ru-RU", { timeZone: tz }); return true; } catch { return false; }
}

function normalizeSchedule(input) {
  const errors = [];
  const src = input && typeof input === "object" ? input : {};
  const single = Math.round(Number(src.prices && src.prices.single));
  const pack = Math.round(Number(src.prices && src.prices.package));
  if (!(single > 0)) errors.push("Цена одной встречи должна быть больше нуля");
  if (!(pack > 0)) errors.push("Цена пакета должна быть больше нуля");

  const seen = new Set();
  const cities = (Array.isArray(src.cities) ? src.cities : []).map((city, index) => {
    const name = clean(city && city.name, 60);
    let id = clean(city && city.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!id) id = `city-${index + 1}`;
    if (!name) errors.push(`Город №${index + 1}: укажите название`);
    if (seen.has(id)) errors.push(`Город «${name}» указан дважды`);
    seen.add(id);
    const timezone = clean(city && city.timezone, 60) || "Europe/Moscow";
    if (!validTimezone(timezone)) errors.push(`Город «${name}»: неизвестный часовой пояс ${timezone}`);
    const meetings = {};
    for (const mid of MEETING_IDS) {
      const m = (city && city.meetings && city.meetings[mid]) || {};
      const date = clean(m.date, 10);
      const time = clean(m.time, 5);
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`${name}, встреча ${mid}: дата в формате ГГГГ-ММ-ДД`);
      if (time && !/^\d{2}:\d{2}$/.test(time)) errors.push(`${name}, встреча ${mid}: время в формате ЧЧ:ММ`);
      if (time && !date) errors.push(`${name}, встреча ${mid}: время указано без даты`);
      const seatsRaw = m.seats === "" || m.seats == null ? null : Math.round(Number(m.seats));
      if (seatsRaw !== null && !(seatsRaw >= 0)) errors.push(`${name}, встреча ${mid}: количество мест — целое число`);
      meetings[mid] = {
        date, time,
        venue: clean(m.venue, 120), address: clean(m.address, 240),
        seats: seatsRaw, bring: clean(m.bring, 1000), details: clean(m.details, 1500)
      };
    }
    return {
      id, name, timezone,
      organizer: { name: clean(city && city.organizer && city.organizer.name, 80), contact: clean(city && city.organizer && city.organizer.contact, 200) },
      meetings
    };
  });
  if (!cities.length) errors.push("Нужен хотя бы один город");
  return { errors, schedule: { prices: { single, package: pack }, cities } };
}

// ---------- time helpers ----------

function tzOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - instant;
}

// Start of a meeting as a UTC timestamp; without a time the whole day counts (end of day).
function meetingStart(meeting, timeZone) {
  if (!meeting || !meeting.date) return null;
  const [y, mo, d] = meeting.date.split("-").map(Number);
  const [h, mi] = meeting.time ? meeting.time.split(":").map(Number) : [23, 59];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return guess - tzOffsetMs(guess - tzOffsetMs(guess, timeZone), timeZone);
}

function formatMeetingDate(meeting, timeZone) {
  const start = meetingStart(meeting, timeZone);
  if (start === null) return "Дата скоро появится";
  const day = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone }).format(new Date(start));
  return meeting.time ? `${day}, ${meeting.time}` : day;
}

// ---------- storage ----------

async function loadSchedule() {
  const raw = await store.command("GET", SCHEDULE_KEY);
  if (!raw) return defaultSchedule();
  try { return JSON.parse(raw); } catch { return defaultSchedule(); }
}

async function saveSchedule(schedule) {
  const doc = { ...schedule, updated_at: new Date().toISOString() };
  await store.command("SET", SCHEDULE_KEY, JSON.stringify(doc));
  return doc;
}

const ticketsKey = (cityId, meetingId) => `tickets:${cityId}:${meetingId}`;

async function soldCounts(schedule) {
  const counts = {};
  await Promise.all(schedule.cities.flatMap((city) => MEETING_IDS.map(async (mid) => {
    const n = await store.command("SCARD", ticketsKey(city.id, mid));
    counts[`${city.id}:${mid}`] = Number(n) || 0;
  })));
  return counts;
}

function meetingStatus(meeting, timeZone, sold, now) {
  const start = meetingStart(meeting, timeZone);
  if (start === null) return "soon";
  if (now > start + PAST_AFTER_MS) return "past";
  if (now >= start) return "closed";
  if (meeting.seats !== null && meeting.seats !== undefined && sold >= meeting.seats) return "sold_out";
  return "open";
}

function packageStatus(city, counts, now) {
  const first = city.meetings["1"];
  const status = meetingStatus(first, city.timezone, counts[`${city.id}:1`] || 0, now);
  if (status !== "open") return status === "soon" ? "soon" : "closed";
  const full = MEETING_IDS.some((mid) => {
    const m = city.meetings[mid];
    return m.seats !== null && m.seats !== undefined && (counts[`${city.id}:${mid}`] || 0) >= m.seats;
  });
  return full ? "sold_out" : "open";
}

// What everyone may see: no organizer contacts, no full address, no notes for ticket holders.
function publicView(schedule, counts, now = Date.now()) {
  return {
    prices: schedule.prices,
    updated_at: schedule.updated_at || null,
    meetings: MEETING_IDS.map((id) => ({ id, title: MEETINGS[id].title })),
    cities: schedule.cities.map((city) => ({
      id: city.id,
      name: city.name,
      package_status: packageStatus(city, counts, now),
      meetings: MEETING_IDS.map((mid) => {
        const m = city.meetings[mid];
        const sold = counts[`${city.id}:${mid}`] || 0;
        const status = meetingStatus(m, city.timezone, sold, now);
        return {
          id: mid,
          title: MEETINGS[mid].title,
          status,
          date: m.date || null,
          time: m.time || null,
          date_label: formatMeetingDate(m, city.timezone),
          venue: m.venue || null,
          seats_left: m.seats === null || m.seats === undefined ? null : Math.max(0, m.seats - sold)
        };
      })
    }))
  };
}

function findCity(schedule, cityId) {
  return schedule.cities.find((c) => c.id === cityId) || null;
}

module.exports = {
  MEETINGS, MEETING_IDS, DEFAULT_CITIES,
  defaultSchedule, normalizeSchedule, loadSchedule, saveSchedule, soldCounts,
  meetingStart, formatMeetingDate, meetingStatus, packageStatus, publicView, findCity, ticketsKey
};
