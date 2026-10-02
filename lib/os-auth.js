// Sign-in to the management dashboard (os.html) without telegram.org (blocked in Russia):
// the bot sends a one-time link → the page exchanges it for a session cookie.
const crypto = require("crypto");
const store = require("./store");
const team = require("./team");

const LOGIN_TTL_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const COOKIE = "kz_os";
const loginKey = (token) => `os_login:${token}`;
const sessionKey = (sid) => `os_session:${sid}`;
const randomId = () => crypto.randomBytes(24).toString("hex");

function appUrl(path) {
  return `${String(process.env.OS_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/$/, "")}/${path}`;
}

// One-time login link for a team member (null when the person has no dashboard access).
async function createLoginLink(userId) {
  const member = await team.getMember(userId);
  if (!team.can(member, "os.access")) return null;
  const token = randomId();
  await store.command("SET", loginKey(token), String(userId), "EX", LOGIN_TTL_SECONDS);
  return appUrl(`os.html#login=${token}`);
}

// Exchanges a login token for a session id; the token works once.
async function redeem(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ""))) return null;
  const userId = await store.command("GET", loginKey(token));
  if (!userId) return null;
  await store.command("DEL", loginKey(token));
  const member = await team.getMember(userId);
  if (!team.can(member, "os.access")) return null;
  const sid = randomId();
  await store.command("SET", sessionKey(sid), String(userId), "EX", SESSION_TTL_SECONDS);
  return { sid, member };
}

function readCookie(req) {
  const header = String((req.headers && req.headers.cookie) || "");
  const match = header.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  return match ? match.slice(COOKIE.length + 1) : "";
}

// The team member behind the request's session, or null. Access is re-checked on every
// request, so removing someone from the team (or changing the role) takes effect at once.
async function memberFromRequest(req) {
  const sid = readCookie(req);
  if (!/^[a-f0-9]{48}$/.test(sid)) return null;
  const userId = await store.command("GET", sessionKey(sid));
  if (!userId) return null;
  const member = await team.getMember(userId);
  return team.can(member, "os.access") ? member : null;
}

async function logout(req) {
  const sid = readCookie(req);
  if (/^[a-f0-9]{48}$/.test(sid)) await store.command("DEL", sessionKey(sid));
}

function sessionCookie(sid) {
  return `${COOKIE}=${sid}; Path=/api/os; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}
const clearCookie = () => `${COOKIE}=; Path=/api/os; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

module.exports = { createLoginLink, redeem, memberFromRequest, logout, sessionCookie, clearCookie, readCookie };
