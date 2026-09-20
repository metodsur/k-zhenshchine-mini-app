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
      await telegram("sendMessage", { chat_id: chatId, text: "\u0412\u0438\u0434\u0438\u043c, \u0447\u0442\u043e \u0442\u044b \u043f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d\u0438\u043b\u0430\u0441\u044c \u043a \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0443 \ud83d\ude42\n\u041f\u0435\u0440\u0435\u0445\u043e\u0434\u0438 \u0432 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435, \u0438 \u0442\u0435\u0431\u0435 \u0431\u0443\u0434\u0443\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u043d\u044b \u0432\u0441\u0435 \u044d\u0442\u0430\u043f\u044b \u044d\u043a\u043e\u0441\u0438\u0441\u0442\u0435\u043c\u044b \u00ab\u043a \u0416\u0435\u043d\u0449\u0438\u043d\u0435\u00bb \u2764\ufe0f", reply_markup: { inline_keyboard: [[{ text: "\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435", web_app: { url: `${appUrl}/welcome-personal-telegram-ready.html` } }]] } });
    } else {
      await telegram("sendMessage", { chat_id: chatId, text: "\u041c\u044b \u043e\u0447\u0435\u043d\u044c \u0445\u043e\u0442\u0438\u043c \u0432\u0438\u0434\u0435\u0442\u044c \u0442\u0435\u0431\u044f \u0432 \u043d\u0430\u0448\u0435\u043c \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0435 \ud83d\ude0d\n\u041f\u043e\u0441\u043b\u0435 \u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0438 \u0442\u0435\u0431\u0435 \u043e\u0442\u043a\u0440\u043e\u0435\u0442\u0441\u044f \u043f\u043e\u043b\u043d\u044b\u0439 \u0444\u0443\u043d\u043a\u0446\u0438\u043e\u043d\u0430\u043b \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u044f", reply_markup: { inline_keyboard: [[{ text: "\u041f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d\u0438\u0442\u044c\u0441\u044f \u043a \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0443", url: process.env.TELEGRAM_CHANNEL_URL }]] } });
    }
    return send(res, 200, { ok: true });
  } catch { return send(res, 500, { ok: false }); }
};
