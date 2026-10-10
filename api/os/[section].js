// Management dashboard API (os.html). Session cookie from a one-time bot link; every section
// checks the member's permissions (lib/team.js).
const team = require("../../lib/team");
const auth = require("../../lib/os-auth");
const crm = require("../../lib/crm");
const cycles = require("../../lib/cycles");
const board = require("../../lib/os-board");
const events = require("../../lib/events");
const tribute = require("../../lib/tribute");
const collections = require("../../lib/os-collections");
const rhythm = require("../../lib/os-rhythm");
const { notifyAssignee } = require("../../lib/os-notify");
const { send, readBody } = require("../../lib/http");

const DAY_MS = 864e5;
const TZ = "Europe/Moscow";
const dayOf = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const deny = (what) => ({ status: 403, body: { ok: false, error: `Нет доступа: ${what}` } });
const fail = (result) => ({ status: result.status || 400, body: { ok: false, errors: result.errors || [result.error || "Не получилось"] } });
const who = (member) => member.name || member.role_label;

function meView(member) {
  return {
    ok: true, id: member.id, name: member.name || null, role: member.role, role_label: member.role_label, perms: member.perms,
    dict: { stages: crm.STAGES, stage_order: crm.STAGE_ORDER, interests: crm.INTERESTS, sources: crm.SOURCES, cycle_statuses: cycles.STATUSES, calendar_types: board.CALENDAR_TYPES },
    bot_username: process.env.TELEGRAM_BOT_USERNAME || "K_zhenshcine_bot"
  };
}

async function clubStatusMap() {
  try {
    const list = await tribute.listSubscribers();
    const map = new Map();
    for (const s of list) {
      const id = String(s.telegramUserId || "");
      if (!id) continue;
      const picked = tribute.pickSubscriber(list, id);
      if (picked) map.set(id, { status: picked.status, expire_at: picked.expireAt || null });
    }
    return map;
  } catch { return null; }
}

// Everything dated in [from, to]: cycle meetings, club events, manual entries.
async function calendarItems(from, to, cycleView) {
  const items = [];
  const view = cycleView || (await cycles.overview(false));
  for (const c of view.cycles) {
    if (c.status === "cancelled") continue;
    for (const [i, mid] of ["1", "2", "3", "4", "5", "6"].entries()) {
      const m = c.meetings[mid];
      if (!m || !m.date || m.date < from || m.date > to) continue;
      items.push({ kind: "cycle", id: `${c.id}:${mid}`, cycle_id: c.id, date: m.date, time: m.time || "", title: `${c.city_name}: встреча ${mid} из 6`, place: c.venue || "", meta: c.master.name ? `Мастер: ${c.master.name}` : "", seats: `${c.seats_by_meeting[mid]}/${c.capacity}`, index: i });
    }
  }
  for (const e of await events.loadEvents()) {
    if (e.date >= from && e.date <= to) items.push({ kind: "club", id: `club:${e.date}:${e.title}`, date: e.date, time: "", title: e.title, place: "Клуб", meta: e.text || "" });
  }
  for (const name of ["content", "media"]) {
    const cal = collections.SCHEMAS[name].calendar;
    for (const it of await collections.load(name)) {
      const date = it[cal.field];
      if (!date || date < from || date > to) continue;
      const schema = collections.SCHEMAS[name];
      items.push({ kind: cal.kind, id: `${name}:${it.id}`, ref: it.id, date, time: it[cal.time] || "", title: it.title, place: "", meta: `${cal.label} · ${schema.stages[it.stage] || ""}`, varvara: name === "media" });
    }
  }
  for (const e of await board.loadEntries()) {
    if (e.date >= from && e.date <= to) items.push({ kind: "entry", ...e, type_label: board.CALENDAR_TYPES[e.type] || "" });
  }
  items.sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")));
  return items;
}

// Bot-link codes of media appearances shown by the appearance's name ("Медиа: Подкаст …").
async function mediaSources() {
  const map = new Map();
  for (const it of await collections.load("media")) if (it.tracking) map.set(crm.sourceLabel(it.tracking), `Медиа: ${it.title}`);
  return map;
}
const withSource = (map) => (card) => (map.has(card.source) ? { ...card, source: map.get(card.source) } : card);

const sections = {
  async me(member) { return { status: 200, body: { ...meView(member), team: (await team.listMembers()).filter((m) => m.name).map((m) => ({ id: String(m.id), name: m.name, role_label: m.role_label })) } }; },

  async today(member) {
    const now = Date.now();
    const today = dayOf(now);
    const canCrm = team.can(member, "crm.view");
    const [cards, cycleView, tasks, club] = await Promise.all([
      canCrm ? crm.listCards() : [], cycles.overview(false), board.loadTasks(), clubStatusMap()
    ]);
    const week = now - 7 * DAY_MS;
    const followups = cards
      .filter((c) => c.stage !== "refused" && c.next_step && c.next_step.date && c.next_step.date <= today)
      .sort((a, b) => a.next_step.date.localeCompare(b.next_step.date))
      .map(crm.summary);
    const sourceNames = await mediaSources();
    const newLeads = cards.filter((c) => new Date(c.created_at).getTime() >= now - 2 * DAY_MS).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(crm.summary).map(withSource(sourceNames));
    const payments = [];
    for (const c of cards) for (const p of c.payments) if (new Date(p.at).getTime() >= week) payments.push({ ...p, card_id: c.id, name: c.name, username: c.username });
    payments.sort((a, b) => b.at.localeCompare(a.at));
    const activeCycles = cycleView.cycles.filter((c) => cycles.ACTIVE.includes(c.status));
    const upcoming = await calendarItems(today, dayOf(now + 7 * DAY_MS), cycleView);
    const attention = [];
    for (const name of ["content", "media"]) {
      const schema = collections.SCHEMAS[name];
      const order = Object.keys(schema.stages);
      for (const it of await collections.load(name)) {
        const due = it[schema.due_field];
        if (!due || due > today || order.indexOf(it.stage) >= order.indexOf(schema.done_from)) continue;
        attention.push({ board: name, id: it.id, title: it.title, due, stage: schema.stages[it.stage], owner: it.owner || it.contact_name || "", action: it.next_action || "" });
      }
    }
    attention.sort((a, b) => a.due.localeCompare(b.due));
    const contentList = await collections.load("content");
    const weekStart = dayOf(week);
    const publishedWeek = contentList.filter((c) => ["published", "analyzed"].includes(c.stage) && c.publish_date && c.publish_date >= weekStart && c.publish_date <= today).length;
    const kpi = {
      leads_7d: cards.filter((c) => new Date(c.created_at).getTime() >= week).length,
      payments_7d: payments.length,
      revenue_7d: payments.reduce((a, p) => a + p.amount, 0),
      club_active: club ? [...club.values()].filter((s) => s.status === "active").length : null,
      active_cycles: activeCycles.length,
      free_seats: activeCycles.reduce((a, c) => a + c.free_seats, 0),
      published_7d: publishedWeek
    };
    return {
      status: 200,
      body: {
        ok: true, today, kpi, crm_visible: canCrm,
        followups, attention, new_leads: newLeads, payments: payments.slice(0, 20), upcoming,
        cycles: activeCycles.map((c) => ({ id: c.id, city_name: c.city_name, status: c.status, capacity: c.capacity, free_seats: c.free_seats, master: c.master.name, published: c.published, next: c.meetings[["1", "2", "3", "4", "5", "6"].find((mid) => c.meetings[mid].date && c.meetings[mid].date >= today)] || null })),
        tasks: tasks.filter((t) => !t.done).sort((a, b) => Number(b.blocker) - Number(a.blocker) || String(a.due || "9").localeCompare(String(b.due || "9")))
      }
    };
  },

  async crm(member, body) {
    if (!team.can(member, "crm.view")) return deny("CRM");
    const action = body.action || "list";
    if (action === "list") {
      const [cards, club, sourceNames] = await Promise.all([crm.listCards(), clubStatusMap(), mediaSources()]);
      const rows = cards.map((c) => {
        const live = club && c.tg_id ? club.get(String(c.tg_id)) : null;
        return withSource(sourceNames)(crm.summary(live ? { ...c, club: live } : c));
      }).sort((a, b) => b.last_touch_at.localeCompare(a.last_touch_at));
      return { status: 200, body: { ok: true, cards: rows } };
    }
    if (action === "get") {
      const card = await crm.getCard(body.id);
      return card ? { status: 200, body: { ok: true, card } } : { status: 404, body: { ok: false, errors: ["Карточка не найдена"] } };
    }
    if (action === "broadcast_preview" || action === "broadcast") {
      if (!team.can(member, "crm.broadcast")) return deny("рассылки");
      const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 500);
      const cards = (await Promise.all(ids.map((id) => crm.getCard(id)))).filter(Boolean);
      const ok = cards.filter((c) => c.tg_id && !c.opt_out);
      if (action === "broadcast_preview") {
        return { status: 200, body: { ok: true, recipients: ok.length, skipped_no_bot: cards.filter((c) => !c.tg_id).length, skipped_opt_out: cards.filter((c) => c.tg_id && c.opt_out).length, sample: ok.slice(0, 3).map((c) => ({ name: c.name, text: crm.fill(String(body.text || ""), c) })) } };
      }
      const text = String(body.text || "").trim().slice(0, 3500);
      if (!text) return { status: 400, body: { ok: false, errors: ["Напишите текст рассылки"] } };
      const base = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
      const buttons = {
        meetings: { text: "Выбрать встречу", web_app: { url: `${base}/meetings.html` } },
        club: { text: "Вступить в клуб", url: "https://t.me/tribute/app?startapp=s17IJ" },
        space: { text: "Открыть пространство", web_app: { url: `${base}/space.html` } }
      };
      const result = await crm.broadcast(ok.map((c) => c.id), text, buttons[body.button] || null, who(member));
      return { status: 200, body: { ok: true, ...result } };
    }
    if (!team.can(member, "crm.edit")) return deny("ведение CRM");
    let result;
    if (action === "update") {
      const before = await crm.getCard(body.id);
      result = await crm.updateCard(body.id, body.patch, who(member));
      const c = result.card;
      if (c && c.owner && (!before || before.owner !== c.owner)) {
        await notifyAssignee(c.owner, member, `Вам передана карточка в CRM: ${c.name || (c.username ? "@" + c.username : "без имени")}${c.next_step && c.next_step.action ? `\nСледующий шаг: ${c.next_step.action}${c.next_step.date ? ` (${c.next_step.date})` : ""}` : ""}`);
      }
    }
    else if (action === "create") result = await crm.createCard(body.card, who(member));
    else if (action === "note") result = await crm.addNote(body.id, body.text, who(member), body.type);
    else return { status: 400, body: { ok: false, errors: ["Неизвестное действие"] } };
    return result.card ? { status: 200, body: { ok: true, card: result.card } } : fail(result);
  },

  async cycles(member, body) {
    const action = body.action || "list";
    const canEdit = team.can(member, "cycles.edit");
    const masterOnly = !canEdit && team.can(member, "attendance.mark") ? member.id : null;
    const contacts = Boolean(masterOnly) || team.can(member, "participants.view") || team.can(member, "crm.view");
    const listing = async () => {
      const view = await cycles.overview(contacts, masterOnly);
      const ratings = await require("../../lib/reviews").stats();
      for (const c of view.cycles) c.rating = ratings[c.id] || null;
      let masters = [];
      if (canEdit) {
        const certified = (await require("../../lib/masters").listPeople()).filter((p) => p.status === "master").map((p) => ({ id: String(p.id), name: p.name }));
        const teamMasters = (await team.listMembers()).filter((m) => m.role === "master").map((m) => ({ id: String(m.id), name: m.name }));
        masters = [...certified, ...teamMasters.filter((m) => !certified.some((c) => c.id === m.id))];
      }
      return { can_edit: canEdit, can_mark: canEdit || team.can(member, "attendance.mark"), masters, ...view };
    };
    if (action === "list") return { status: 200, body: { ok: true, ...(await listing()) } };
    let result;
    if (action === "attendance") {
      if (!canEdit && !team.can(member, "attendance.mark")) return deny("посещаемость");
      if (masterOnly && !(await cycles.loadCycles()).some((c) => c.id === body.id && c.master_id === String(member.id))) return deny("чужая группа");
      result = await cycles.markAttendance(String(body.id || ""), String(body.meeting || ""), body.present);
      if (result.status !== 200) return fail(result);
      return { status: 200, body: { ok: true, ...(await listing()) } };
    }
    if (!canEdit) return deny("циклы");
    const prevMaster = body.id ? ((await cycles.loadCycles()).find((c) => c.id === body.id) || {}).master_id || null : null;
    if (action === "save") result = await cycles.saveCycle(body.cycle, body.id || null);
    else if (action === "publish") result = await cycles.publish(String(body.id || ""));
    else if (action === "unpublish") result = await cycles.unpublish(String(body.id || ""));
    else return { status: 400, body: { ok: false, errors: ["Неизвестное действие"] } };
    if (result.status !== 200) return fail(result);
    if (action === "save" && result.cycle && result.cycle.master_id && result.cycle.master_id !== prevMaster) {
      const m = (await team.listMembers()).find((x) => String(x.id) === result.cycle.master_id);
      if (m && m.name) await notifyAssignee(m.name, member, `Вы — Мастер цикла: ${result.cycle.title || ""} (${result.cycle.city_id}). Группа и отметка присутствующих — в кабинете.`);
      else if (await require("../../lib/masters").getPerson(result.cycle.master_id)) {
        try {
          const base = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
          await require("../../lib/telegram").telegram("sendMessage", { chat_id: result.cycle.master_id, text: `Ты ведёшь цикл многомерности${result.cycle.title ? ` «${result.cycle.title}»` : ""} 🤍 Участницы и отметка присутствующих — в кабинете Мастера (/master).`, reply_markup: { inline_keyboard: [[{ text: "Открыть кабинет Мастера", web_app: { url: `${base}/master-cabinet.html` } }]] } });
        } catch { /* never started the bot */ }
      }
    }
    return { status: 200, body: { ok: true, notified: result.notified || 0, warning: result.warning || null, ...(await listing()) } };
  },

  async calendar(member, body) {
    const action = body.action || "list";
    if (action === "list") {
      const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const from = isDay(body.from) ? body.from : dayOf(Date.now() - 7 * DAY_MS);
      const to = isDay(body.to) ? body.to : dayOf(Date.now() + 60 * DAY_MS);
      return { status: 200, body: { ok: true, from, to, items: await calendarItems(from, to), can_edit: team.can(member, "cycles.edit") } };
    }
    if (!team.can(member, "cycles.edit")) return deny("календарь");
    const result = action === "save" ? await board.saveEntry(body.entry || {}, who(member)) : action === "remove" ? await board.removeEntry(String(body.id || "")) : { status: 400, errors: ["Неизвестное действие"] };
    return result.status === 200 ? { status: 200, body: { ok: true } } : fail(result);
  },

  // «Доступы»: service logins and passwords (password only on request, every reveal logged).
  async vault(member, body) {
    const vault = require("../../lib/vault");
    const action = body.action || "list";
    let r;
    if (action === "list") return { status: 200, body: { ok: true, items: await vault.list(member), categories: vault.CATEGORIES, sees_all: team.can(member, "vault.all") } };
    if (action === "save") r = await vault.save(body.item || {}, member);
    else if (action === "reveal") r = await vault.reveal(String(body.id || ""), member);
    else if (action === "remove") r = await vault.remove(String(body.id || ""), member);
    else r = { status: 400, errors: ["Неизвестное действие"] };
    if (r.status !== 200) return fail(r);
    return { status: 200, body: { ok: true, entry: r.entry || null, password: r.password, items: action === "reveal" ? undefined : await vault.list(member) } };
  },

  // Club: pairs for the ritual after every online call.
  async pairs(member, body) {
    if (!team.can(member, "pairs.edit")) return deny("пары");
    const pairs = require("../../lib/pairs");
    const action = body.action || "list";
    const round = String(body.round || "");
    let r;
    if (action === "list") {
      try { await pairs.matchDue(); } catch (e) { console.error("Pairs due matching failed", e.message); }
      const config = await pairs.loadConfig();
      const rounds = [];
      for (const meta of await pairs.listRounds()) rounds.push(await pairs.roundSummary(meta));
      const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
      return { status: 200, body: { ok: true, config, next: pairs.nextCall(config), upcoming: config.enabled ? pairs.callDates(config, today, 4) : [], rounds } };
    }
    if (action === "round") {
      const details = await pairs.roundDetails(round);
      return details ? { status: 200, body: { ok: true, ...details } } : { status: 404, body: { ok: false, errors: ["Раунд не найден"] } };
    }
    if (action === "save_config") r = await pairs.saveConfig(body.config || {});
    else if (action === "open_now") r = await pairs.openRound(new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10), { manual: true, by: who(member) });
    else if (action === "open_test") r = await pairs.openRound(new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10) + "t", { manual: true, by: who(member), test: true });
    else if (action === "delete_test") r = await pairs.deleteTestRound(round);
    else if (action === "match_now") r = await pairs.match(round, { auto: true });
    else if (action === "unpair") r = await pairs.unpair(round, String(body.pair || ""));
    else if (action === "pair") r = await pairs.pairManually(round, String(body.a || ""), String(body.b || ""));
    else r = { status: 400, errors: ["Неизвестное действие"] };
    if (r.status !== 200) return fail(r.error ? { status: r.status, errors: [r.error] } : r);
    return { status: 200, body: { ok: true, ...r, status: undefined } };
  },

  async collection(member, body) {
    const name = String(body.name || "");
    if (!collections.SCHEMAS[name]) return { status: 404, body: { ok: false, errors: ["Раздел не найден"] } };
    const schema = collections.SCHEMAS[name];
    const action = body.action || "list";
    if (schema.view_perm && !team.can(member, schema.view_perm)) return deny(schema.title);
    if (action === "list") {
      const items = await collections.load(name);
      let extras = null;
      // Media: women who came by the appearance's link (CRM source) and what they paid.
      if (name === "media" && team.can(member, "crm.view")) {
        const cards = await crm.listCards();
        extras = {};
        for (const it of items) {
          if (!it.tracking) continue;
          const label = crm.sourceLabel(it.tracking);
          const own = cards.filter((c) => c.source === label);
          extras[it.id] = { leads: own.length, paid: own.filter((c) => c.payments.length).length, revenue: own.reduce((a, c) => a + c.payments.reduce((x, p) => x + p.amount, 0), 0) };
        }
      }
      return { status: 200, body: { ok: true, schema: collections.publicSchema(name), items, extras, can_edit: team.can(member, schema.perm), bot_username: process.env.TELEGRAM_BOT_USERNAME || "K_zhenshcine_bot" } };
    }
    if (!team.can(member, schema.perm)) return deny(schema.title);
    const result = action === "save" ? await collections.saveItem(name, body.item, who(member))
      : action === "remove" ? await collections.removeItem(name, String(body.id || ""))
      : { status: 400, errors: ["Неизвестное действие"] };
    if (result.status === 200 && result.item && result.item.owner && (!result.before || result.before.owner !== result.item.owner)) {
      await notifyAssignee(result.item.owner, member, `${schema.item}: «${result.item.title}»${result.item.stage ? ` · ${schema.stages[result.item.stage]}` : ""}${result.item.due ? `\nСрок: ${result.item.due}` : ""}`);
    }
    return result.status === 200 ? { status: 200, body: { ok: true, item: result.item || null } } : fail(result);
  },

  async rhythm(member, body) {
    const action = body.action || "get";
    if (action === "get") return { status: 200, body: { ok: true, can_edit: team.can(member, "tasks.edit"), ...(await rhythm.view(member)) } };
    if (!team.can(member, "tasks.edit")) return deny("итоги");
    const result = action === "mark" ? await rhythm.mark(body.kind, body.key, body.item, Boolean(body.done), who(member))
      : action === "plan" ? await rhythm.savePlan(body.key, body.plan || {})
      : { status: 400, errors: ["Неизвестное действие"] };
    return result.status === 200 ? { status: 200, body: { ok: true, ...(await rhythm.view(member)) } } : fail(result);
  },

  async masters(member, body) {
    const masters = require("../../lib/masters");
    const action = body.action || "list";
    const listing = async () => {
      const [trainings, people, materials, mirror] = await Promise.all([masters.loadTrainings(), masters.listPeople(), collections.load("training"), masters.listMirror()]);
      return {
        ok: true, can_edit: team.can(member, "masters.edit"), statuses: masters.TRAINING_STATUSES, mirror_statuses: masters.MIRROR_STATUSES,
        trainings: trainings.map((t) => ({ ...t, taken: people.filter((p) => p.training_id === t.id).length, labels: masters.MEETING_IDS.map((m) => masters.meetingLabel(t.meetings[m])) })),
        people: people.map((p) => ({ ...p, path: masters.pathOf(p, trainings.find((t) => t.id === p.training_id), materials), mirror_count: mirror.filter((b) => b.master_id === p.id).length }))
          .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name, "ru") : a.status === "master" ? 1 : -1)),
        mirror: mirror.slice(0, 100),
        finance: await require("../../lib/master-finance").overview(),
        rates: { referral: require("../../lib/master-finance").RATE_REFERRAL, space: require("../../lib/master-finance").RATE_SPACE }
      };
    };
    if (action === "list") return { status: 200, body: await listing() };
    if (!team.can(member, "masters.edit")) return deny("Мастера");
    if (action === "save_training") {
      const r = await masters.saveTraining(body.training, body.id || null);
      if (r.status !== 200) return fail(r);
    } else if (action === "person") {
      const p = await masters.getPerson(String(body.id || ""));
      if (!p) return { status: 404, body: { ok: false, errors: ["Не найдена"] } };
      const patch = body.patch || {};
      if (Array.isArray(patch.attendance)) p.attendance = patch.attendance.filter((m) => masters.MEETING_IDS.includes(String(m))).map(String);
      if ("final_review" in patch) p.final_review = Boolean(patch.final_review);
      if ("training_id" in patch) p.training_id = patch.training_id || null;
      if ("visible" in patch) p.profile = { ...p.profile, visible: Boolean(patch.visible) };
      if ("status" in patch && patch.status === "student") p.status = "student";
      await masters.savePerson(p);
    } else if (action === "add") {
      const id = String(body.id || "").trim();
      if (!/^\d{3,15}$/.test(id)) return { status: 400, body: { ok: false, errors: ["Telegram ID — только цифры (его показывает бот по команде /master)"] } };
      const name = String(body.name || "").trim().slice(0, 80);
      if (!name) return { status: 400, body: { ok: false, errors: ["Укажите имя"] } };
      const p = (await masters.getPerson(id)) || masters.emptyPerson(id, { name, source: "manual" });
      p.name = name;
      if (body.training_id) p.training_id = body.training_id;
      if (body.status === "master") { p.status = "master"; p.certified_at = p.certified_at || new Date().toISOString(); }
      await masters.savePerson(p);
    } else if (action === "certify") {
      const p = await masters.certify(String(body.id || ""));
      if (!p) return { status: 404, body: { ok: false, errors: ["Не найдена"] } };
      try {
        const base = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
        await require("../../lib/telegram").telegram("sendMessage", { chat_id: p.id, text: `Поздравляем! Тебе присвоен статус Мастера многомерности пространства «к Женщине» ✨\n\nВ кабинете Мастера заполни свою карточку — её увидят участницы клуба и смогут записываться к тебе на практику «Зеркало». Фото для карточки просто пришли сюда, в бот.`, reply_markup: { inline_keyboard: [[{ text: "Открыть кабинет Мастера", web_app: { url: `${base}/master-cabinet.html` } }]] } });
      } catch { /* never started the bot */ }
      await crm.safeTouch({ id: p.id }, { type: "master", force: true, interest: "master", text: "Присвоен статус Мастера многомерности" });
    } else if (action === "payout") {
      const r = await require("../../lib/master-finance").addPayout(String(body.id || ""), body.amount, body.note, who(member));
      if (r.status !== 200) return fail(r);
      try { await require("../../lib/telegram").telegram("sendMessage", { chat_id: String(body.id), text: `Вам выплачено ${Number(body.amount).toLocaleString("ru-RU")} ₽ за встречи многомерности 🤍\nПодробности — в кабинете Мастера (/master), вкладка «Финансы».` }); } catch { /* never started the bot */ }
    } else if (action === "mirror_status") {
      const r = await masters.setMirrorStatus(String(body.id || ""), String(body.status || ""), null, body.note);
      if (r.status !== 200) return fail(r);
    } else return { status: 400, body: { ok: false, errors: ["Неизвестное действие"] } };
    return { status: 200, body: await listing() };
  },

  async tasks(member, body) {
    const action = body.action || "list";
    const tasks = require("../../lib/tasks");
    const actor = { name: who(member), id: member.id };
    if (action === "list") {
      if (team.can(member, "tasks.edit")) { try { await require("../../lib/seed-plan").importOnce(actor); } catch (e) { console.error("Plan import failed", e.message); } }
      return { status: 200, body: { ok: true, tasks: await tasks.load(), statuses: tasks.STATUSES } };
    }
    if (!team.can(member, "tasks.edit")) return deny("задачи");
    let result;
    if (action === "save") result = await tasks.saveTask(body.task || {}, actor);
    else if (action === "status") result = await tasks.setStatus(String(body.id || ""), String(body.status || ""), actor, body.comment);
    else if (action === "comment") result = await tasks.addComment(String(body.id || ""), body.text, actor);
    else if (action === "remove") result = await tasks.removeTask(String(body.id || ""));
    else result = { status: 400, errors: ["Неизвестное действие"] };
    return result.status === 200 ? { status: 200, body: { ok: true, task: result.task || null, tasks: result.tasks || await tasks.load(), statuses: tasks.STATUSES } } : fail(result);
  }
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  // Only the dashboard page sends this header (blocks cross-site form posts).
  if (String((req.headers && req.headers["x-kz-os"]) || "") !== "1") return send(res, 403, { ok: false });
  const name = String((req.query && req.query.section) || "");
  const body = readBody(req);
  try {
    if (name === "login") {
      const session = await auth.redeem(body.token);
      if (!session) return send(res, 401, { ok: false, error: "Ссылка для входа устарела. Напишите боту /dashboard и откройте новую." });
      res.setHeader("Set-Cookie", auth.sessionCookie(session.sid));
      return send(res, 200, meView(session.member));
    }
    if (name === "logout") {
      await auth.logout(req);
      res.setHeader("Set-Cookie", auth.clearCookie());
      return send(res, 200, { ok: true });
    }
    const section = sections[name];
    if (!section) return send(res, 404, { ok: false });
    const member = await auth.memberFromRequest(req);
    if (!member) return send(res, 401, { ok: false, error: "Войдите через бота: напишите /dashboard" });
    // Masters see only their groups; everything else needs the full workspace.
    if (!["me", "cycles", "crm"].includes(name) && !team.can(member, "os.workspace")) return send(res, 403, { ok: false, errors: ["Этот раздел недоступен для вашей роли"] });
    const result = await section(member, body);
    return send(res, result.status, result.body);
  } catch (error) {
    console.error("Dashboard section failed", name, error.message);
    return send(res, 500, { ok: false, error: "Не получилось. Попробуйте ещё раз." });
  }
};
