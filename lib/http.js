const { verifyInitData } = require("./telegram");

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

// Returns the verified Telegram user or null.
function telegramUser(body) {
  try { return verifyInitData(body && body.initData); } catch { return null; }
}

function adminIds() {
  return String(process.env.ADMIN_TELEGRAM_IDS || "").split(/[\s,;]+/).filter(Boolean);
}

function isAdmin(user) {
  return Boolean(user && adminIds().includes(String(user.id)));
}

module.exports = { send, readBody, telegramUser, adminIds, isAdmin };
