const crypto = require("crypto");
const crm = require("../../lib/crm");
const store = require("../../lib/store");
const { send, readBody } = require("../../lib/http");

const ALLOWED_ORIGINS = new Set(["https://towomen.ru", "https://www.towomen.ru"]);
const CONSENT_VERSION = "2026-10-26";
const RATE_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT = 8;

function setCors(req, res) {
  const origin = String((req.headers && req.headers.origin) || "");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (!ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

function clientKey(req) {
  const headers = req.headers || {};
  const forwarded = String(headers["x-forwarded-for"] || "").split(",")[0].trim();
  const address = forwarded || String(headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "unknown");
  return crypto.createHash("sha256").update(address).digest("hex").slice(0, 32);
}

module.exports = async function handler(req, res) {
  if (!setCors(req, res)) return send(res, 403, { ok: false });
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return send(res, 405, { ok: false });

  const body = readBody(req);
  if (body.website) return send(res, 200, { ok: true }); // Honeypot for bots; never store its contents.

  const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const phone = String(body.phone || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const username = String(body.username || body.telegram || "").trim().replace(/^@/, "").slice(0, 32);
  if (name.length < 2) return send(res, 400, { ok: false, error: "Укажите имя" });
  const digits = phone.replace(/\D/g, "");
  if (!/^[+\d\s().-]+$/.test(phone) || digits.length < 7 || digits.length > 15) return send(res, 400, { ok: false, error: "Проверьте номер телефона" });
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return send(res, 400, { ok: false, error: "Укажите ник Telegram, например @anna" });
  if (body.consent !== true) return send(res, 400, { ok: false, error: "Подтвердите согласие на обработку персональных данных" });
  if (body.consent_version !== CONSENT_VERSION) return send(res, 400, { ok: false, error: "Обновите страницу и отправьте заявку ещё раз" });
  if (!store.isConfigured()) return send(res, 503, { ok: false, error: "Форма временно недоступна. Попробуйте позже" });

  try {
    const rateKey = `site:club-form:rate:${clientKey(req)}`;
    const count = Number(await store.command("INCR", rateKey)) || 0;
    if (count === 1) await store.command("EXPIRE", rateKey, RATE_WINDOW_SECONDS);
    if (count > RATE_LIMIT) return send(res, 429, { ok: false, error: "Слишком много заявок. Попробуйте позже" });

    const result = await crm.createWebsiteLead({ name, phone, username }, CONSENT_VERSION);
    if (!result.card) return send(res, result.status || 400, { ok: false, error: (result.errors || ["Не получилось отправить заявку"])[0] });
    return send(res, 200, { ok: true });
  } catch (error) {
    console.error("Website club application failed", error && error.message);
    return send(res, 503, { ok: false, error: "Не удалось отправить заявку. Попробуйте позже" });
  }
};
