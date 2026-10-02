// Reviews after meetings. The morning after a meeting the bot asks each participant for a score
// (1–10), a few words and permission to share. Shareable reviews go to the library (for the team
// to approve), low scores alert the team, averages show on cycles.
const store = require("./store");
const schedule = require("./schedule");
const orders = require("./orders");
const conversations = require("./conversations");
const { telegram } = require("./telegram");

const KEY = "os:reviews";
const LIMIT = 2000;
const SKIP = "Пропустить";
const CONSENT = { "Да, можно с именем": "name", "Да, но без имени": "anon", "Нет, только для команды": "private" };

const localDate = (ms, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const scoreKeyboard = { keyboard: [["1", "2", "3", "4", "5"], ["6", "7", "8", "9", "10"]], resize_keyboard: true, one_time_keyboard: true };

async function loadReviews() {
  const raw = await store.command("GET", KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// Morning: everyone with a ticket for a meeting that took place yesterday (city's own date).
async function runReviewRequests(now = Date.now()) {
  const doc = await schedule.loadSchedule();
  const result = { meetings: 0, asked: 0, failed: 0 };
  for (const city of doc.cities) {
    const yesterday = localDate(now - 864e5, city.timezone);
    for (const mid of schedule.MEETING_IDS) {
      if (city.meetings[mid].date !== yesterday) continue;
      result.meetings += 1;
      const asked = new Set();
      for (const order of await orders.ordersFor(city.id, mid)) {
        if (order.status !== "paid" || asked.has(String(order.user_id))) continue;
        asked.add(String(order.user_id));
        if (!(await store.claimOnce(`review-ask:${order.user_id}:${city.id}:${mid}:${yesterday}`, 10 * 86400))) continue;
        try {
          await conversations.open(order.user_id, "review", {
            step: "score", city_id: city.id, city_name: city.name, meeting: mid, cycle_id: order.cycle_id || city.cycle_id || null,
            master: (city.organizer && city.organizer.name) || null, date: yesterday
          }, 72 * 3600);
          await telegram("sendMessage", {
            chat_id: order.user_id,
            text: `Как тебе вчерашняя встреча «${schedule.MEETINGS[mid].title}»? 🤍\nОцени, пожалуйста, от 1 до 10 — это помогает нам делать встречи лучше.`,
            reply_markup: scoreKeyboard
          });
          result.asked += 1;
        } catch { result.failed += 1; }
      }
    }
  }
  return result;
}

const done = { remove_keyboard: true };

async function finish(message, state, consent) {
  const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || null;
  const review = {
    at: new Date().toISOString(), user_id: String(message.from.id), name, username: message.from.username || null,
    score: state.score, text: state.text || "", consent: consent || "private",
    city_id: state.city_id, city_name: state.city_name, meeting: state.meeting, cycle_id: state.cycle_id, master: state.master, date: state.date
  };
  const list = await loadReviews();
  list.push(review);
  await store.command("SET", KEY, JSON.stringify(list.slice(-LIMIT)));
  await conversations.close(message.from.id);
  const title = `«${schedule.MEETINGS[state.meeting].title}», ${state.city_name}`;
  if (review.text && review.consent !== "private") {
    const collections = require("./os-collections");
    await collections.saveItem("library", {
      title: `Отзыв: ${review.consent === "name" ? name || "участница" : "без имени"} · ${title}`,
      category: "reviews", text: review.text, approved: false,
      notes: `Оценка ${review.score}/10 · ${review.consent === "name" ? "можно с именем" : "можно без имени"} · ${review.date}. Проверьте и отметьте «Утверждено».`
    }, "бот");
  }
  const crm = require("./crm");
  await crm.safeTouch(message.from, { type: "review", text: `Отзыв о встрече ${title}: ${review.score}/10${review.text ? ` — ${review.text.slice(0, 300)}` : ""}` });
  if (review.score <= 6) {
    const { notifyAdmins } = require("./payments");
    await notifyAdmins({ text: `⚠️ Низкая оценка встречи ${title}: ${review.score}/10\n${name || "Участница"}${review.username ? ` (@${review.username})` : ""}${review.text ? `\n«${review.text.slice(0, 800)}»` : ""}` });
  }
  await telegram("sendMessage", { chat_id: message.chat.id, text: "Спасибо, что поделилась 🤍 Это очень ценно для нас.", reply_markup: done });
  return true;
}

// Called for plain-text messages while a review conversation is open.
async function handleText(message, state) {
  const text = message.text.trim();
  if (state.step === "score") {
    const score = Number(text);
    if (!(Number.isInteger(score) && score >= 1 && score <= 10)) {
      await telegram("sendMessage", { chat_id: message.chat.id, text: "Выбери, пожалуйста, число от 1 до 10 🙏", reply_markup: scoreKeyboard });
      return true;
    }
    await conversations.open(message.from.id, "review", { ...state, step: "text", score }, 72 * 3600);
    await telegram("sendMessage", { chat_id: message.chat.id, text: "Спасибо! Напиши пару слов: что было самым ценным для тебя на встрече?", reply_markup: { keyboard: [[SKIP]], resize_keyboard: true, one_time_keyboard: true } });
    return true;
  }
  if (state.step === "text") {
    if (text === SKIP) return finish(message, state, "private");
    await conversations.open(message.from.id, "review", { ...state, step: "consent", text: text.slice(0, 2000) }, 72 * 3600);
    await telegram("sendMessage", { chat_id: message.chat.id, text: "Можно поделиться твоим отзывом в пространстве «к Женщине»?", reply_markup: { keyboard: Object.keys(CONSENT).map((k) => [k]), resize_keyboard: true, one_time_keyboard: true } });
    return true;
  }
  if (state.step === "consent") return finish(message, state, CONSENT[text] || "private");
  await conversations.close(message.from.id);
  return false;
}

// Average score per cycle (and per city for meetings outside cycles).
async function stats() {
  const by = {};
  for (const r of await loadReviews()) {
    const key = r.cycle_id || `city:${r.city_id}`;
    const s = by[key] || (by[key] = { count: 0, sum: 0 });
    s.count += 1; s.sum += r.score;
  }
  for (const s of Object.values(by)) s.avg = Math.round((s.sum / s.count) * 10) / 10;
  return by;
}

module.exports = { runReviewRequests, handleText, loadReviews, stats };
