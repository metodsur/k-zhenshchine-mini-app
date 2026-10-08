// «Ритуал в паре»: after every online call of the paid club, members are paired for a ritual.
// A round = one club call. Right after the call the bot invites club members to take part;
// a woman either picks a partner herself (invite → accept in the bot) or asks us to match her.
// A set time after the call everyone still without a pair is matched automatically.
// The main rule: a new partner every time, so that over a month she meets as many women as possible.
// Then: shared resources, similar «Мои задачи», city / time zone, newcomer + experienced member.
const crypto = require("crypto");
const store = require("./store");
const { telegram } = require("./telegram");

const CONFIG_KEY = "pairs:config";
const INDEX_KEY = "pairs:rounds";
const PEOPLE_KEY = "pairs:people";
const metaKey = (r) => `pairs:r:${r}`;
const entriesKey = (r) => `pairs:r:${r}:e`;
const partnerKey = (r) => `pairs:r:${r}:p`;
const pairsKey = (r) => `pairs:r:${r}:pairs`;
const invitesKey = (r) => `pairs:r:${r}:inv`;
const doneKey = (r) => `pairs:r:${r}:done`;
const metKey = (u) => `pairs:met:${u}`;
const monthKey = (u, m) => `pairs:month:${u}:${m}`;
const joinedKey = (u) => `pairs:joined:${u}`;

const MSK = 3 * 3600e3; // Moscow is UTC+3 all year.
const MAX_OUTGOING = 3;
const DEFAULTS = { enabled: false, first_date: "", time: "19:00", duration_min: 90, every_weeks: 2, match_after_min: 120, open_hours: 72, ritual_url: "", ritual_title: "" };
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

// Main cities → UTC offset, for «удобно созвониться». Unknown cities simply give no bonus.
const CITY_TZ = {
  "москва": 3, "санкт-петербург": 3, "петербург": 3, "спб": 3, "казань": 3, "краснодар": 3, "сочи": 3, "ростов-на-дону": 3, "нижний новгород": 3, "воронеж": 3, "минск": 3,
  "калининград": 2, "самара": 4, "саратов": 4, "тбилиси": 4, "ереван": 4, "баку": 4, "дубай": 4,
  "екатеринбург": 5, "пермь": 5, "уфа": 5, "челябинск": 5, "тюмень": 5, "алматы": 5, "астана": 5, "ташкент": 5,
  "омск": 6, "новосибирск": 7, "красноярск": 7, "томск": 7, "бали": 8, "иркутск": 8, "владивосток": 10, "хабаровск": 10,
  "стамбул": 3, "анталья": 3, "белград": 1, "берлин": 1, "париж": 1, "рим": 1, "лондон": 0, "лиссабон": 0
};

const clean = (v, max = 200) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const newId = () => crypto.randomBytes(4).toString("hex");
const parse = (raw, fallback = null) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };
const mskDate = (ms) => new Date(ms + MSK).toISOString().slice(0, 10);
const mskTime = (ms) => new Date(ms + MSK).toISOString().slice(11, 16);
const dayLabel = (ms) => { const d = new Date(ms + MSK); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const startMs = (date, time) => Date.parse(`${date}T${time || "19:00"}:00+03:00`);
const baseUrl = () => String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
const cityKey = (c) => clean(c, 60).toLowerCase().replace(/ё/g, "е").replace(/^г\.?\s*/, "");
const tzOf = (c) => (cityKey(c) in CITY_TZ ? CITY_TZ[cityKey(c)] : null);

async function hgetall(key) {
  const flat = (await store.command("HGETALL", key)) || [];
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}
const jsonMap = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, parse(v, null)]).filter(([, v]) => v));

// ---------- config & calendar ----------

async function loadConfig() {
  return { ...DEFAULTS, ...parse(await store.command("GET", CONFIG_KEY), {}) };
}

async function saveConfig(input) {
  const errors = [];
  const c = { ...DEFAULTS };
  c.enabled = Boolean(input.enabled);
  c.first_date = clean(input.first_date, 10);
  if (c.first_date && !isDate(c.first_date)) errors.push("Дата первого созвона в формате ГГГГ-ММ-ДД");
  c.time = clean(input.time, 5) || DEFAULTS.time;
  if (!/^\d{2}:\d{2}$/.test(c.time)) errors.push("Время в формате ЧЧ:ММ");
  const num = (v, d, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  c.duration_min = num(input.duration_min, DEFAULTS.duration_min, 15, 360);
  c.every_weeks = num(input.every_weeks, DEFAULTS.every_weeks, 1, 8);
  c.match_after_min = num(input.match_after_min, DEFAULTS.match_after_min, 0, 24 * 60);
  c.open_hours = num(input.open_hours, DEFAULTS.open_hours, 6, 14 * 24);
  c.ritual_url = clean(input.ritual_url, 500);
  if (c.ritual_url && !/^https:\/\//.test(c.ritual_url)) errors.push("Ссылка на ритуал должна начинаться с https://");
  c.ritual_title = clean(input.ritual_title, 80);
  if (c.enabled && !c.first_date) errors.push("Укажите дату ближайшего созвона");
  if (errors.length) return { status: 400, errors };
  await store.command("SET", CONFIG_KEY, JSON.stringify(c));
  return { status: 200, config: c };
}

// Call dates from first_date every N weeks, starting from the first one not before `fromDate`.
function callDates(config, fromDate, count) {
  if (!config.first_date || !isDate(config.first_date)) return [];
  const step = config.every_weeks * 7 * 864e5;
  const first = Date.parse(`${config.first_date}T00:00:00Z`);
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  let k = Math.max(0, Math.ceil((from - first) / step));
  const out = [];
  while (out.length < count) out.push(new Date(first + k++ * step).toISOString().slice(0, 10));
  return out;
}

function nextCall(config, now = Date.now()) {
  if (!config.enabled) return null;
  const date = callDates(config, mskDate(now - 864e5), 3).find((d) => startMs(d, config.time) + config.duration_min * 60e3 > now);
  return date ? { date, time: config.time, starts_at: new Date(startMs(date, config.time)).toISOString(), label: `${dayLabel(startMs(date, config.time))} в ${config.time}` } : null;
}

// ---------- rounds ----------

async function loadMeta(roundId) { return parse(await store.command("GET", metaKey(roundId)), null); }
const saveMeta = (meta) => store.command("SET", metaKey(meta.id), JSON.stringify(meta));

async function listRounds() {
  const ids = ((await store.command("SMEMBERS", INDEX_KEY)) || []).sort().reverse();
  const metas = [];
  for (const id of ids.slice(0, 24)) { const m = await loadMeta(id); if (m) metas.push(m); }
  return metas;
}

const isOpen = (meta, now = Date.now()) => Boolean(meta && meta.opened_at && now < Date.parse(meta.closes_at));

// The round a woman can act in right now (the newest open one).
async function activeRound(now = Date.now()) {
  const ids = ((await store.command("SMEMBERS", INDEX_KEY)) || []).sort().reverse();
  for (const id of ids.slice(0, 4)) { const m = await loadMeta(id); if (isOpen(m, now)) return m; }
  return null;
}

// Opens a round: the bot invites every club member who gave consent. Safe to call twice.
async function openRound(roundId, { now = Date.now(), manual = false, by = null } = {}) {
  const config = await loadConfig();
  const existing = await loadMeta(roundId);
  if (existing && existing.opened_at) return { status: 200, round: existing, already: true };
  if (!(await store.claimOnce(`pairs:opening:${roundId}`, 3600))) return { status: 200, already: true };
  const meta = {
    id: roundId, date: roundId, time: config.time, manual, opened_by: by,
    opened_at: new Date(now).toISOString(),
    match_at: new Date(now + config.match_after_min * 60e3).toISOString(),
    closes_at: new Date(now + config.open_hours * 3600e3).toISOString(),
    matched_at: null, ritual_url: config.ritual_url, ritual_title: config.ritual_title
  };
  await saveMeta(meta);
  await store.command("SADD", INDEX_KEY, roundId);
  try { await require("./qstash").scheduleCall("/api/telegram/reminder", { kind: "pairs", step: "match", round: roundId }, `${Math.max(60, config.match_after_min * 60)}s`); }
  catch (error) { console.error("Pairs match scheduling failed (cron will catch up)", error.message); }
  const sent = await inviteMembers(meta);
  return { status: 200, round: meta, sent };
}

async function clubRecipients() {
  let list = [];
  try { list = await require("./tribute").listSubscribers(); } catch { list = []; }
  const ids = [...new Set(list.filter((s) => s.status === "active" || s.status === "pre_cancelled").map((s) => String(s.telegramUserId)).filter(Boolean))];
  const consent = require("./consent");
  const out = [];
  for (const id of ids) { try { if (await consent.has(id)) out.push(id); } catch { /* skip */ } }
  return out;
}

async function inviteMembers(meta) {
  const ids = await clubRecipients();
  const at = mskTime(Date.parse(meta.match_at));
  let sent = 0;
  for (const id of ids) {
    try {
      await telegram("sendMessage", {
        chat_id: id,
        text: `Спасибо, что были на созвоне клуба 💛\n\nТеперь — ритуал в паре. Каждый раз с новой участницей: так за месяц у вас будет больше живых знакомств.\n\nВыберите пару сама или доверьте подбор нам — в ${at} пришлём вашу пару.`,
        reply_markup: { inline_keyboard: [
          [{ text: "Подберите мне пару", callback_data: `p:j:${meta.id}` }],
          [{ text: "Выберу сама", web_app: { url: `${baseUrl()}/pairs.html` } }]
        ] }
      });
      sent++;
    } catch { /* blocked the bot */ }
  }
  return sent;
}

// ---------- people ----------

async function eligible(userId) {
  try { if (await require("./team").getMember(userId)) return true; } catch { /* ignore */ }
  try { const s = await require("./tribute").getSubscriber(userId); if (s && (s.status === "active" || s.status === "pre_cancelled")) return true; } catch { /* ignore */ }
  try { if (await require("./telegram").isClubMember(userId)) return true; } catch { /* ignore */ }
  return false;
}

const displayName = (u) => clean([u.first_name, u.last_name ? `${String(u.last_name)[0]}.` : ""].filter(Boolean).join(" "), 60) || "Участница";
const contactUrl = (p) => (p.username ? `https://t.me/${p.username}` : `tg://user?id=${p.id}`);

// Key words of her open tasks: used only for matching, never shown to anyone.
function taskWords(tasks) {
  const words = new Set();
  (tasks || []).filter((t) => !t.done).forEach((t) => String(t.text || "").toLowerCase().replace(/ё/g, "е").split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 5).forEach((w) => words.add(w.slice(0, 5))));
  return [...words].slice(0, 40);
}

const isNewcomer = (e) => (e.rounds_before || 0) <= 1 && (!e.club_since || Date.now() - Date.parse(e.club_since) < 45 * 864e5);
const isExperienced = (e) => (e.rounds_before || 0) >= 3 || (e.club_since && Date.now() - Date.parse(e.club_since) > 90 * 864e5);

function score(a, b, metOfA) {
  let s = 0;
  if (metOfA && metOfA.has(String(b.id))) s -= 100;
  const common = (x, y) => x.filter((v) => y.includes(v)).length;
  s += Math.min(9, 3 * common(a.resources || [], b.resources || []));
  s += Math.min(6, 2 * common(a.words || [], b.words || []));
  if (a.city && b.city && cityKey(a.city) === cityKey(b.city)) s += 6;
  else { const ta = tzOf(a.city), tb = tzOf(b.city); if (ta != null && tb != null) s += ta === tb ? 3 : Math.abs(ta - tb) <= 1 ? 1 : 0; }
  if ((isNewcomer(a) && isExperienced(b)) || (isNewcomer(b) && isExperienced(a))) s += 5;
  return s;
}

// Greedy matching on pair scores: good enough for club sizes and easy to reason about.
function matchEntries(entries, metSets, rand = Math.random) {
  const list = [...entries];
  const edges = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    edges.push({ a: a.id, b: b.id, s: score(a, b, metSets[a.id]) + rand() * 0.5 });
  }
  edges.sort((x, y) => y.s - x.s);
  const used = new Set(), pairs = [];
  for (const e of edges) if (!used.has(e.a) && !used.has(e.b)) { used.add(e.a); used.add(e.b); pairs.push([e.a, e.b]); }
  const left = list.filter((e) => !used.has(e.id)).map((e) => e.id);
  return { pairs, left };
}

async function metSet(userId) { return new Set((await store.command("SMEMBERS", metKey(userId))) || []); }

// ---------- pair formation ----------

async function formPair(roundId, members, by) {
  const id = newId();
  const claimed = [];
  for (const m of members) {
    if (Number(await store.command("HSETNX", partnerKey(roundId), m, id)) === 1) claimed.push(m);
    else { if (claimed.length) await store.command("HDEL", partnerKey(roundId), ...claimed); return null; }
  }
  const pair = { id, members: members.map(String), by, at: new Date().toISOString() };
  await store.command("HSET", pairsKey(roundId), id, JSON.stringify(pair));
  await rememberMeeting(roundId, pair.members);
  await notifyPair(roundId, pair);
  return pair;
}

async function addToPair(roundId, pair, userId) {
  if (Number(await store.command("HSETNX", partnerKey(roundId), userId, pair.id)) !== 1) return null;
  const next = { ...pair, members: [...pair.members, String(userId)] };
  await store.command("HSET", pairsKey(roundId), pair.id, JSON.stringify(next));
  await rememberMeeting(roundId, next.members);
  await notifyPair(roundId, next, [String(userId)], pair.members);
  return next;
}

async function rememberMeeting(roundId, members) {
  const month = roundId.slice(0, 7);
  for (const m of members) {
    const others = members.filter((x) => x !== m);
    if (!others.length) continue;
    await store.command("SADD", metKey(m), ...others);
    await store.command("SADD", monthKey(m, month), ...others);
  }
}

async function peopleOf(ids) {
  if (!ids.length) return {};
  const raw = (await store.command("HMGET", PEOPLE_KEY, ...ids)) || [];
  return Object.fromEntries(ids.map((id, i) => [String(id), parse(raw[i], { id: String(id), name: "Участница" })]));
}

// Each member gets her partner(s), a "write to her" button, the ritual and «Ритуал пройден».
// `only` limits who is told (a third joining an existing pair); `existing` are told about the newcomer.
async function notifyPair(roundId, pair, only = null, existing = []) {
  const meta = await loadMeta(roundId);
  const people = await peopleOf(pair.members);
  for (const m of pair.members) {
    const isNewcomer3 = only && only.includes(m);
    if (only && !isNewcomer3 && !existing.includes(m)) continue;
    const partners = pair.members.filter((x) => x !== m).map((x) => people[x]);
    const names = partners.map((p) => (p.city ? `${p.name} (${p.city})` : p.name));
    const text = only && !isNewcomer3
      ? `К вашей паре присоединилась ${names.find((n, i) => only.includes(partners[i].id)) || "ещё одна участница"} 💛 Теперь вы проходите ритуал втроём.`
      : `${partners.length > 1 ? "Ваша тройка на ритуал" : "Ваша пара на ритуал"} — ${names.join(" и ")} 💛\n\nНапишите ${partners.length > 1 ? "им" : "ей"} и договоритесь, когда удобно созвониться. Пройти ритуал вместе можно в течение недели.\n\nКогда пройдёте — нажмите «Ритуал пройден».`;
    const contactRows = partners.map((p) => [{ text: `Написать: ${p.name}`, url: contactUrl(p) }]);
    const tail = [];
    if (meta && meta.ritual_url) tail.push([{ text: meta.ritual_title || "Открыть ритуал", url: meta.ritual_url }]);
    tail.push([{ text: "Ритуал пройден ✓", callback_data: `p:d:${roundId}` }]);
    try { await telegram("sendMessage", { chat_id: m, text, reply_markup: { inline_keyboard: [...contactRows, ...tail] } }); }
    catch {
      // A partner without a username may hide her profile: then the tg://user button is refused.
      const safeRows = partners.filter((p) => p.username).map((p) => [{ text: `Написать: ${p.name}`, url: contactUrl(p) }]);
      const hint = partners.some((p) => !p.username) ? "\n\nЕсли кнопки «Написать» нет — найдите её в чате клуба по имени." : "";
      try { await telegram("sendMessage", { chat_id: m, text: text + hint, reply_markup: { inline_keyboard: [...safeRows, ...tail] } }); } catch { /* blocked */ }
    }
  }
}

// ---------- actions of a woman ----------

async function roundState(roundId) {
  const [entries, partners, pairs, invites, done] = await Promise.all([
    hgetall(entriesKey(roundId)).then(jsonMap), hgetall(partnerKey(roundId)),
    hgetall(pairsKey(roundId)).then(jsonMap), hgetall(invitesKey(roundId)).then(jsonMap), hgetall(doneKey(roundId))
  ]);
  return { entries, partners, pairs, invites, done };
}

async function join(roundId, user, { mode = "auto", city } = {}) {
  const meta = await loadMeta(roundId);
  if (!isOpen(meta)) return { status: 409, error: "Запись на этот ритуал уже закрыта. Ждём вас после следующего созвона клуба 💛" };
  if (!(await eligible(user.id))) return { status: 403, error: "Ритуалы в паре — для участниц клуба «к Женщине»." };
  const profile = require("./profile");
  const saved = await profile.loadProfile(user.id).catch(() => ({}));
  const cityName = clean(city, 60) || saved.city || "";
  if (city && clean(city, 60) !== saved.city) { try { await profile.saveProfile(user.id, { city: clean(city, 60) }); } catch { /* not essential */ } }
  let clubSince = null;
  try { const s = await require("./tribute").getSubscriber(user.id); clubSince = s && s.activatedAt || null; } catch { /* ignore */ }
  const existing = parse(await store.command("HGET", entriesKey(roundId), String(user.id)), null);
  const entry = {
    id: String(user.id), name: displayName(user), username: user.username || null, photo_url: user.photo_url || null,
    city: cityName, mode: mode === "self" ? "self" : "auto",
    joined_at: existing ? existing.joined_at : new Date().toISOString(),
    resources: (saved.resources || []).slice(0, 30), words: taskWords(saved.tasks),
    club_since: clubSince, rounds_before: Number(await store.command("SCARD", joinedKey(user.id))) || 0
  };
  if (existing) entry.rounds_before = existing.rounds_before;
  await store.command("HSET", entriesKey(roundId), entry.id, JSON.stringify(entry));
  await store.command("HSET", PEOPLE_KEY, entry.id, JSON.stringify({ id: entry.id, name: entry.name, username: entry.username, photo_url: entry.photo_url, city: entry.city }));
  await store.command("SADD", joinedKey(user.id), roundId);
  let pair = null;
  if (meta.matched_at && entry.mode === "auto") pair = await latePair(roundId, entry.id);
  return { status: 200, entry, pair };
}

async function leave(roundId, userId) {
  if (await store.command("HGET", partnerKey(roundId), String(userId))) return { status: 409, error: "Пара уже собрана — напишите ей, она ждёт 💛" };
  await store.command("HDEL", entriesKey(roundId), String(userId));
  return { status: 200 };
}

async function invite(roundId, fromUser, toId) {
  const meta = await loadMeta(roundId);
  if (!isOpen(meta)) return { status: 409, error: "Запись на этот ритуал уже закрыта." };
  const st = await roundState(roundId);
  const from = String(fromUser.id), to = String(toId);
  if (from === to || !st.entries[from] || !st.entries[to]) return { status: 404, error: "Участница не найдена" };
  if (st.partners[from]) return { status: 409, error: "У вас уже есть пара" };
  if (st.partners[to]) return { status: 409, error: "У неё уже есть пара — выберите другую участницу" };
  const outgoing = Object.values(st.invites).filter((i) => i.from === from && i.status === "sent");
  if (outgoing.some((i) => i.to === to)) return { status: 200, already: true };
  if (outgoing.length >= MAX_OUTGOING) return { status: 429, error: "Можно отправить не больше трёх приглашений сразу — дождитесь ответа" };
  // She already invited me: inviting back means yes.
  const back = st.invites[`${to}:${from}`];
  if (back && back.status === "sent") return respond(roundId, fromUser, to, true);
  await store.command("HSET", invitesKey(roundId), `${from}:${to}`, JSON.stringify({ from, to, at: new Date().toISOString(), status: "sent" }));
  const a = st.entries[from];
  try {
    await telegram("sendMessage", {
      chat_id: to,
      text: `${a.name}${a.city ? ` (${a.city})` : ""} приглашает вас пройти ритуал в паре 💛`,
      reply_markup: { inline_keyboard: [[{ text: "Принять", callback_data: `p:a:${roundId}:${from}` }, { text: "Не сейчас", callback_data: `p:n:${roundId}:${from}` }]] }
    });
  } catch { /* she still sees it in the app */ }
  return { status: 200 };
}

async function respond(roundId, user, fromId, accept) {
  const to = String(user.id), from = String(fromId);
  const raw = await store.command("HGET", invitesKey(roundId), `${from}:${to}`);
  const inv = parse(raw, null);
  if (!inv || inv.status !== "sent") return { status: 404, error: "Приглашение уже неактуально" };
  if (!accept) {
    await store.command("HSET", invitesKey(roundId), `${from}:${to}`, JSON.stringify({ ...inv, status: "declined" }));
    const st = await roundState(roundId);
    try { await telegram("sendMessage", { chat_id: from, text: `${(st.entries[to] || {}).name || "Участница"} в этот раз не сможет. Выберите другую участницу или нажмите «Подберите мне» — пару пришлём сами 💛` }); } catch { /* ignore */ }
    return { status: 200 };
  }
  const pair = await formPair(roundId, [from, to], "self");
  if (!pair) {
    await store.command("HSET", invitesKey(roundId), `${from}:${to}`, JSON.stringify({ ...inv, status: "expired" }));
    return { status: 409, error: "Кто-то из вас уже в паре" };
  }
  await store.command("HSET", invitesKey(roundId), `${from}:${to}`, JSON.stringify({ ...inv, status: "accepted" }));
  return { status: 200, pair };
}

async function markDone(roundId, userId) {
  const pairId = await store.command("HGET", partnerKey(roundId), String(userId));
  if (!pairId) return { status: 404, error: "Пара не найдена" };
  const first = Number(await store.command("HSETNX", doneKey(roundId), String(userId), new Date().toISOString())) === 1;
  if (first) {
    const pair = parse(await store.command("HGET", pairsKey(roundId), pairId), null);
    const people = await peopleOf([String(userId)]);
    for (const m of (pair ? pair.members : []).filter((x) => x !== String(userId))) {
      try { await telegram("sendMessage", { chat_id: m, text: `${people[String(userId)].name} отметила ритуал пройденным 💛 Спасибо вам друг за друга.` }); } catch { /* ignore */ }
    }
  }
  return { status: 200 };
}

// ---------- matching ----------

async function match(roundId, { auto = true } = {}) {
  const meta = await loadMeta(roundId);
  if (!meta || !meta.opened_at) return { status: 404, error: "Раунд не открыт" };
  const st = await roundState(roundId);
  const waiting = Object.values(st.entries).filter((e) => !st.partners[e.id]);
  const mets = {};
  for (const e of waiting) mets[e.id] = await metSet(e.id);
  const { pairs, left } = matchEntries(waiting, mets);
  const formed = [];
  for (const [a, b] of pairs) { const p = await formPair(roundId, [a, b], "auto"); if (p) formed.push(p); }
  let alone = [];
  for (const id of left) {
    // Odd number: the last one joins the pair where she fits best (a three).
    const all = Object.values(jsonMap(await hgetall(pairsKey(roundId)))).filter((p) => p.members.length === 2);
    const me = st.entries[id];
    // Pairs we matched come first: a pair that chose each other is left as it is when possible.
    const ranked = all.map((p) => ({ p, s: p.members.reduce((sum, m) => sum + score(me, st.entries[m] || { id: m }, mets[id]), 0) - (p.by === "auto" ? 0 : 1000) })).sort((x, y) => y.s - x.s);
    const joined = ranked.length ? await addToPair(roundId, ranked[0].p, id) : null;
    if (!joined) alone.push(id);
  }
  if (auto && !meta.matched_at) {
    for (const id of alone) {
      try { await telegram("sendMessage", { chat_id: id, text: "В этот раз пары пока не нашлось 🤍 Как только запишется ещё участница, мы сразу пришлём вам пару." }); } catch { /* ignore */ }
    }
  }
  meta.matched_at = meta.matched_at || new Date().toISOString();
  await saveMeta(meta);
  return { status: 200, formed: formed.length, alone: alone.length };
}

// After the main matching: a newcomer is paired with someone still waiting, if any.
async function latePair(roundId, userId) {
  const st = await roundState(roundId);
  const me = st.entries[userId];
  const others = Object.values(st.entries).filter((e) => e.id !== userId && !st.partners[e.id] && e.mode === "auto");
  if (!me || !others.length) return null;
  const met = await metSet(userId);
  others.sort((a, b) => score(me, b, met) - score(me, a, met));
  return formPair(roundId, [userId, others[0].id], "auto");
}

// ---------- scheduled work ----------

// Morning and evening cron, plus the delayed calls: open the round after the call,
// match after the set time, and gently remind pairs that have not done the ritual in 3 days.
async function runScheduled(now = Date.now()) {
  const config = await loadConfig();
  const result = { opened: 0, matched: 0, scheduled: 0, nudged: 0 };
  if (config.enabled) {
    for (const date of callDates(config, mskDate(now - 3 * 864e5), 3)) {
      const end = startMs(date, config.time) + config.duration_min * 60e3;
      if (now >= end && now < end + config.open_hours * 3600e3) {
        const meta = await loadMeta(date);
        if (!meta) { await openRound(date, { now }); result.opened++; }
      } else if (now < end && end - now < 24 * 3600e3 && (await store.claimOnce(`pairs:sched:${date}`, 2 * 864e5))) {
        try { await require("./qstash").scheduleCall("/api/telegram/reminder", { kind: "pairs", step: "open", round: date }, `${Math.ceil((end - now) / 1000)}s`); result.scheduled++; }
        catch (error) { console.error("Pairs open scheduling failed", error.message); }
      }
    }
  }
  for (const meta of await listRounds()) {
    if (!meta.opened_at) continue;
    if (!meta.matched_at && now >= Date.parse(meta.match_at) && isOpen(meta, now)) { await match(meta.id); result.matched++; }
    if (meta.matched_at && now - Date.parse(meta.matched_at) > 3 * 864e5 && now - Date.parse(meta.matched_at) < 5 * 864e5 && (await store.claimOnce(`pairs:nudge:${meta.id}`, 7 * 864e5))) {
      const st = await roundState(meta.id);
      for (const pair of Object.values(st.pairs)) {
        if (pair.members.some((m) => st.done[m])) continue;
        for (const m of pair.members) {
          try { await telegram("sendMessage", { chat_id: m, text: "Как прошёл ваш ритуал в паре? 💛 Если ещё не успели — напишите друг другу, неделя ещё не закончилась.", reply_markup: { inline_keyboard: [[{ text: "Ритуал пройден ✓", callback_data: `p:d:${meta.id}` }]] } }); result.nudged++; } catch { /* ignore */ }
        }
      }
    }
  }
  return result;
}

async function handleDelayed(body, now = Date.now()) {
  const roundId = clean(body.round, 10);
  if (!isDate(roundId)) return { skipped: "bad round" };
  if (body.step === "open") {
    const config = await loadConfig();
    if (!config.enabled || !callDates(config, roundId, 1).includes(roundId)) return { skipped: "not a call day" };
    return openRound(roundId, { now });
  }
  if (body.step === "match") {
    const meta = await loadMeta(roundId);
    if (!meta || meta.matched_at) return { skipped: "done" };
    return match(roundId);
  }
  return { skipped: "unknown step" };
}

// ---------- views ----------

function publicEntry(e, met) {
  const months = e.club_since ? Math.floor((Date.now() - Date.parse(e.club_since)) / (30 * 864e5)) : null;
  const tag = isNewcomer(e) ? "Новенькая" : months && months >= 1 ? `В клубе ${months} мес.` : null;
  return { id: e.id, name: e.name, photo_url: e.photo_url, city: e.city, resources: (e.resources || []).slice(0, 4), tag, met_before: met.has(e.id) };
}

// Everything the «Ритуал в паре» page needs for one woman.
async function stateFor(user, now = Date.now()) {
  const uid = String(user.id);
  const [config, meta, member] = await Promise.all([loadConfig(), activeRound(now), eligible(uid)]);
  const month = mskDate(now).slice(0, 7);
  const met = await metSet(uid);
  const metPeople = await peopleOf([...met].slice(0, 30));
  const saved = await require("./profile").loadProfile(uid).catch(() => ({}));
  const out = {
    ok: true, member, next_call: nextCall(config, now), month_count: Number(await store.command("SCARD", monthKey(uid, month))) || 0,
    total_count: met.size, history: Object.values(metPeople).map((p) => ({ name: p.name, city: p.city || "" })),
    city: saved.city || "", round: null
  };
  if (!meta) return out;
  const st = await roundState(meta.id);
  const me = st.entries[uid] || null;
  const pairId = st.partners[uid];
  const pair = pairId ? st.pairs[pairId] : null;
  let partners = [];
  if (pair) {
    const people = await peopleOf(pair.members.filter((m) => m !== uid));
    partners = Object.values(people).map((p) => ({ id: p.id, name: p.name, city: p.city, photo_url: p.photo_url, contact_url: contactUrl(p) }));
  }
  out.round = {
    id: meta.id, label: dayLabel(Date.parse(meta.opened_at)), match_at: meta.match_at, match_label: mskTime(Date.parse(meta.match_at)),
    matched: Boolean(meta.matched_at), closes_at: meta.closes_at, ritual_url: meta.ritual_url, ritual_title: meta.ritual_title,
    joined: Boolean(me), mode: me ? me.mode : null, done: Boolean(st.done[uid]),
    pair: pair ? { partners, by: pair.by } : null,
    available: me && !pair ? Object.values(st.entries).filter((e) => e.id !== uid && !st.partners[e.id]).map((e) => publicEntry(e, met)).sort((a, b) => a.met_before - b.met_before) : [],
    incoming: Object.values(st.invites).filter((i) => i.to === uid && i.status === "sent" && !st.partners[i.from] && st.entries[i.from]).map((i) => publicEntry(st.entries[i.from], met)),
    outgoing: Object.values(st.invites).filter((i) => i.from === uid && i.status === "sent").map((i) => i.to),
    waiting_count: Object.values(st.entries).filter((e) => !st.partners[e.id]).length
  };
  return out;
}

// Dashboard: one round in full.
async function roundDetails(roundId) {
  const meta = await loadMeta(roundId);
  if (!meta) return null;
  const st = await roundState(roundId);
  const people = await peopleOf(Object.keys(st.entries));
  const name = (id) => (st.entries[id] || people[id] || { name: "Участница" }).name;
  return {
    meta,
    pairs: Object.values(st.pairs).sort((a, b) => a.at.localeCompare(b.at)).map((p) => ({ id: p.id, by: p.by, at: p.at, members: p.members.map((m) => ({ id: m, name: name(m), city: (st.entries[m] || {}).city || "", username: (st.entries[m] || {}).username || null, done: Boolean(st.done[m]) })) })),
    waiting: Object.values(st.entries).filter((e) => !st.partners[e.id]).map((e) => ({ id: e.id, name: e.name, city: e.city, mode: e.mode, username: e.username })),
    entries: Object.keys(st.entries).length
  };
}

async function roundSummary(meta) {
  const st = await roundState(meta.id);
  const pairs = Object.values(st.pairs);
  return { ...meta, entries: Object.keys(st.entries).length, pairs: pairs.length, done_pairs: pairs.filter((p) => p.members.some((m) => st.done[m])).length, waiting: Object.values(st.entries).filter((e) => !st.partners[e.id]).length };
}

async function unpair(roundId, pairId) {
  const pair = parse(await store.command("HGET", pairsKey(roundId), pairId), null);
  if (!pair) return { status: 404, error: "Пара не найдена" };
  await store.command("HDEL", partnerKey(roundId), ...pair.members);
  await store.command("HDEL", pairsKey(roundId), pairId);
  return { status: 200 };
}

async function pairManually(roundId, a, b) {
  const st = await roundState(roundId);
  if (!st.entries[a] || !st.entries[b] || a === b) return { status: 400, error: "Выберите двух участниц раунда" };
  const pair = await formPair(roundId, [String(a), String(b)], "team");
  return pair ? { status: 200, pair } : { status: 409, error: "Кто-то из них уже в паре" };
}

// ---------- bot buttons ----------

async function handleCallback(cq) {
  const m = /^p:([jand]):(\d{4}-\d{2}-\d{2})(?::(\d+))?$/.exec(String(cq && cq.data || ""));
  if (!m) return false;
  const [, op, roundId, other] = m;
  const user = cq.from || {};
  let r, note;
  if (op === "j") {
    r = await join(roundId, user, { mode: "auto" });
    const meta = await loadMeta(roundId);
    note = r.status !== 200 ? r.error : r.pair ? "Пара найдена — смотрите сообщение 💛" : `Вы в подборе 💛 Пару пришлём${meta && !meta.matched_at ? ` в ${mskTime(Date.parse(meta.match_at))}` : ", как только запишется ещё участница"}.`;
    if (r.status === 200 && !r.pair) { try { await telegram("sendMessage", { chat_id: user.id, text: note, reply_markup: { inline_keyboard: [[{ text: "Посмотреть, кто участвует", web_app: { url: `${baseUrl()}/pairs.html` } }]] } }); } catch { /* ignore */ } }
  } else if (op === "a" || op === "n") {
    if (!(await store.command("HGET", entriesKey(roundId), String(user.id)))) await join(roundId, user, { mode: "self" });
    r = await respond(roundId, user, other, op === "a");
    note = r.status !== 200 ? r.error : op === "a" ? "Готово, вы в паре 💛" : "Хорошо, мы передали ей 🤍";
  } else {
    r = await markDone(roundId, user.id);
    note = r.status === 200 ? "Спасибо! Отметили 💛" : r.error;
  }
  try { await telegram("answerCallbackQuery", { callback_query_id: cq.id, text: note }); } catch { /* ignore */ }
  return true;
}

// ---------- Mini App API ----------

async function handleApp(user, body) {
  const op = String(body.op || "state");
  if (op === "state") return { status: 200, body: await stateFor(user) };
  const meta = await activeRound();
  if (!meta) return { status: 409, body: { ok: false, error: "Сейчас подбор пар закрыт. Он откроется после следующего созвона клуба." } };
  let r;
  if (op === "join") r = await join(meta.id, user, { mode: body.mode, city: body.city });
  else if (op === "leave") r = await leave(meta.id, user.id);
  else if (op === "invite") r = await invite(meta.id, user, body.to);
  else if (op === "accept" || op === "decline") r = await respond(meta.id, user, body.from, op === "accept");
  else if (op === "done") r = await markDone(meta.id, user.id);
  else return { status: 400, body: { ok: false } };
  if (r.status !== 200) return { status: r.status, body: { ok: false, error: r.error } };
  return { status: 200, body: await stateFor(user) };
}

module.exports = {
  DEFAULTS, loadConfig, saveConfig, callDates, nextCall, openRound, match, runScheduled, handleDelayed,
  join, leave, invite, respond, markDone, stateFor, roundDetails, roundSummary, listRounds, unpair, pairManually,
  handleCallback, handleApp, matchEntries, score, taskWords
};
