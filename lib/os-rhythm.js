// Weekly and monthly rhythm of the operations director (section 9 of the operating system):
// checklists of what to fill in or check, with automatic checks of the data, a pop-up in the
// dashboard at the end of the week / month and a bot reminder.
const store = require("./store");
const crm = require("./crm");
const cycles = require("./cycles");
const collections = require("./os-collections");
const board = require("./os-board");
const tribute = require("./tribute");
const team = require("./team");
const { telegram } = require("./telegram");

const TZ = "Europe/Moscow";
const DAY_MS = 864e5;
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

// ---------- dates (Moscow) ----------
const mskDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const parse = (day) => { const [y, m, d] = day.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const fmt = (utc) => new Date(utc).toISOString().slice(0, 10);
const addDays = (day, n) => fmt(parse(day) + n * DAY_MS);
const weekday = (day) => new Date(parse(day)).getUTCDay(); // 0 = Sunday
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12
const human = (day) => { const d = new Date(parse(day)); return `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}`; };

// The week being closed: Friday–Sunday → this week; Monday → last week. Key = its Monday.
function weekPeriod(now = Date.now()) {
  const today = mskDay(now);
  const wd = weekday(today);
  const active = [5, 6, 0, 1].includes(wd);
  const thisMonday = addDays(today, -((wd + 6) % 7));
  const monday = wd === 1 ? addDays(thisMonday, -7) : thisMonday;
  const sunday = addDays(monday, 6);
  return { kind: "week", key: monday, from: monday, to: sunday, today, active, label: `Неделя ${human(monday)} — ${human(sunday)}` };
}

// The month being closed: last 3 days of a month → this month; first 3 days → the previous one.
function monthPeriod(now = Date.now()) {
  const today = mskDay(now);
  let [y, m, d] = today.split("-").map(Number);
  const last = daysInMonth(y, m);
  const active = d >= last - 2 || d <= 3;
  if (d <= 3) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
  const key = `${y}-${String(m).padStart(2, "0")}`;
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return {
    kind: "month", key, from: `${key}-01`, to: `${key}-${String(daysInMonth(y, m)).padStart(2, "0")}`, today, active,
    label: `${MONTHS_NOM[m - 1]} ${y}`, next_key: `${ny}-${String(nm).padStart(2, "0")}`, next_label: `${MONTHS_NOM[nm - 1]} ${ny}`
  };
}

const marksKey = (period) => `os:rhythm:${period.kind}:${period.key}`;
const planKey = (monthKey) => `os:plan:${monthKey}`;
async function loadJson(key, fallback) {
  const raw = await store.command("GET", key);
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

// ---------- data shared by the checks ----------
async function gather(canCrm) {
  const [cards, content, media, platforms, library, tasks, entries, cyc, club] = await Promise.all([
    canCrm ? crm.listCards() : Promise.resolve([]),
    collections.load("content"), collections.load("media"), collections.load("platforms"), collections.load("library"),
    board.loadTasks(), board.loadEntries(), cycles.overview(false),
    tribute.listSubscribers().catch(() => null)
  ]);
  return { cards, content, media, platforms, library, tasks, entries, cyc, club, canCrm };
}

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
};
const ok = (text) => ({ status: "ok", text });
const warn = (text, count) => ({ status: "warn", text, count });
const info = (text) => ({ status: "info", text });
const inRange = (day, p) => Boolean(day) && day >= p.from && day <= p.to;
const isoDay = (iso) => (iso ? mskDay(new Date(iso).getTime()) : "");
const OPEN_STAGES = ["new", "contact", "dialog", "offer", "followup"];

const WEEK_ITEMS = [
  { id: "content_metrics", block: "Контент", title: "Внести результаты публикаций", hint: "Просмотры, удержание, досмотры, сохранения, пересылки, подписки — в карточке каждого опубликованного ролика.", view: "content",
    check: (d, p) => {
      const missing = d.content.filter((c) => ["published", "analyzed"].includes(c.stage) && c.publish_date && c.publish_date >= addDays(p.to, -13) && c.publish_date <= p.to && !Object.keys(c.metrics || {}).length);
      return missing.length ? warn(`${missing.length} ${plural(missing.length, "публикация", "публикации", "публикаций")} без результатов`, missing.length) : ok("Результаты внесены");
    } },
  { id: "content_board", block: "Контент", title: "Проверить production board", hint: "Что произведено и опубликовано, кто не уложился в срок, не потерялись ли исходники и монтажи.", view: "content",
    check: (d, p) => {
      const order = Object.keys(collections.SCHEMAS.content.stages);
      const late = d.content.filter((c) => c.due && c.due < p.today && order.indexOf(c.stage) < order.indexOf("published"));
      const published = d.content.filter((c) => ["published", "analyzed"].includes(c.stage) && inRange(c.publish_date, p)).length;
      return late.length ? warn(`Просрочено: ${late.length} · опубликовано за неделю: ${published}`, late.length) : ok(`Опубликовано за неделю: ${published}`);
    } },
  { id: "platforms", block: "Соцсети", title: "Обновить площадки: подписчики, лучшие материалы, ссылки", hint: "Рост аудитории и актуальные CTA-ссылки в реестре площадок.", view: "platforms",
    check: (d, p) => {
      if (!d.platforms.length) return warn("Реестр площадок пуст — заполните его", 1);
      const stale = d.platforms.filter((x) => isoDay(x.updated_at) < addDays(p.today, -6));
      return stale.length ? warn(`Не обновлялись больше недели: ${stale.length}`, stale.length) : ok("Все площадки обновлены на этой неделе");
    } },
  { id: "crm_steps", block: "Продажи", title: "У каждой активной карточки есть следующий шаг", hint: "Новые, контакт, диалог, предложение, follow-up — у всех назначены дата и действие.", view: "crm", crm: true,
    check: (d) => {
      const none = d.cards.filter((c) => OPEN_STAGES.includes(c.stage) && !(c.next_step && c.next_step.date));
      return none.length ? warn(`Без следующего шага: ${none.length}`, none.length) : ok("У всех активных карточек есть следующий шаг");
    } },
  { id: "crm_followups", block: "Продажи", title: "Закрыть просроченные follow-up", hint: "Ответить, назначить новый шаг или перевести в отказ с причиной.", view: "crm", crm: true,
    check: (d, p) => {
      const late = d.cards.filter((c) => c.stage !== "refused" && c.next_step && c.next_step.date && c.next_step.date < p.today);
      const leads = d.cards.filter((c) => inRange(isoDay(c.created_at), p)).length;
      const paid = d.cards.reduce((a, c) => a + c.payments.filter((x) => inRange(isoDay(x.at), p)).length, 0);
      return late.length ? warn(`Просрочено: ${late.length} · лидов за неделю: ${leads} · оплат: ${paid}`, late.length) : ok(`Лидов за неделю: ${leads} · оплат: ${paid}`);
    } },
  { id: "cycles", block: "Циклы", title: "Проверить заполнение групп и ближайшие встречи", hint: "Свободные места, площадки, техника и съёмка на встречи следующих двух недель.", view: "cycles",
    check: (d, p) => {
      const active = d.cyc.cycles.filter((c) => cycles.ACTIVE.includes(c.status));
      const free = active.reduce((a, c) => a + c.free_seats, 0);
      const soonNoVenue = active.filter((c) => !c.venue && Object.values(c.meetings).some((m) => m.date && m.date >= p.today && m.date <= addDays(p.today, 14)));
      if (soonNoVenue.length) return warn(`Нет площадки у ${soonNoVenue.length} ${plural(soonNoVenue.length, "цикла", "циклов", "циклов")} со встречами в ближайшие 2 недели`, soonNoVenue.length);
      return active.length ? info(`Активных циклов: ${active.length} · свободных мест: ${free}`) : info("Активных циклов нет");
    } },
  { id: "media", block: "Медийность", title: "Обновить outreach: ответы, переговоры, booked, published", hint: "Статусы в медиа-воронке и следующие шаги по каждой площадке.", view: "media",
    check: (d, p) => {
      const order = Object.keys(collections.SCHEMAS.media.stages);
      const late = d.media.filter((m) => m.next_date && m.next_date < p.today && order.indexOf(m.stage) < order.indexOf("appearance"));
      const booked = d.media.filter((m) => ["booked", "preparation"].includes(m.stage)).length;
      return late.length ? warn(`Просрочены шаги: ${late.length} · в booked/подготовке: ${booked}`, late.length) : ok(`В booked/подготовке: ${booked}`);
    } },
  { id: "materials", block: "Материалы", title: "Записи встреч и выходов — в Media Library и Content Factory", hint: "Всё, что снято на неделе, собрано и передано в обработку.", view: "media",
    check: (d) => {
      const order = Object.keys(collections.SCHEMAS.media.stages);
      const pending = d.media.filter((m) => order.indexOf(m.stage) >= order.indexOf("appearance") && !m.in_factory);
      return pending.length ? warn(`Не переданы в Content Factory: ${pending.length}`, pending.length) : ok("Все записи переданы");
    } },
  { id: "tasks", block: "Команда", title: "Задачи и блокеры: закрыть выполненное, снять блокеры", hint: "Что внедрено, что в работе, что мешает.", view: "today",
    check: (d, p) => {
      const open = d.tasks.filter((t) => !t.done);
      const blockers = open.filter((t) => t.blocker).length;
      const late = open.filter((t) => t.due && t.due < p.today).length;
      return blockers || late ? warn(`Блокеры: ${blockers} · просрочено: ${late}`, blockers + late) : ok(`Открытых задач: ${open.length}`);
    } },
  { id: "varvara", block: "Варвара", title: "Согласовать календарь Варвары на следующую неделю", hint: "Съёмки, консультации, встречи, медийные выходы — без накладок и с подготовкой.", view: "calendar",
    check: (d, p) => {
      const from = addDays(p.to, 1), to = addDays(p.to, 7);
      const n = d.entries.filter((e) => e.varvara && e.date >= from && e.date <= to).length + d.media.filter((m) => m.date && m.date >= from && m.date <= to).length;
      return info(`На следующей неделе событий с Варварой: ${n}`);
    } }
];

const MONTH_ITEMS = [
  { id: "revenue", block: "Финансы", title: "План / факт по выручке", hint: "Выручка по встречам и циклам за месяц против плана.", view: "rhythm", crm: true,
    check: (d, p, x) => {
      const plan = x.plan.revenue;
      return info(`Факт: ${x.fact.revenue.toLocaleString("ru-RU")} ₽${plan ? ` из ${plan.toLocaleString("ru-RU")} ₽ (${Math.round(100 * x.fact.revenue / plan)}%)` : " · план не задан"}`);
    } },
  { id: "cycles_fill", block: "Циклы", title: "План / факт по загрузке циклов", hint: "Продажи встреч и пакетов, заполнение активных групп.", view: "cycles",
    check: (d, p, x) => info(`Оплат встреч и пакетов: ${x.fact.cycle_sales}${x.plan.cycle_sales ? ` из ${x.plan.cycle_sales}` : ""} · заполнение активных групп: ${x.fact.fill}%`) },
  { id: "club", block: "Клуб", title: "Рост клуба и отток", hint: "Новые подписки, активные, отменённые — по данным Tribute.", view: "rhythm",
    check: (d, p, x) => (x.fact.club ? info(`Активных: ${x.fact.club.active} · новых за месяц: ${x.fact.club.new}${x.plan.club_sales ? ` из ${x.plan.club_sales}` : ""} · отменили: ${x.fact.club.cancelling}`) : info("Нет данных из Tribute")) },
  { id: "masters", block: "Продажи", title: "Продажи обучения Мастеров", hint: "Заявки на путь Мастера и их стадии в CRM.", view: "crm", crm: true,
    check: (d, p, x) => info(`Заявок на путь Мастера за месяц: ${x.fact.master_apps}`) },
  { id: "media_results", block: "Медийность", title: "Результаты медийных выходов", hint: "Сколько выходов, сколько женщин пришло по ссылкам и сколько купили.", view: "media",
    check: (d, p, x) => info(`Выходов за месяц: ${x.fact.appearances} · пришло по ссылкам: ${x.fact.media_leads}`) },
  { id: "content_results", block: "Контент", title: "Результаты контентных серий", hint: "Что опубликовано, что сработало лучше — и сводка для Content Factory.", view: "content",
    check: (d, p, x) => info(`Опубликовано: ${x.fact.published} · просмотров: ${x.fact.views.toLocaleString("ru-RU")}`) },
  { id: "sources", block: "Аналитика", title: "Источники новой аудитории и продаж", hint: "Откуда пришли новые женщины и кто из них купил.", view: "crm", crm: true,
    check: (d, p, x) => info(x.fact.sources.length ? `Лидов: ${x.fact.leads} · топ: ${x.fact.sources.map((s) => `${s.source} (${s.count})`).join(", ")}` : `Лидов за месяц: ${x.fact.leads}`) },
  { id: "library", block: "Материалы", title: "Цены, даты, места и ссылки в библиотеке актуальны", hint: "Проверить раздел «Цены, даты, места, ссылки» и био.", view: "library",
    check: (d, p) => {
      const prices = d.library.filter((l) => l.category === "prices");
      if (!prices.length) return warn("В библиотеке нет раздела с ценами и датами", 1);
      const stale = prices.filter((l) => isoDay(l.updated_at) < addDays(p.today, -30));
      return stale.length ? warn(`Не обновлялись больше месяца: ${stale.length}`, stale.length) : ok("Обновлено в этом месяце");
    } },
  { id: "team", block: "Команда", title: "Результаты команды и состояние автоматизации", hint: "Что внедрено, что в работе, где блокеры — коротко для Варвары.", view: "today",
    check: () => info("Отметьте после разговора с командой") },
  { id: "plan_next", block: "План", title: "План следующего месяца", hint: "Выручка, продажи циклов и клуба — заполните ниже.", view: "rhythm",
    check: (d, p, x) => (x.next_plan && x.next_plan.revenue ? ok(`План на ${p.next_label.toLowerCase()} задан`) : warn(`Задайте план на ${p.next_label.toLowerCase()}`, 1)) }
];

async function monthFacts(d, p) {
  const payments = [];
  for (const c of d.cards) for (const x of c.payments) if (inRange(isoDay(x.at), p)) payments.push(x);
  const leads = d.cards.filter((c) => inRange(isoDay(c.created_at), p));
  const bySource = {};
  for (const c of leads) bySource[c.source] = (bySource[c.source] || 0) + 1;
  const active = d.cyc.cycles.filter((c) => cycles.ACTIVE.includes(c.status));
  const cap = active.reduce((a, c) => a + c.capacity, 0);
  const taken = active.reduce((a, c) => a + (c.capacity - c.free_seats), 0);
  const trackings = new Set(d.media.filter((m) => m.tracking).map((m) => crm.sourceLabel(m.tracking)));
  const published = d.content.filter((c) => ["published", "analyzed"].includes(c.stage) && inRange(c.publish_date, p));
  let club = null;
  if (d.club) {
    const within = (iso) => inRange(isoDay(iso), p);
    club = { active: d.club.filter((s) => s.status === "active").length, new: d.club.filter((s) => within(s.activatedAt)).length, cancelling: d.club.filter((s) => s.status === "pre_cancelled" || (s.status === "cancelled" && within(s.expireAt))).length };
  }
  return {
    revenue: payments.reduce((a, x) => a + x.amount, 0),
    cycle_sales: payments.length,
    fill: cap ? Math.round(100 * taken / cap) : 0,
    club,
    master_apps: d.cards.reduce((a, c) => a + (c.history || []).filter((h) => h.type === "application" && /Мастер/.test(h.text) && inRange(isoDay(h.at), p)).length, 0),
    appearances: d.media.filter((m) => inRange(m.date, p)).length,
    media_leads: leads.filter((c) => trackings.has(c.source)).length,
    published: published.length,
    views: published.reduce((a, c) => a + ((c.metrics && c.metrics.views) || 0), 0),
    leads: leads.length,
    sources: Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([source, count]) => ({ source, count }))
  };
}

function cleanPlan(src) {
  const out = {};
  for (const k of ["revenue", "cycle_sales", "club_sales"]) {
    const v = src && src[k];
    if (v === "" || v == null) continue;
    const n = Math.round(Number(v));
    if (n >= 0) out[k] = n;
  }
  return out;
}

async function view(member, now = Date.now()) {
  const canCrm = team.can(member, "crm.view");
  const d = await gather(canCrm);
  const week = weekPeriod(now), month = monthPeriod(now);
  const [weekMarks, monthMarks, plan, nextPlan] = await Promise.all([
    loadJson(marksKey(week), {}), loadJson(marksKey(month), {}), loadJson(planKey(month.key), {}), loadJson(planKey(month.next_key), {})
  ]);
  const extra = { plan, next_plan: nextPlan, fact: await monthFacts(d, month) };
  const build = (items, p, marks) => {
    const list = items.filter((i) => !i.crm || canCrm).map((i) => {
      let res;
      try { res = i.check(d, p, extra); } catch (e) { res = info("Не получилось проверить"); }
      return { id: i.id, block: i.block, title: i.title, hint: i.hint, view: i.view, ...res, done: marks[i.id] || null };
    });
    const done = list.filter((i) => i.done).length;
    return { ...p, items: list, done_count: done, total: list.length };
  };
  return {
    week: build(WEEK_ITEMS, week, weekMarks),
    month: { ...build(MONTH_ITEMS, month, monthMarks), plan, next_plan: nextPlan, fact: canCrm ? extra.fact : null }
  };
}

async function mark(kind, key, itemId, done, by) {
  const items = kind === "week" ? WEEK_ITEMS : kind === "month" ? MONTH_ITEMS : null;
  if (!items || !items.some((i) => i.id === itemId)) return { status: 400, errors: ["Неизвестный пункт"] };
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(String(key || ""))) return { status: 400, errors: ["Неизвестный период"] };
  const k = `os:rhythm:${kind}:${key}`;
  const marks = await loadJson(k, {});
  if (done) marks[itemId] = { by, at: new Date().toISOString() }; else delete marks[itemId];
  await store.command("SET", k, JSON.stringify(marks), "EX", 400 * 24 * 3600);
  return { status: 200 };
}

async function savePlan(monthKey, plan) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ""))) return { status: 400, errors: ["Неизвестный месяц"] };
  await store.command("SET", planKey(monthKey), JSON.stringify(cleanPlan(plan)));
  return { status: 200 };
}

// Bot reminder: Friday morning (week) and the last day of the month (month), once per period.
async function runReminders(now = Date.now()) {
  const today = mskDay(now);
  const [y, m, dd] = today.split("-").map(Number);
  const due = [];
  if (weekday(today) === 5) due.push(weekPeriod(now));
  if (dd === daysInMonth(y, m)) due.push(monthPeriod(now));
  const result = { periods: due.length, sent: 0 };
  if (!due.length) return result;
  const members = (await team.listMembers()).filter((mb) => team.can(mb, "os.access") && team.can(mb, "analytics.view"));
  for (const period of due) {
    if (!(await store.claimOnce(`rhythm-remind:${period.kind}:${period.key}`, 40 * 24 * 3600))) continue;
    for (const member of members) {
      const v = await view(member, now);
      const block = v[period.kind];
      const warns = block.items.filter((i) => i.status === "warn");
      const head = period.kind === "week" ? `Пятница — время итогов недели 🗂\n${block.label}` : `Последний день месяца — время итогов 🗂\n${block.label}`;
      const lines = warns.length ? ["", "Требуют внимания:", ...warns.map((i) => `• ${i.title}: ${i.text}`)] : ["", "Автоматические проверки в порядке — осталось отметить пункты чек-листа."];
      try {
        await telegram("sendMessage", { chat_id: member.id, text: [head, ...lines, "", `Чек-лист: ${block.total} пунктов. Откройте кабинет командой /dashboard → «Итоги».`].join("\n") });
        result.sent += 1;
      } catch { /* the member never started the bot */ }
    }
  }
  return result;
}

module.exports = { weekPeriod, monthPeriod, view, mark, savePlan, runReminders, WEEK_ITEMS, MONTH_ITEMS };
