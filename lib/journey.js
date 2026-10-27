// «Мой путь» on «Обо мне»: where she is on the path of the ecosystem and what she has already lived.
// Stages follow «Путь»: вход (ритуал видимости) → целостность → наполнение (клуб) →
// раскрытие объёма (6 встреч) → проявление (Мастер/Партнёр). Each stage is reached by a fact we know.
const store = require("./store");

const STAGES = [
  { id: "visibility", title: "Видимость" },
  { id: "integrity", title: "Целостность" },
  { id: "filling", title: "Наполнение" },
  { id: "volume", title: "Раскрытие объёма" },
  { id: "manifest", title: "Проявление" }
];
const DAY_MS = 24 * 60 * 60 * 1000;

function reachedStages({ ritualDone, inClub, hasTickets, isMaster }) {
  return [ritualDone, ritualDone || inClub || hasTickets || isMaster, inClub, hasTickets, isMaster];
}

function currentStage(reached) {
  let current = 0;
  reached.forEach((r, i) => { if (r) current = i; });
  return current;
}

async function safely(task, fallback) {
  try { return await task(); } catch { return fallback; }
}

// space, club, tickets, profile, start come from the same /api/auth/me request.
async function build(userId, { space, club, tickets, profile, start }, now = Date.now()) {
  const uid = String(userId);
  const [women, invited, person, collabs] = await Promise.all([
    safely(async () => Number(await store.command("SCARD", `pairs:met:${uid}`)) || 0, 0),
    safely(async () => Number(await store.command("SCARD", `ref:invited:${uid}`)) || 0, 0),
    safely(() => require("./masters").getPerson(uid), null),
    safely(() => require("./collabs").countFor(uid), 0)
  ]);
  const inClub = Boolean(club && (club.member === true || club.status === "active" || club.status === "pre_cancelled"));
  const meetings = (tickets && tickets.passed) || 0;
  const hasTickets = Boolean(tickets && tickets.items && tickets.items.length);
  const reached = reachedStages({ ritualDone: Boolean(start && start.ritual_done), inClub, hasTickets, isMaster: Boolean(person) });
  const current = currentStage(reached);
  const joined = space && space.joined_at ? Date.parse(space.joined_at) : NaN;
  const tasks = (profile && profile.tasks) || [];
  const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
  // Wins the app knows by itself; her own wins are in profile.wins.
  const wins = [
    reached[0] ? "Прошла ритуал видимости — показала себя пространству" : null,
    inClub ? "Вступила в клуб «Наполнение»" : null,
    women ? `Познакомилась в паре с ${women} ${plural(women, "женщиной", "женщинами", "женщинами")}` : null,
    collabs ? `Создала ${collabs} ${plural(collabs, "коллаборацию", "коллаборации", "коллабораций")} в клубе` : null,
    invited ? `Привела в пространство ${invited} ${plural(invited, "подругу", "подруги", "подруг")}` : null,
    meetings ? `Прошла ${meetings} ${plural(meetings, "встречу", "встречи", "встреч")} «Раскрытие многомерного объёма»` : null,
    person ? (person.status === "master" ? "Стала Мастером многомерности" : "Учится на Мастера многомерности") : null
  ].filter(Boolean);
  return {
    wins,
    current,
    stages: STAGES.map((s, i) => ({ ...s, reached: reached[i] })),
    days: Number.isFinite(joined) ? Math.max(1, Math.floor((now - joined) / DAY_MS) + 1) : null,
    meetings,
    women,
    invited,
    collabs,
    tasks_done: tasks.filter((t) => t.done).length,
    facets: ((profile && profile.facets) || []).length,
    master: person ? person.status : null
  };
}

module.exports = { build, STAGES, reachedStages, currentStage };
