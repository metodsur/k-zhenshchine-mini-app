// CRM: one card per woman. Cards fill themselves from the bot and the app
// (start, channel, waitlist, applications, payments, club) and are worked on in the dashboard.
const crypto = require("crypto");
const store = require("./store");

const IDS_KEY = "crm:ids";
const cardKey = (id) => `crm:c:${id}`;
const HISTORY_LIMIT = 200;

const STAGES = {
  new: "Новая",
  contact: "Контакт",
  dialog: "Диалог",
  offer: "Предложение",
  paid: "Оплата",
  followup: "Follow-up",
  refused: "Отказ"
};
const STAGE_ORDER = ["new", "contact", "dialog", "offer", "paid", "followup", "refused"];

const INTERESTS = {
  club: "Клуб",
  cycle: "Многомерность",
  master: "Мастер",
  partner: "Партнёр",
  consult: "Консультация",
  circle: "Женский круг"
};

// Known codes for bot links like t.me/K_zhenshcine_bot?start=reels (any other code is kept as is).
const SOURCES = {
  bot: "Telegram-бот",
  reels: "Reels",
  tg: "Telegram",
  podcast: "Подкаст",
  talk: "Выступление",
  ref: "Рекомендация",
  youtube: "YouTube",
  media: "СМИ",
  site: "Сайт",
  other: "Другое"
};

const clean = (value, max = 300) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
const cleanText = (value, max = 2000) => String(value == null ? "" : value).trim().slice(0, max);
const nowIso = () => new Date().toISOString();

function sourceLabel(code) {
  const key = clean(code, 64).toLowerCase();
  if (!key) return SOURCES.bot;
  return SOURCES[key] || key;
}

// Start parameter of /start, e.g. "/start podcast_ivanova" → "podcast_ivanova".
function startParam(text) {
  const match = String(text || "").match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{1,64})/);
  return match ? match[1] : "";
}

function emptyCard(id, fields = {}) {
  const at = nowIso();
  return {
    id, tg_id: null, username: null, name: "", phone: "", email: "", city: "",
    source: SOURCES.bot, interests: [], stage: "new", cycle_id: null,
    payments: [], club: null, next_step: null, refusal_reason: "", owner: "",
    history: [], created_at: at, updated_at: at, last_touch_at: at,
    ...fields
  };
}

async function getCard(id) {
  if (!/^[a-z0-9]{2,40}$/i.test(String(id || ""))) return null;
  const raw = await store.command("GET", cardKey(id));
  return raw ? JSON.parse(raw) : null;
}

async function saveCard(card) {
  card.updated_at = nowIso();
  if (card.history.length > HISTORY_LIMIT) card.history = card.history.slice(-HISTORY_LIMIT);
  await store.command("SET", cardKey(card.id), JSON.stringify(card));
  await store.command("SADD", IDS_KEY, card.id);
  return card;
}

async function listCards() {
  const ids = (await store.command("SMEMBERS", IDS_KEY)) || [];
  if (!ids.length) return [];
  const cards = [];
  for (let i = 0; i < ids.length; i += 200) {
    const raws = (await store.command("MGET", ...ids.slice(i, i + 200).map(cardKey))) || [];
    for (const raw of raws) if (raw) cards.push(JSON.parse(raw));
  }
  return cards;
}

function addHistory(card, type, text, by = "система") {
  card.history.push({ at: nowIso(), type, text: clean(text, 500), by });
  card.last_touch_at = nowIso();
}

// ---------- automatic capture from the bot and the app ----------

const telegramId = (userId) => `tg${String(userId).replace(/\D/g, "")}`;

// Records an event for a Telegram user, creating the card on first contact.
// Never moves a card backwards in the funnel; a payment always moves it to "Оплата".
async function touch(user, event) {
  if (!user || !user.id) return null;
  const id = telegramId(user.id);
  let card = await getCard(id);
  const isNew = !card;
  if (!isNew && event.onlyIfNew) return card;
  if (!card) card = emptyCard(id, { tg_id: String(user.id) });
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  if (!card.name && fullName) card.name = clean(fullName, 80);
  if (user.username) card.username = clean(user.username, 64);
  if (isNew && event.source) card.source = sourceLabel(event.source);
  if (event.interest && INTERESTS[event.interest] && !card.interests.includes(event.interest)) card.interests.push(event.interest);
  if (event.city && !card.city) card.city = clean(event.city, 60);
  if (event.phone && !card.phone) card.phone = clean(event.phone, 40);
  if (event.email && !card.email) card.email = clean(event.email, 120);
  if (event.contact && !card.phone && !card.email) card.phone = clean(event.contact, 120);
  if (event.cycle_id) card.cycle_id = event.cycle_id;
  if (event.payment) {
    const ref = event.payment.ref;
    if (!ref || !card.payments.some((p) => p.ref === ref)) {
      card.payments.push({ at: nowIso(), product: clean(event.payment.product, 120), amount: Number(event.payment.amount) || 0, status: "paid", ref: ref || null });
    }
    if (card.stage !== "paid") card.stage = "paid";
  }
  if (event.club) card.club = event.club;
  // Automation: suggest the next step only when the team has not planned one.
  if (event.next_step && !(card.next_step && card.next_step.date)) card.next_step = event.next_step;
  if (event.stage_min && ["new", "contact", "dialog"].includes(card.stage) && STAGE_ORDER.indexOf(card.stage) < STAGE_ORDER.indexOf(event.stage_min)) card.stage = event.stage_min;
  if (event.text) addHistory(card, event.type || "event", event.text);
  return saveCard(card);
}

// Automatic follow-up: once per rule key. Sets the next step when none is planned
// (otherwise leaves a hint in the history) and moves paid cards to "Follow-up".
async function applyAuto(user, ruleKey, step, extra = {}) {
  const id = telegramId(user.id);
  let card = await getCard(id);
  if (card && (card.auto_done || []).includes(ruleKey)) return false;
  if (!card) card = await touch(user, { type: "auto" });
  card.auto_done = [...(card.auto_done || []), ruleKey].slice(-50);
  if (extra.interest && INTERESTS[extra.interest] && !card.interests.includes(extra.interest)) card.interests.push(extra.interest);
  if (card.stage === "refused" && !extra.evenIfRefused) { await saveCard(card); return false; }
  if (card.next_step && card.next_step.date) {
    addHistory(card, "auto", `Автоподсказка: ${step.action} (шаг не изменён — уже запланирован другой)`);
  } else {
    card.next_step = step;
    if (card.stage === "paid") card.stage = "followup";
    addHistory(card, "auto", `Автоматический follow-up: ${step.action}`);
  }
  await saveCard(card);
  return true;
}

// Same as touch, but never breaks the flow it is called from (the bot reply matters more).
async function safeTouch(user, event) {
  try { return await touch(user, event); } catch (error) { console.error("CRM capture failed", error.message); return null; }
}

// Daily: club subscribers from Tribute become cards (or update their club status).
async function syncClub(subscribers) {
  let created = 0;
  for (const s of subscribers || []) {
    if (!s || !s.telegramUserId) continue;
    const id = telegramId(s.telegramUserId);
    const card = await getCard(id);
    const club = { status: s.status || null, expire_at: s.expireAt || null };
    if (card && card.club && card.club.status === club.status && card.club.expire_at === club.expire_at) continue;
    const user = { id: s.telegramUserId, username: s.telegramUsername || s.username || undefined, first_name: s.name || s.firstName || undefined };
    const statusText = { active: "активна", pre_cancelled: "отменена, доступ до конца периода", cancelled: "закончилась" }[club.status] || club.status;
    await touch(user, { type: "club", interest: "club", club, text: `Подписка на клуб: ${statusText}`, source: card ? undefined : "tg" });
    if (!card) created += 1;
  }
  return created;
}

// ---------- editing in the dashboard ----------

function normalizePatch(input) {
  const errors = [];
  const src = input && typeof input === "object" ? input : {};
  const patch = {};
  for (const [field, max] of [["name", 80], ["phone", 60], ["email", 120], ["city", 60], ["source", 64], ["refusal_reason", 300], ["owner", 80], ["username", 64]]) {
    if (field in src) patch[field] = clean(src[field], max);
  }
  if ("username" in patch) patch.username = patch.username.replace(/^@/, "") || null;
  if ("stage" in src) {
    if (!STAGES[src.stage]) errors.push("Неизвестная стадия");
    else patch.stage = src.stage;
  }
  if ("interests" in src) {
    const list = Array.isArray(src.interests) ? src.interests : [];
    patch.interests = [...new Set(list.filter((i) => INTERESTS[i]))];
  }
  if ("cycle_id" in src) patch.cycle_id = src.cycle_id ? clean(src.cycle_id, 40) : null;
  if ("next_step" in src) {
    const step = src.next_step;
    if (!step || (!step.date && !step.action)) patch.next_step = null;
    else {
      const date = clean(step.date, 10);
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push("Дата следующего шага в формате ГГГГ-ММ-ДД");
      patch.next_step = { date: date || null, action: clean(step.action, 200) };
    }
  }
  if (patch.stage === "refused" && "refusal_reason" in patch && !patch.refusal_reason) errors.push("Укажите причину отказа");
  return { errors, patch };
}

function describeChange(before, patch) {
  const parts = [];
  if (patch.stage && patch.stage !== before.stage) parts.push(`Стадия: ${STAGES[before.stage]} → ${STAGES[patch.stage]}`);
  if ("next_step" in patch && JSON.stringify(patch.next_step) !== JSON.stringify(before.next_step)) {
    parts.push(patch.next_step ? `Следующий шаг: ${patch.next_step.action || ""}${patch.next_step.date ? ` (${patch.next_step.date})` : ""}` : "Следующий шаг снят");
  }
  if (patch.refusal_reason && patch.refusal_reason !== before.refusal_reason) parts.push(`Причина отказа: ${patch.refusal_reason}`);
  return parts.join(" · ");
}

async function updateCard(id, input, by) {
  const card = await getCard(id);
  if (!card) return { error: "Карточка не найдена", status: 404 };
  const { errors, patch } = normalizePatch(input);
  if (errors.length) return { errors, status: 400 };
  const change = describeChange(card, patch);
  Object.assign(card, patch);
  if (change) addHistory(card, "edit", change, by);
  return { card: await saveCard(card) };
}

async function createCard(input, by) {
  const { errors, patch } = normalizePatch(input);
  if (!patch.name) errors.push("Укажите имя");
  if (errors.length) return { errors, status: 400 };
  const card = emptyCard(`m${crypto.randomBytes(6).toString("hex")}`, { source: SOURCES.other, ...patch });
  if (!card.stage) card.stage = "new";
  addHistory(card, "created", "Карточка создана вручную", by);
  return { card: await saveCard(card) };
}

async function addNote(id, text, by, type = "note") {
  const card = await getCard(id);
  if (!card) return { error: "Карточка не найдена", status: 404 };
  const note = cleanText(text, 1000);
  if (!note) return { errors: ["Пустая заметка"], status: 400 };
  addHistory(card, ["note", "call", "message", "meeting"].includes(type) ? type : "note", note, by);
  return { card: await saveCard(card) };
}

async function setOptOut(userId, value) {
  const card = await getCard(telegramId(userId));
  if (!card) return null;
  card.opt_out = Boolean(value);
  addHistory(card, "optout", value ? "Отписалась от рассылок (/stop)" : "Снова подписалась на рассылки");
  return saveCard(card);
}

const firstName = (card) => String(card.name || "").split(" ")[0] || "";
const fill = (text, card) => String(text).replace(/\{имя\}/gi, firstName(card) || "Дорогая").replace(/\{город\}/gi, card.city || "в твоём городе");

// Broadcast to the chosen cards through the bot (only women who wrote to the bot and did not opt out).
async function broadcast(ids, text, button, by) {
  const { telegram } = require("./telegram");
  const conversations = require("./conversations");
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 500);
  const cards = (await Promise.all(unique.map(getCard))).filter((c) => c && c.tg_id && !c.opt_out);
  const result = { recipients: cards.length, sent: 0, failed: 0 };
  for (let i = 0; i < cards.length; i += 20) {
    const batch = cards.slice(i, i + 20);
    await Promise.all(batch.map(async (card) => {
      try {
        await telegram("sendMessage", { chat_id: card.tg_id, text: `${fill(text, card)}\n\nНе хочешь получать такие сообщения — отправь /stop`, ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}) });
        result.sent += 1;
        addHistory(card, "broadcast", `Рассылка: ${String(text).slice(0, 120)}`, by);
        await saveCard(card);
        await conversations.open(card.tg_id, "broadcast");
      } catch { result.failed += 1; }
    }));
    if (i + 20 < cards.length) await new Promise((r) => setTimeout(r, 1100));
  }
  const log = JSON.parse((await store.command("GET", "os:broadcasts")) || "[]");
  log.push({ at: nowIso(), by, text: String(text).slice(0, 500), ...result });
  await store.command("SET", "os:broadcasts", JSON.stringify(log.slice(-200)));
  return result;
}

// Compact list view (no history) for the CRM table.
function summary(card) {
  const { history, ...rest } = card;
  const last = history[history.length - 1] || null;
  return { ...rest, last_event: last, revenue: card.payments.reduce((a, p) => a + (p.status === "paid" ? p.amount : 0), 0) };
}

module.exports = {
  STAGES, STAGE_ORDER, INTERESTS, SOURCES,
  sourceLabel, startParam, telegramId, touch, safeTouch, applyAuto, syncClub, setOptOut, broadcast, fill,
  getCard, listCards, updateCard, createCard, addNote, summary, normalizePatch
};
