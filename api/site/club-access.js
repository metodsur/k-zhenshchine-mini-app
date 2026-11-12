const { telegram, safeEqualString } = require("../../lib/telegram");
const { send, readBody } = require("../../lib/http");

const REMINDERS = Object.freeze({
  1: "Напоминаем: срок доступа к клубу «Наполнение» скоро завершится. Продлить участие можно на towomen.ru 🤍",
  3: "До завершения доступа к клубу «Наполнение» осталось 3 дня. Продлить участие можно на towomen.ru 🤍",
  7: "До завершения доступа к клубу «Наполнение» осталась неделя. Продлить участие можно на towomen.ru 🤍"
});
const EXPIRED_MESSAGE = "Срок доступа к клубу завершился. Если ты уже продлила участие, пожалуйста, напиши нам на towomen.ru — мы поможем 🤍";

function authorized(req) {
  const secret = process.env.CLUB_TELEGRAM_SECRET;
  const header = String((req.headers && req.headers.authorization) || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(secret && match && safeEqualString(match[1], secret));
}
function clubId() {
  const id = String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim();
  if (!id) throw new Error("Missing TELEGRAM_CLUB_CHAT_ID");
  return id;
}
function userId(value) {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  if (!authorized(req)) return send(res, 403, { ok: false });
  const body = readBody(req);
  const action = body.action;
  const telegramId = userId(body.telegram_id);
  if (!telegramId || !["invite", "remove", "notify"].includes(action)) return send(res, 400, { ok: false });
  try {
    const chatId = clubId();
    if (action === "invite") {
      await telegram("unbanChatMember", { chat_id: chatId, user_id: telegramId, only_if_banned: true });
      const invite = await telegram("createChatInviteLink", {
        chat_id: chatId,
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 600
      });
      await telegram("sendMessage", { chat_id: telegramId, text: `Вот твоя персональная ссылка для входа в клуб «Наполнение» (действует 10 минут): ${invite.invite_link}` });
      return send(res, 200, { ok: true });
    }
    if (action === "remove") {
      await telegram("banChatMember", { chat_id: chatId, user_id: telegramId });
      await telegram("unbanChatMember", { chat_id: chatId, user_id: telegramId, only_if_banned: true });
      await telegram("sendMessage", { chat_id: telegramId, text: EXPIRED_MESSAGE });
      return send(res, 200, { ok: true });
    }
    const reminder = REMINDERS[Number(body.daysBefore)];
    if (!reminder) return send(res, 400, { ok: false });
    await telegram("sendMessage", { chat_id: telegramId, text: reminder });
    return send(res, 200, { ok: true });
  } catch {
    return send(res, 502, { ok: false });
  }
};
