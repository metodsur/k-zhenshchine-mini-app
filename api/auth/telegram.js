const crypto = require("crypto");

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function verifyInitData(initData, botToken, maxAgeSeconds = 86400) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("Missing hash");

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) throw new Error("Invalid auth_date");
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > maxAgeSeconds) throw new Error("Expired initData");

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key !== "hash" && key !== "signature") pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(calculatedHash, "hex");
  const b = Buffer.from(receivedHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Invalid signature");

  const rawUser = params.get("user");
  return { user: rawUser ? JSON.parse(rawUser) : null };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed" });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return send(res, 500, { ok: false, error: "Server configuration error" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const initData = body && body.initData;
  if (!initData || typeof initData !== "string") return send(res, 400, { ok: false, error: "Missing initData" });

  try {
    const { user: u = {} } = verifyInitData(initData, token);
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
