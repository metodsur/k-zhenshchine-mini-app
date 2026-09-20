const { telegram, isChannelMember, safeEqualString } = require("../../lib/telegram");
function send(res, status, body) { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); }
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  if (!safeEqualString(req.headers["x-reminder-secret"], process.env.TELEGRAM_REMINDER_SECRET)) return send(res, 403, { ok: false });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { return send(res, 400, { ok: false }); }
  const { chatId, userId } = body;
  if (!chatId || !userId) return send(res, 400, { ok: false });
  try {
    if (await isChannelMember(userId)) {
      const appUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
      await telegram("sendMessage", { chat_id: chatId, text: "Видим, что ты присоединилась к пространству 🤍\nОткрой приложение", reply_markup: { inline_keyboard: [[{ text: "Открыть приложение", web_app: { url: appUrl } }]] } });
    } else {
      await telegram("sendMessage", { chat_id: chatId, text: "Мы очень хотим видеть тебя в нашем пространстве 😍\nПосле подписки тебе откроется полный функционал приложения", reply_markup: { inline_keyboard: [[{ text: "Присоединиться к пространству", url: process.env.TELEGRAM_CHANNEL_URL }]] } });
    }
    return send(res, 200, { ok: true });
  } catch { return send(res, 500, { ok: false }); }
};
