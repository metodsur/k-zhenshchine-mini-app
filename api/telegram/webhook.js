const { telegram, isChannelMember, isMemberStatus, safeEqualString } = require("../../lib/telegram");

function send(res, status, body) {
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(body));
}
function appKeyboard() {
  const appUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  return { inline_keyboard: [[{ text: "РћС‚РєСЂС‹С‚СЊ РїСЂРёР»РѕР¶РµРЅРёРµ", web_app: { url: `${appUrl}/welcome-personal-telegram-ready.html` } }]] };
}
function channelKeyboard() {
  return { inline_keyboard: [[{ text: "РџСЂРёСЃРѕРµРґРёРЅРёС‚СЊСЃСЏ Рє РїСЂРѕСЃС‚СЂР°РЅСЃС‚РІСѓ", url: process.env.TELEGRAM_CHANNEL_URL }]] };
}
async function sendJoined(chatId) {
  await telegram("sendMessage", { chat_id: chatId, text: "Р’РёРґРёРј, С‡С‚Рѕ С‚С‹ РїСЂРёСЃРѕРµРґРёРЅРёР»Р°СЃСЊ Рє РїСЂРѕСЃС‚СЂР°РЅСЃС‚РІСѓ рџ¤Ќ\nРћС‚РєСЂРѕР№ РїСЂРёР»РѕР¶РµРЅРёРµ", reply_markup: appKeyboard() });
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
        await telegram("sendMessage", { chat_id: message.chat.id, text: "РџСЂРёСЃРѕРµРґРёРЅРёСЃСЊ Рє РЅР°С€РµРјСѓ РїСЂРѕСЃС‚СЂР°РЅСЃС‚РІСѓ вЂ” РїРѕСЃР»Рµ РїРѕРґРїРёСЃРєРё РѕС‚РєСЂРѕРµС‚СЃСЏ РїРѕР»РЅС‹Р№ С„СѓРЅРєС†РёРѕРЅР°Р» РїСЂРёР»РѕР¶РµРЅРёСЏ.", reply_markup: channelKeyboard() });
        await scheduleReminder(message.chat.id, userId);
      }
    }
    const change = update.chat_member;
    if (change && String(change.chat.id) === String(process.env.TELEGRAM_CHANNEL_ID)) {
      const oldStatus = change.old_chat_member?.status;
      const newStatus = change.new_chat_member?.status;
      if (!isMemberStatus(oldStatus) && isMemberStatus(newStatus)) await sendJoined(change.new_chat_member.user.id);
    }
    return send(res, 200, { ok: true });
  } catch { return send(res, 500, { ok: false }); }
};
