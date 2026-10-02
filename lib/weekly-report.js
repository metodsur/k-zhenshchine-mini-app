// Monday 9:00 Moscow: last week's report to Varvara (the owners) in one bot message.
const team = require("./team");
const crm = require("./crm");
const cycles = require("./cycles");
const collections = require("./os-collections");
const board = require("./os-board");
const tribute = require("./tribute");
const store = require("./store");
const rhythm = require("./os-rhythm");
const reviews = require("./reviews");
const { telegram } = require("./telegram");

const mskDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const rub = (n) => `${Number(n || 0).toLocaleString("ru-RU").replace(/ /g, " ")} ₽`;

async function buildReport(now = Date.now()) {
  const p = rhythm.weekPeriod(now);
  const inWeek = (day) => Boolean(day) && day >= p.from && day <= p.to;
  const isoDay = (iso) => (iso ? mskDay(new Date(iso).getTime()) : "");
  const [cards, view, content, media, tasks, subs, allReviews, marks] = await Promise.all([
    crm.listCards(), cycles.overview(false), collections.load("content"), collections.load("media"), board.loadTasks(),
    tribute.listSubscribers().catch(() => null), reviews.loadReviews(), store.command("GET", `os:rhythm:week:${p.key}`)
  ]);
  const leads = cards.filter((c) => inWeek(isoDay(c.created_at)));
  const bySource = {};
  for (const c of leads) bySource[c.source] = (bySource[c.source] || 0) + 1;
  const top = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s} ${n}`).join(", ");
  const pays = [];
  for (const c of cards) for (const x of c.payments) if (inWeek(isoDay(x.at))) pays.push(x);
  const active = view.cycles.filter((c) => cycles.ACTIVE.includes(c.status));
  const cap = active.reduce((a, c) => a + c.capacity, 0);
  const taken = active.reduce((a, c) => a + (c.capacity - c.free_seats), 0);
  const published = content.filter((c) => ["published", "analyzed"].includes(c.stage) && inWeek(c.publish_date));
  const views = published.reduce((a, c) => a + ((c.metrics && c.metrics.views) || 0), 0);
  const appearances = media.filter((m) => inWeek(m.date));
  const weekReviews = allReviews.filter((r) => inWeek(isoDay(r.at)));
  const avg = weekReviews.length ? Math.round(10 * weekReviews.reduce((a, r) => a + r.score, 0) / weekReviews.length) / 10 : null;
  const blockers = tasks.filter((t) => !t.done && t.blocker);
  let checklist = null;
  try { checklist = Object.keys(JSON.parse(marks || "{}")).length; } catch { checklist = 0; }

  const lines = [
    `📊 Отчёт недели «к Женщине»`, p.label, "",
    `💛 Продажи: лидов ${leads.length}${top ? ` (${top})` : ""} · оплат ${pays.length} на ${rub(pays.reduce((a, x) => a + x.amount, 0))}`,
    subs ? `🌿 Клуб: активных ${subs.filter((s) => s.status === "active").length} · новых за неделю ${subs.filter((s) => inWeek(isoDay(s.activatedAt))).length}` : "🌿 Клуб: нет данных из Tribute",
    `🔆 Циклы: активных ${active.length} · заполнение ${cap ? Math.round((100 * taken) / cap) : 0}% · свободно мест ${active.reduce((a, c) => a + c.free_seats, 0)}`,
    `🎬 Контент: опубликовано ${published.length}${views ? ` · просмотров ${views.toLocaleString("ru-RU").replace(/ /g, " ")}` : ""}`,
    `🎙 Медиа: выходов ${appearances.length} · в работе ${media.filter((m) => ["booked", "preparation"].includes(m.stage)).length}`,
    avg !== null ? `⭐️ Отзывы: ${weekReviews.length}, средняя оценка ${avg}/10` : null,
    blockers.length ? `⛔️ Блокеры: ${blockers.map((t) => t.title).slice(0, 3).join("; ")}` : "✅ Блокеров нет",
    `🗂 Чек-лист недели: отмечено ${checklist} из ${rhythm.WEEK_ITEMS.length}`,
    "", "Подробнее в кабинете: /dashboard → «Итоги»"
  ].filter((l) => l !== null);
  return lines.join("\n");
}

async function runWeeklyReport(now = Date.now()) {
  const today = mskDay(now);
  if (new Date(`${today}T12:00:00Z`).getUTCDay() !== 1) return { skipped: "not monday" };
  const key = rhythm.weekPeriod(now).key;
  if (!(await store.claimOnce(`weekly-report:${key}`, 30 * 86400))) return { skipped: "sent" };
  const text = await buildReport(now);
  const owners = (await team.listMembers()).filter((m) => m.role === "owner");
  let sent = 0;
  for (const o of owners) { try { await telegram("sendMessage", { chat_id: o.id, text }); sent += 1; } catch { /* never started the bot */ } }
  return { sent };
}

module.exports = { buildReport, runWeeklyReport };
