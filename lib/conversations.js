// Replies to the bot. After the bot writes to a woman first (payment reminder, broadcast,
// review request), her next plain-text answers within the window reach the team and the CRM card.
const store = require("./store");

const key = (userId) => `conv:${userId}`;
const WINDOW_SECONDS = 48 * 3600;
const TOPICS = { checkout: "напоминание об оплате", broadcast: "рассылку", review: "просьбу об отзыве" };

async function open(userId, topic, extra = {}, ttl = WINDOW_SECONDS) {
  await store.command("SET", key(userId), JSON.stringify({ topic, ...extra, at: new Date().toISOString() }), "EX", ttl);
}
async function get(userId) {
  const raw = await store.command("GET", key(userId));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function close(userId) { await store.command("DEL", key(userId)); }

// Returns true when the message was a reply that has been handled.
async function handleReply(message) {
  if (!message || !message.chat || message.chat.type !== "private") return false;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text || text.startsWith("/")) return false;
  const state = await get(message.from.id);
  if (!state) return false;
  if (state.topic === "review") return require("./reviews").handleText(message, state);
  const crm = require("./crm");
  const { notifyAdmins } = require("./payments");
  const { telegram } = require("./telegram");
  const who = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "Без имени";
  const tg = message.from.username ? `@${message.from.username}` : `id ${message.from.id}`;
  await crm.safeTouch(message.from, { type: "message", text: `Ответила на ${TOPICS[state.topic] || "сообщение"}: ${text.slice(0, 400)}`, next_step: { date: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), action: "Ответить на сообщение в боте" } });
  await notifyAdmins({ text: `💬 Ответ на ${TOPICS[state.topic] || "сообщение бота"}\n${who} (${tg}):\n${text.slice(0, 1500)}` });
  await telegram("sendMessage", { chat_id: message.chat.id, text: "Спасибо! Передали команде «к Женщине» — скоро ответим 🤍" });
  return true;
}

module.exports = { open, get, close, handleReply };
