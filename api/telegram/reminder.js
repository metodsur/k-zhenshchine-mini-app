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
      await telegram("sendMessage", { chat_id: chatId, text: "Р’РёРґРёРј, С‡С‚Рѕ С‚С‹ РїСЂРёСЃРѕРµРґРёРЅРёР»Р°СЃСЊ Рє РїСЂРѕСЃС‚СЂР°РЅСЃС‚РІСѓ рџ¤Ќ\nРћС‚РєСЂРѕР№ РїСЂРёР»РѕР¶РµРЅРёРµ", reply_markup: { inline_keyboard: [[{ text: "РћС‚РєСЂС‹С‚СЊ РїСЂРёР»РѕР¶РµРЅРёРµ", web_app: { url: `${appUrl}/welcome-personal-telegram-ready.html` } }]] } });
    } else {
      await telegram("sendMessage", { chat_id: chatId, text: "РњС‹ РѕС‡РµРЅСЊ С…РѕС‚РёРј РІРёРґРµС‚СЊ С‚РµР±СЏ РІ РЅР°С€РµРј РїСЂРѕСЃС‚СЂР°РЅСЃС‚РІРµ рџЌ\nРџРѕСЃР»Рµ РїРѕРґРїРёСЃРєРё С‚РµР±Рµ РѕС‚РєСЂРѕРµС‚СЃСЏ РїРѕР»РЅС‹Р№ С„СѓРЅРєС†РёРѕРЅР°Р» РїСЂРёР»РѕР¶РµРЅРёСЏ", reply_markup: { inline_keyboard: [[{ text: "РџСЂРёСЃРѕРµРґРёРЅРёС‚СЊСЃСЏ Рє РїСЂРѕСЃС‚СЂР°РЅСЃС‚РІСѓ", url: process.env.TELEGRAM_CHANNEL_URL }]] } });
    }
    return send(res, 200, { ok: true });
  } catch { return send(res, 500, { ok: false }); }
};
