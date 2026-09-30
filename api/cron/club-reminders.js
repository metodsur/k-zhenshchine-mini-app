const { telegram, safeEqualString } = require("../../lib/telegram");
const tribute = require("../../lib/tribute");
const store = require("../../lib/store");

const DAY_MS = 24 * 60 * 60 * 1000;
// A daily run covers a 26-hour window so schedule jitter never skips anyone;
// storage-based de-duplication prevents a second message for the same period.
const WINDOW_MS = 26 * 60 * 60 * 1000;
const PAYMENT_URL = "https://t.me/tribute/app?startapp=s17IJ";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function formatDate(iso) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric", month: "long", timeZone: process.env.REMINDER_TIMEZONE || "Europe/Moscow"
  }).format(new Date(iso));
}

function reminderFor(subscriber) {
  const date = formatDate(subscriber.expireAt);
  const link = subscriber.link || PAYMENT_URL;
  if (subscriber.status === "active") {
    return {
      text: `Напоминаем: ${date} продлится твоя подписка на клуб «к Женщине», оплата спишется автоматически 🤍\nЕсли хочешь что-то изменить, управлять подпиской можно в Tribute.`,
      reply_markup: { inline_keyboard: [[{ text: "Управлять подпиской", url: link }]] }
    };
  }
  if (subscriber.status === "pre_cancelled") {
    return {
      text: `Твой доступ к клубу «к Женщине» открыт до ${date}.\nМы будем рады, если ты останешься с нами — продлить подписку можно по кнопке ниже 🤍`,
      reply_markup: { inline_keyboard: [[{ text: "Продлить подписку", url: link }]] }
    };
  }
  return null;
}

function dueForReminder(subscriber, now, daysBefore) {
  if (!subscriber.expireAt || !subscriber.telegramUserId) return false;
  const target = now + daysBefore * DAY_MS;
  const expires = new Date(subscriber.expireAt).getTime();
  return expires > target - WINDOW_MS && expires <= target;
}

async function runReminders(now = Date.now()) {
  const daysBefore = Number(process.env.CLUB_REMINDER_DAYS) || 3;
  const subscribers = await tribute.listSubscribers();
  const result = { checked: subscribers.length, sent: 0, skipped: 0, failed: 0 };

  for (const subscriber of subscribers) {
    const message = dueForReminder(subscriber, now, daysBefore) && reminderFor(subscriber);
    if (!message) continue;
    const key = `reminder:club:${subscriber.telegramUserId}:${subscriber.expireAt}`;
    try {
      if (!(await store.claimOnce(key, 10 * 24 * 60 * 60))) { result.skipped += 1; continue; }
      await telegram("sendMessage", { chat_id: subscriber.telegramUserId, ...message });
      result.sent += 1;
    } catch {
      // Usually the person has never started the bot, so Telegram refuses the message.
      result.failed += 1;
    }
  }
  return result;
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqualString(req.headers.authorization, `Bearer ${secret}`)) return send(res, 403, { ok: false });
  try {
    const result = await runReminders();
    console.log("Club reminders", JSON.stringify(result));
    return send(res, 200, { ok: true, ...result });
  } catch (error) {
    console.error("Club reminders failed", error.message);
    return send(res, 500, { ok: false });
  }
};

module.exports.runReminders = runReminders;
module.exports.dueForReminder = dueForReminder;
