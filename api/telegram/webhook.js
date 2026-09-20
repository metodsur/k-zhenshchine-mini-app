const { telegram, isChannelMember, isMemberStatus, safeEqualString } = require("../../lib/telegram");

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
  await telegram("sendMessage", { chat_id: chatId, text: "\u0412\u0438\u0434\u0438\u043c, \u0447\u0442\u043e \u0442\u044b \u043f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d\u0438\u043b\u0430\u0441\u044c \u043a \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0443 \ud83e\udd0d\n\u041e\u0442\u043a\u0440\u043e\u0439 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435", reply_markup: appKeyboard() });
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
    const message = update.message;
    if (message?.chat && typeof message.text === "string" && message.text.startsWith("/start")) {
      const userId = message.from.id;
      if (await isChannelMember(userId)) await sendJoined(message.chat.id);
      else {
        await telegram("sendMessage", { chat_id: message.chat.id, text: "\u041f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d\u0438\u0441\u044c \u043a \u043d\u0430\u0448\u0435\u043c\u0443 \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0443 \u2014 \u043f\u043e\u0441\u043b\u0435 \u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0438 \u043e\u0442\u043a\u0440\u043e\u0435\u0442\u0441\u044f \u043f\u043e\u043b\u043d\u044b\u0439 \u0444\u0443\u043d\u043a\u0446\u0438\u043e\u043d\u0430\u043b \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u044f.", reply_markup: channelKeyboard() });
        try { await scheduleReminder(message.chat.id, userId); } catch (error) { console.error("Reminder scheduling failed"); }
      }
    }
    const change = update.chat_member;
    const configuredChannel = String(process.env.TELEGRAM_CHANNEL_ID || "").toLowerCase();
    const updateUsername = change?.chat?.username ? `@${change.chat.username}`.toLowerCase() : "";
    const isConfiguredChannel = change && (String(change.chat.id) === configuredChannel || updateUsername === configuredChannel);
    if (isConfiguredChannel) {
      const oldStatus = change.old_chat_member?.status;
      const newStatus = change.new_chat_member?.status;
      if (!isMemberStatus(oldStatus) && isMemberStatus(newStatus)) await sendJoined(change.new_chat_member.user.id);
    }
    return send(res, 200, { ok: true });
  } catch (error) {
    console.error("Telegram update processing failed");
    return send(res, 200, { ok: true });
  }
};
