const { verifyInitData } = require("../../lib/telegram");

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed" });
  if (!process.env.TELEGRAM_BOT_TOKEN) return send(res, 500, { ok: false, error: "Server configuration error" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const initData = body && body.initData;
  if (!initData || typeof initData !== "string") return send(res, 400, { ok: false, error: "Missing initData" });

  try {
    const u = verifyInitData(initData);
    return send(res, 200, { ok: true, user: {
      telegram_user_id: u.id || null,
      username: u.username || null,
      first_name: u.first_name || null,
      last_name: u.last_name || null,
      language_code: u.language_code || null
    }});
  } catch {
    return send(res, 401, { ok: false, error: "Invalid Telegram authorization" });
  }
};
