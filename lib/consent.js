// Consent to personal data processing (152-FZ): asked before anything about the woman is stored.
// Given in the bot ("Согласна" button) or in the Mini App (overlay), kept with date and version.
const store = require("./store");

const VERSION = "2026-10-05";
const AGREE = "Согласна ✅";
const userKey = (id) => `user:${id}`;

function policyUrl(settings) {
  const own = settings && settings.privacy_url;
  return own || `${String(process.env.APP_BASE_URL || "").replace(/\/$/, "")}/privacy.html`;
}

async function has(userId) {
  return Boolean(await store.command("HGET", userKey(userId), "consent_at"));
}

// Records consent once; the audit log keeps every confirmation.
async function record(userId, source) {
  const at = new Date().toISOString();
  await store.command("HSETNX", userKey(userId), "consent_at", at);
  await store.command("HSETNX", userKey(userId), "consent_version", VERSION);
  try { await store.command("LPUSH", "consents", JSON.stringify({ user_id: String(userId), at, version: VERSION, source })); } catch { /* the user hash is enough */ }
  return at;
}

const isAgree = (text) => /^согласн(а|ен|ы)(\s|$)/iu.test(String(text || "").replace(/[^\p{L}\s]/gu, "").trim());

function botMessage(settings) {
  const url = policyUrl(settings);
  return {
    text: "Добро пожаловать в «к Женщине» 🤍\n\n" +
      "Перед началом нам нужно твоё согласие на обработку персональных данных: имени, имени пользователя и ID в Telegram, а также данных, которые ты сама укажешь (телефон, email, город). " +
      "Они нужны, чтобы открыть тебе пространство, записывать на встречи и присылать важные сообщения.\n\n" +
      `Нажимая «Согласна», ты подтверждаешь, что ознакомилась с <a href="${url}">Политикой обработки персональных данных</a> и даёшь согласие на обработку своих данных на её условиях. Согласие можно отозвать в любой момент, написав нам.`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { keyboard: [[{ text: AGREE }]], resize_keyboard: true, one_time_keyboard: true }
  };
}

module.exports = { VERSION, AGREE, has, record, isAgree, policyUrl, botMessage };
