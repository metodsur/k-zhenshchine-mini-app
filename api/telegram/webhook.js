function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
async function telegram(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram API request failed");
  return response.json();
}
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res,405,{ok:false});
  const token=process.env.TELEGRAM_BOT_TOKEN;
  const secret=process.env.TELEGRAM_WEBHOOK_SECRET;
  const appUrl=process.env.APP_BASE_URL || "https://k-zhenshchine-mini-app.vercel.app";
  if (!token || !secret) return send(res,500,{ok:false});
  if (req.headers["x-telegram-bot-api-secret-token"] !== secret) return send(res,403,{ok:false});
  const message=(req.body || {}).message;
  if (message?.chat && typeof message.text==="string" && message.text.startsWith("/start")) {
    try {
      await telegram("sendMessage", {
        chat_id:message.chat.id,
        text:"Р”РѕР±СЂРѕ РїРѕР¶Р°Р»РѕРІР°С‚СЊ РІ В«Рє Р–РµРЅС‰РёРЅРµВ».",
        reply_markup:{inline_keyboard:[[{text:"РћС‚РєСЂС‹С‚СЊ РїСЂРёР»РѕР¶РµРЅРёРµ",web_app:{url:appUrl}}]]}
      });
    } catch { return send(res,500,{ok:false}); }
  }
  return send(res,200,{ok:true});
};
