// A week of the club «Наполнение» as a gift for members of the platform «Уровни» (owner, 29.10.2026).
// The button in her cabinet on yrovni.ru opens the bot with /start yr_<platform id>_<signature>; the signature is
// HMAC-SHA256 with LEVELS_SYNC_SECRET (on «Уровни» the same key is CLUB_SYNC_SECRET), so nobody can make one up.
// One gift per platform member and one per Telegram account. She gets a one-person invite link to the club group;
// the end of the week (reminder, removal without a subscription) is handled with the other gifts in lib/referrals.js.
// If she already pays, the team extends her Tribute subscription by hand. «Уровни» is told until when (POST /api/club-gift).
const crypto = require("crypto");
const { telegram } = require("./telegram");
const store = require("./store");
const referrals = require("./referrals");

const DAY_MS = 24 * 60 * 60 * 1000;
const GIFT_DAYS = 7;
// The club opens on 2 November: a week claimed earlier starts that day.
const CLUB_OPENS = Date.parse("2026-11-02T00:00:00+03:00");
const PARAM = /^yr_([a-z0-9]{10,40})_([0-9a-f]{16})$/;
const K = {
  byMember: "levels:gift:member", // hash: platform id → Telegram id who took her gift
  pending: "levels:gift:pending"  // set: JSON { userId, until } not yet delivered to «Уровни»
};

function signature(platformId, secret) {
  return crypto.createHmac("sha256", secret).update(`levels-gift:${platformId}`).digest("hex").slice(0, 16);
}

// The platform member id from the start parameter, if the signature is right.
function verify(param, secret = process.env.LEVELS_SYNC_SECRET) {
  const match = PARAM.exec(String(param || ""));
  if (!match || !secret) return null;
  const given = Buffer.from(match[2]);
  const expected = Buffer.from(signature(match[1], secret));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? match[1] : null;
}

async function tellLevels(item) {
  const secret = process.env.LEVELS_SYNC_SECRET;
  if (!secret) return "off";
  try {
    const base = String(process.env.LEVELS_URL || "https://yrovni.ru").replace(/\/+$/, "");
    const response = await fetch(`${base}/api/club-gift`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(item)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return "sent";
  } catch (error) {
    console.error("Levels gift sync failed", error.message);
    await store.command("SADD", K.pending, JSON.stringify(item)).catch(() => {});
    return "pending";
  }
}

// Evening cron: what did not reach «Уровни» goes again.
async function retrySync() {
  const items = (await store.command("SMEMBERS", K.pending)) || [];
  let sent = 0;
  for (const raw of items) {
    await store.command("SREM", K.pending, raw);
    let item;
    try { item = JSON.parse(raw); } catch { continue; }
    if ((await tellLevels(item)) === "sent") sent += 1;
  }
  return { pending: items.length, sent };
}

const say = (chatId, text, extra) => referrals.notify(chatId, text, extra);

// /start yr_… in the private chat. Returns true when the message was hers to handle.
async function handleStart(message, now = Date.now()) {
  if (!message || !message.chat || message.chat.type !== "private" || !message.from || typeof message.text !== "string") return false;
  const param = (message.text.match(/^\/start(?:@\w+)?\s+(\S+)/) || [])[1];
  if (!param || !param.startsWith("yr_")) return false;
  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const platformId = verify(param);
  if (!platformId) {
    await say(chatId, "Эта ссылка не сработала 🌙 Открой подарок ещё раз кнопкой в личном кабинете на yrovni.ru 🤍");
    return true;
  }
  try { await require("./crm").safeTouch(message.from, { type: "start", onlyIfNew: true, source: "levels", text: "Пришла с платформы «Уровни» за неделей клуба в подарок" }); } catch { /* not needed for the gift */ }

  const clubId = String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim();
  if (!clubId) {
    await say(chatId, "Клуб скоро откроется 🌸 Мы напишем тебе, как только вход будет готов 🤍");
    return true;
  }
  await store.command("HSETNX", K.byMember, platformId, userId);
  const owner = await store.command("HGET", K.byMember, platformId);
  const existing = await store.command("HGET", referrals.LEVELS_TRIALS, userId);
  if (existing) {
    const trial = JSON.parse(existing);
    if (!trial.ended && trial.link && new Date(trial.until).getTime() > now) {
      await say(chatId, `Твоя неделя клуба в подарок уже ждёт тебя 🤍 Она идёт до ${referrals.formatDate(trial.until)} ✨`,
        { reply_markup: { inline_keyboard: [[{ text: "Войти в клуб 🌸", url: trial.link }]] } });
    } else {
      await say(chatId, "Неделя клуба в подарок уже была у тебя 🤍 Остаться в клубе можно по подписке ✨",
        { reply_markup: { inline_keyboard: [[{ text: "Вступить в клуб 🌸", url: referrals.CLUB_PAYMENT_URL }]] } });
    }
    return true;
  }
  if (owner !== userId) {
    await say(chatId, "Этот подарок уже забрали с другого аккаунта Telegram 🌙 Если это ошибка, напиши нам — разберёмся 🤍");
    return true;
  }

  const start = Math.max(now, CLUB_OPENS);
  const until = new Date(start + GIFT_DAYS * DAY_MS).toISOString();
  const base = { granted_at: new Date(now).toISOString(), until, days: GIFT_DAYS, platform_id: platformId };
  const name = await referrals.nameOf(userId);
  if (await referrals.isSubscribed(userId)) {
    // She already pays: Tribute takes no changes from the bot, so the team extends her subscription by hand.
    await store.command("HSET", referrals.LEVELS_TRIALS, userId, JSON.stringify({ ...base, link: null, ended: true, subscribed: true, extend_days: GIFT_DAYS }));
    await say(chatId, "Ты уже в клубе «Наполнение» 🤍 Дарим тебе ещё неделю: мы продлим твою подписку на 7 дней ✨");
    await referrals.alertTeam(`🎁 ${name} забрала неделю клуба в подарок с платформы «Уровни». Она уже в клубе: продлите ей подписку в Tribute на 7 дней.`);
    await tellLevels({ userId: platformId, until });
    return true;
  }
  let invite = null;
  try {
    invite = await telegram("createChatInviteLink", { chat_id: clubId, name: `levels:${userId}`, member_limit: 1, expire_date: Math.floor(new Date(until).getTime() / 1000) });
  } catch (error) { console.error("Levels gift link failed", error.message); }
  await store.command("HSET", referrals.LEVELS_TRIALS, userId, JSON.stringify({ ...base, link: invite ? invite.invite_link : null }));
  const when = start > now ? `с ${referrals.formatDate(new Date(start).toISOString())}, когда клуб откроется, ` : "";
  await say(chatId, invite
    ? `Неделя клуба «Наполнение» в подарок от платформы «Уровни» 🎁🤍\nОна твоя ${when}до ${referrals.formatDate(until)} ✨ Каждую среду в клубе День коллабораций — расскажи о себе и найди партнёрш и клиентов 🤝 Вход по кнопке ниже, ссылка одноразовая 🫶`
    : "Неделя клуба «Наполнение» в подарок от платформы «Уровни» 🎁🤍 Скоро пришлём ссылку для входа ✨",
  invite ? { reply_markup: { inline_keyboard: [[{ text: "Войти в клуб 🌸", url: invite.invite_link }]] } } : undefined);
  await referrals.alertTeam(`🎁 ${name} забрала неделю клуба в подарок с платформы «Уровни»${invite ? "" : ". Ссылку в клуб создать не получилось: проверьте, что бот — админ клуба с правом приглашать."}`);
  await tellLevels({ userId: platformId, until });
  return true;
}

module.exports = { handleStart, retrySync, verify, signature, GIFT_DAYS };
