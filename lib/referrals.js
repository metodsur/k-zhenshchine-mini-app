// «Пригласи подруг»: each woman gets her own invite link to the free channel (created by the bot,
// named "ref:<her id>"). When someone joins the channel through it, the bot counts her.
//  - 10 invited → two weeks of the online club as a gift (a one-person invite link to the club group);
//    when the two weeks end without a Tribute subscription, the bot removes her from the group.
//  - 20 invited → she can become an expert on the broadcast day; the bot congratulates her and tells the team.
// A woman is counted once, for the first link she came through; re-joining does not count again.
const { telegram } = require("./telegram");
const store = require("./store");
const tribute = require("./tribute");

const DAY_MS = 24 * 60 * 60 * 1000;
const CLUB_GOAL = 10;
const EXPERT_GOAL = 20;
const TRIAL_DAYS = 14;
const CLUB_PAYMENT_URL = "https://t.me/tribute/app?startapp=s17IJ";
const LINK_NAME = /^ref:(\d+)$/;
const K = {
  links: "ref:links",            // hash: user id → her channel invite link
  by: "ref:by",                  // hash: invited user id → who invited her (first link wins)
  invited: (id) => `ref:invited:${id}`, // set of user ids she invited
  trials: "ref:trials",          // hash: user id → JSON { granted_at, until, link, reminded, ended }
  expert: "ref:expert"           // set: women who reached the expert goal (notified once)
};

const appUrl = () => (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const appKeyboard = (page, text) => ({ inline_keyboard: [[{ text, web_app: { url: `${appUrl()}/${page}` } }]] });

function formatDate(iso) {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" }).format(new Date(iso));
}

async function notify(chatId, text, extra = {}) {
  try { await telegram("sendMessage", { chat_id: chatId, text, ...extra }); return true; } catch { return false; }
}

async function readTrial(userId) {
  const raw = await store.command("HGET", K.trials, userId);
  return raw ? JSON.parse(raw) : null;
}

const saveTrial = (userId, trial) => store.command("HSET", K.trials, userId, JSON.stringify(trial));

// Her personal link: created once, then reused.
async function linkFor(userId) {
  const saved = await store.command("HGET", K.links, userId);
  if (saved) return saved;
  const channelId = String(process.env.TELEGRAM_CHANNEL_ID || "").trim();
  if (!channelId) throw new Error("Missing TELEGRAM_CHANNEL_ID");
  const created = await telegram("createChatInviteLink", { chat_id: channelId, name: `ref:${userId}` });
  // Two parallel first visits may both create a link; the first saved one is kept.
  await store.command("HSETNX", K.links, userId, created.invite_link);
  return (await store.command("HGET", K.links, userId)) || created.invite_link;
}

async function status(userId) {
  const [link, count, trial] = await Promise.all([linkFor(userId), store.command("SCARD", K.invited(userId)), readTrial(userId)]);
  return {
    link,
    count: Number(count) || 0,
    club_goal: CLUB_GOAL,
    expert_goal: EXPERT_GOAL,
    trial: trial ? { until: trial.until, ended: Boolean(trial.ended) } : null
  };
}

async function grantTrial(userId, now) {
  if (await readTrial(userId)) return false;
  const clubId = String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim();
  if (!clubId) return false;
  if (await isSubscribed(userId)) {
    await saveTrial(userId, { granted_at: new Date(now).toISOString(), until: new Date(now).toISOString(), link: null, ended: true, subscribed: true });
    await notify(userId, `По твоей ссылке в пространство пришли уже ${CLUB_GOAL} женщин 🤍🎉 Спасибо, что приводишь подруг домой — ты делаешь пространство теплее 🫶✨`);
    return false;
  }
  const until = new Date(now + TRIAL_DAYS * DAY_MS).toISOString();
  let invite = null;
  try {
    invite = await telegram("createChatInviteLink", { chat_id: clubId, name: `gift:${userId}`, member_limit: 1, expire_date: Math.floor((now + 7 * DAY_MS) / 1000) });
  } catch (error) { console.error("Club gift link failed", error.message); }
  await saveTrial(userId, { granted_at: new Date(now).toISOString(), until, link: invite ? invite.invite_link : null });
  await notify(userId, invite
    ? `По твоей ссылке в пространство пришли уже ${CLUB_GOAL} женщин 🤍🎉\nДарим тебе две недели онлайн-клуба «к Женщине» 🎁 до ${formatDate(until)} ✨ Вход по кнопке ниже, ссылка одноразовая 🫶`
    : `По твоей ссылке в пространство пришли уже ${CLUB_GOAL} женщин 🤍🎉\nДарим тебе две недели онлайн-клуба «к Женщине» 🎁 Скоро пришлём ссылку для входа ✨`,
  invite ? { reply_markup: { inline_keyboard: [[{ text: "Войти в клуб 🌸", url: invite.invite_link }]] } } : {});
  await alertTeam(`🎁 ${await nameOf(userId)} пригласила ${CLUB_GOAL} женщин и получила 2 недели клуба${invite ? "" : ". Ссылку в клуб создать не получилось: проверьте, что бот — админ клуба с правом приглашать."}`);
  return true;
}

async function nameOf(userId) {
  try {
    const crm = require("./crm");
    const card = await crm.getCard(crm.telegramId(userId));
    if (card && card.name) return card.name;
  } catch { /* the id is enough */ }
  return `Участница ${userId}`;
}

async function alertTeam(text) {
  let recipients = [];
  try { recipients = await require("./team").alertRecipients(); } catch { recipients = []; }
  for (const id of recipients) await notify(id, text);
}

// Called for every new member of the free channel (chat_member update).
async function onChannelJoin(change, now = Date.now()) {
  const match = change && change.invite_link && LINK_NAME.exec(change.invite_link.name || "");
  if (!match) return null;
  const inviterId = match[1];
  const joinedId = String(change.new_chat_member.user.id);
  if (inviterId === joinedId) return null;
  if (Number(await store.command("HSETNX", K.by, joinedId, inviterId)) !== 1) return null;
  await store.command("SADD", K.invited(inviterId), joinedId);
  const count = Number(await store.command("SCARD", K.invited(inviterId))) || 0;

  if (count === CLUB_GOAL) await grantTrial(inviterId, now);
  else if (count >= EXPERT_GOAL && Number(await store.command("SADD", K.expert, inviterId)) === 1) {
    await notify(inviterId, `По твоей ссылке пришли уже ${count} женщин 🎉🤍 Ты можешь стать экспертом в День эфиров «к Женщине» 🎙✨\nМы напишем тебе, чтобы выбрать слот 🫶 Для эфира понадобится упаковка на платформе Уровни и анкета с ценностями пространства 🌿`,
      { reply_markup: appKeyboard("expert.html", "Анкета эксперта 📝") });
    await alertTeam(`🎙 ${await nameOf(inviterId)} пригласила ${count} женщин и может стать экспертом в День эфиров. Напишите ей, чтобы выбрать слот.`);
  } else if (count < CLUB_GOAL) {
    await notify(inviterId, `По твоей ссылке в пространство пришла ещё одна женщина 🤍✨ Уже ${count} из ${CLUB_GOAL} 🌸 Когда наберётся ${CLUB_GOAL}, подарим тебе две недели клуба 🎁🫶`,
      { reply_markup: appKeyboard("about.html", "Моя ссылка 💫") });
  }
  return { inviter: inviterId, count };
}

async function isSubscribed(userId) {
  try {
    const sub = await tribute.getSubscriber(userId);
    return Boolean(sub && (sub.status === "active" || sub.status === "pre_cancelled") && (!sub.expireAt || new Date(sub.expireAt).getTime() > Date.now()));
  } catch { return null; }
}

// Daily: a reminder two days before the gift ends, then removal from the club group unless she subscribed.
async function runTrials(now = Date.now()) {
  const raw = (await store.command("HGETALL", K.trials)) || [];
  const result = { reminded: 0, ended: 0, removed: 0 };
  const clubId = String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim();
  for (let i = 0; i < raw.length; i += 2) {
    const userId = raw[i];
    const trial = JSON.parse(raw[i + 1]);
    if (trial.ended) continue;
    const until = new Date(trial.until).getTime();
    if (now >= until) {
      const subscribed = await isSubscribed(userId);
      if (subscribed === null) continue; // Tribute unavailable: decide on the next run.
      if (!subscribed && clubId) {
        try {
          await telegram("banChatMember", { chat_id: clubId, user_id: Number(userId), until_date: Math.floor(now / 1000) + 60 });
          await telegram("unbanChatMember", { chat_id: clubId, user_id: Number(userId), only_if_banned: true });
          result.removed += 1;
        } catch (error) { console.error("Club gift removal failed", error.message); }
        await notify(userId, "Две недели клуба «к Женщине» в подарок закончились 🌙 Спасибо, что была с нами 🤍🙏\nЕсли захочешь вернуться, клуб ждёт тебя с теплом 🫶✨",
          { reply_markup: { inline_keyboard: [[{ text: "Вступить в клуб 🌸", url: CLUB_PAYMENT_URL }]] } });
      }
      await saveTrial(userId, { ...trial, ended: true, subscribed });
      result.ended += 1;
    } else if (!trial.reminded && until - now <= 2 * DAY_MS) {
      if (!(await isSubscribed(userId))) {
        await notify(userId, `Твои две недели клуба «к Женщине» в подарок закончатся ${formatDate(trial.until)} 🌙 Нам так хорошо с тобой 🤍 Чтобы остаться, оформи подписку ✨🫶`,
          { reply_markup: { inline_keyboard: [[{ text: "Остаться в клубе 🤍", url: CLUB_PAYMENT_URL }]] } });
        result.reminded += 1;
      }
      await saveTrial(userId, { ...trial, reminded: true });
    }
  }
  return result;
}

module.exports = { linkFor, status, onChannelJoin, runTrials, CLUB_GOAL, EXPERT_GOAL };
