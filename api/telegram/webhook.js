const { telegram, isChannelMember, isMemberStatus, safeEqualString } = require("../../lib/telegram");
const store = require("../../lib/store");
const payments = require("../../lib/payments");
const stats = require("../../lib/stats");

function send(res, status, body) {
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(body));
}
function appKeyboard() {
  const appUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  return { inline_keyboard: [[{ text: "\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435", web_app: { url: `${appUrl}/welcome-personal-telegram-ready.html` } }]] };
}
function channelKeyboard() {
  return { inline_keyboard: [[{ text: "\u041f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d\u0438\u0442\u044c\u0441\u044f \u043a \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0443", url: process.env.TELEGRAM_CHANNEL_URL }]] };
}
async function sendJoined(chatId) {
  await telegram("sendMessage", { chat_id: chatId, text: "\u0412\u0438\u0434\u0438\u043c, \u0447\u0442\u043e \u0442\u044b \u043f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d\u0438\u043b\u0430\u0441\u044c \u043a \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0443 \ud83d\ude42\n\u041f\u0435\u0440\u0435\u0445\u043e\u0434\u0438 \u0432 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435, \u0438 \u0442\u0435\u0431\u0435 \u0431\u0443\u0434\u0443\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u043d\u044b \u0432\u0441\u0435 \u044d\u0442\u0430\u043f\u044b \u044d\u043a\u043e\u0441\u0438\u0441\u0442\u0435\u043c\u044b \u00ab\u043a \u0416\u0435\u043d\u0449\u0438\u043d\u0435\u00bb \u2764\ufe0f", reply_markup: appKeyboard() });
}
function spaceKeyboard() {
  const appUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  return { inline_keyboard: [[{ text: "Открыть пространство", web_app: { url: `${appUrl}/space.html` } }]] };
}
// Channel members go straight to the app; the start pages are only for the first visit.
async function sendMemberEntry(chatId, userId) {
  let onboarded = false;
  try { onboarded = await store.isOnboarded(userId); } catch { onboarded = false; }
  if (onboarded) {
    await telegram("sendMessage", { chat_id: chatId, text: "С возвращением в «к Женщине» 🤍\nПространство, путь, встречи и твоя страница — по кнопке ниже.", reply_markup: spaceKeyboard() });
  } else {
    await telegram("sendMessage", { chat_id: chatId, text: "Добро пожаловать в «к Женщине» 🤍\nНачнём знакомство с пространством.", reply_markup: appKeyboard() });
  }
}
async function isMemberSafe(userId) {
  try { return await isChannelMember(userId); } catch { return false; }
}
async function scheduleReminder(chatId, userId) {
  const token = process.env.QSTASH_TOKEN;
  const secret = process.env.TELEGRAM_REMINDER_SECRET;
  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!token || !secret || !baseUrl) throw new Error("Reminder service is not configured");
  const destination = `${baseUrl}/api/telegram/reminder`;
  const response = await fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(destination)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Upstash-Delay": "5m", "Upstash-Forward-X-Reminder-Secret": secret },
    body: JSON.stringify({ chatId, userId })
  });
  if (!response.ok) throw new Error("Could not schedule reminder");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_CHANNEL_ID", "TELEGRAM_CHANNEL_URL", "APP_BASE_URL"];
  if (required.some((name) => !process.env[name])) return send(res, 500, { ok: false, error: "Server configuration error" });
  if (!safeEqualString(req.headers["x-telegram-bot-api-secret-token"], process.env.TELEGRAM_WEBHOOK_SECRET)) return send(res, 403, { ok: false });
  const update = req.body || {};
  try {
    if (await payments.handleUpdate(update)) return send(res, 200, { ok: true });
    const message = update.message;
    if (message?.chat?.type === "private" && typeof message.text === "string" && message.text.startsWith("/start")) await stats.trackStart(message.from.id);
    if (message?.chat?.type === "private" && typeof message.text === "string" && /^\/space(@\w+)?(\s|$)/.test(message.text)) {
      if (await isMemberSafe(message.from.id)) {
        await telegram("sendMessage", { chat_id: message.chat.id, text: "Твоё пространство «к Женщине» 🤍", reply_markup: spaceKeyboard() });
      } else {
        await telegram("sendMessage", { chat_id: message.chat.id, text: "Пространство откроется после вступления в канал «к Женщине» 🤍", reply_markup: channelKeyboard() });
      }
      return send(res, 200, { ok: true });
    }
    if (message?.chat && typeof message.text === "string" && message.text.startsWith("/start") && await isMemberSafe(message.from.id)) {
      await sendMemberEntry(message.chat.id, message.from.id);
      return send(res, 200, { ok: true });
    }
    if (message?.chat && typeof message.text === "string" && message.text.startsWith("/start")) {
      const userId = message.from.id;
      const appUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
      await telegram("sendMessage", {
        chat_id: message.chat.id,
        text: "\u0414\u043e\u0431\u0440\u043e \u043f\u043e\u0436\u0430\u043b\u043e\u0432\u0430\u0442\u044c \u0432 \u00ab\u043a \u0416\u0435\u043d\u0449\u0438\u043d\u0435\u00bb.",
        reply_markup: { inline_keyboard: [[{
          text: "\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435",
          web_app: { url: appUrl }
        }]] }
      });
      try { await scheduleReminder(message.chat.id, userId); } catch (error) { console.error("Reminder scheduling failed"); }
    }
    if (message?.chat && typeof message.text === "string" && /^\/chatid(@\w+)?(\s|$)/.test(message.text)
        && (message.chat.type === "group" || message.chat.type === "supergroup")) {
      // Only group admins can ask the bot for the group ID (needed for TELEGRAM_CLUB_CHAT_ID).
      const sender = await telegram("getChatMember", { chat_id: message.chat.id, user_id: message.from.id });
      if (sender.status === "creator" || sender.status === "administrator") {
        await telegram("sendMessage", { chat_id: message.chat.id, text: `ID \u044d\u0442\u043e\u0439 \u0433\u0440\u0443\u043f\u043f\u044b: ${message.chat.id}` });
      }
    }
    const change = update.chat_member;
    const configuredChannel = String(process.env.TELEGRAM_CHANNEL_ID || "").toLowerCase();
    const updateUsername = change?.chat?.username ? `@${change.chat.username}`.toLowerCase() : "";
    const isConfiguredChannel = change && (String(change.chat.id) === configuredChannel || updateUsername === configuredChannel);
    if (isConfiguredChannel) {
      const oldStatus = change.old_chat_member?.status;
      const newStatus = change.new_chat_member?.status;
      if (!isMemberStatus(oldStatus) && isMemberStatus(newStatus)) {
        const joinedUserId = change.new_chat_member.user.id;
        const joinedAt = new Date((change.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
        try {
          if (Number(await store.rememberChannelJoin(joinedUserId, joinedAt)) === 1) await stats.trackChannelJoin(new Date(joinedAt));
        } catch (error) { console.error("Join date storage failed"); }
        await sendJoined(joinedUserId);
      }
    }
    return send(res, 200, { ok: true });
  } catch (error) {
    console.error("Telegram update processing failed");
    return send(res, 200, { ok: true });
  }
};
