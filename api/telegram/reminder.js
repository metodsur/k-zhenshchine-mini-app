const { telegram, isChannelMember, safeEqualString } = require("../../lib/telegram");

function send(res, status, body) { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); }

const TEXTS = {
  "10m": "Мы очень хотим видеть тебя в нашем пространстве 😍\nПосле вступления в канал тебе откроется полный функционал приложения.",
  "24h": "Мы всё ещё ждём тебя в пространстве «к Женщине» 🤍\nЗдесь женщины поддерживают друг друга, проходят ритуалы и встречаются вживую. Присоединяйся — тебе здесь рады."
};

// Delayed by QStash after /start. Only people who still have not joined the channel get the message.
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  if (!safeEqualString(req.headers["x-reminder-secret"], process.env.TELEGRAM_REMINDER_SECRET)) return send(res, 403, { ok: false });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { return send(res, 400, { ok: false }); }
  const { chatId, userId } = body;
  if (!chatId || !userId) return send(res, 400, { ok: false });
  try {
    if (await isChannelMember(userId)) return send(res, 200, { ok: true, skipped: "member" });
    await telegram("sendMessage", {
      chat_id: chatId,
      text: TEXTS[body.stage] || TEXTS["10m"],
      reply_markup: { inline_keyboard: [[{ text: "Присоединиться к пространству", url: process.env.TELEGRAM_CHANNEL_URL }]] }
    });
    return send(res, 200, { ok: true });
  } catch { return send(res, 500, { ok: false }); }
};
