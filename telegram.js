const crypto = require("crypto");

async function telegram(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed`);
  return data.result;
}

function isMemberStatus(status) {
  return status === "creator" || status === "administrator" || status === "member" || status === "restricted";
}

async function isChannelMember(userId) {
  if (!process.env.TELEGRAM_CHANNEL_ID) throw new Error("Missing TELEGRAM_CHANNEL_ID");
  try {
    const member = await telegram("getChatMember", { chat_id: process.env.TELEGRAM_CHANNEL_ID, user_id: userId });
    return isMemberStatus(member.status) && member.is_member !== false;
  } catch { return false; }
}

function verifyInitData(initData, maxAgeSeconds = 3600) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!receivedHash || !Number.isFinite(authDate)) throw new Error("Invalid initData");
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > maxAgeSeconds) throw new Error("Expired initData");
  const pairs = [];
  for (const [key, value] of params.entries()) if (key !== "hash" && key !== "signature") pairs.push(`${key}=${value}`);
  pairs.sort();
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const calculated = crypto.createHmac("sha256", secretKey).update(pairs.join("\n")).digest("hex");
  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(receivedHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Invalid signature");
  const rawUser = params.get("user");
  const user = rawUser ? JSON.parse(rawUser) : null;
  if (!user || !user.id) throw new Error("Missing Telegram user");
  return user;
}

function safeEqualString(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { telegram, isChannelMember, isMemberStatus, verifyInitData, safeEqualString };
