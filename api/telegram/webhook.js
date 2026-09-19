function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function telegram(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram API request failed");
  return response.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, {ok:false});

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const appUrl = process.env.APP_BASE_URL || "https://k-zhenshchine-mini-app.vercel.app";

  if (!token || !secret) return send(res, 500, {ok:false});
  if (req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return send(res, 403, {ok:false});
  }

  const message = (req.body || {}).message;

  if (message?.chat && typeof message.text === "string" && message.text.startsWith("/start")) {
    try {
      await telegram("sendMessage", {
        chat_id: message.chat.id,
        text: "\u0414\u043e\u0431\u0440\u043e \u043f\u043e\u0436\u0430\u043b\u043e\u0432\u0430\u0442\u044c \u0432 \u00ab\u043a \u0416\u0435\u043d\u0449\u0438\u043d\u0435\u00bb.",
        reply_markup: {
          inline_keyboard: [[{
            text: "\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435",
            web_app: {url: `${appUrl.replace(/\/$/, "")}/welcome-personal-telegram-ready.html`}
          }]]
        }
      });
    } catch {
      return send(res, 500, {ok:false});
    }
  }

  return send(res, 200, {ok:true});
};
