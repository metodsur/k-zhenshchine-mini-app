// Collaborations of the paid club (День коллабораций). A member writes a post with #коллаборация in the club
// group and tags her partner(s) with @. The bot answers with a button; a collaboration counts only when a tagged
// partner confirms it, so nobody can count one alone. Each confirmation:
//  - +1 to «Мои коллаборации» of the author and of the partner (set collabs:user:<id>, shown in «Мой путь»);
//  - the first confirmation of a post adds 1 to the club counters (stats:club:collabs:*, «Пространство»);
//  - is sent to «Уровни» (energy-platform, POST /api/club-collabs), where it goes into the «Сделки» ring.
// No tags in the post: the bot asks to tag the partner; the author's reply to her post with the tags counts.
const store = require("./store");
const { telegram } = require("./telegram");

const KEEP_SECONDS = 60 * 24 * 60 * 60;
const STATS_KEEP_SECONDS = 45 * 24 * 60 * 60;
const COLLAB_TAG = /#коллаб/i;
const K = {
  post: (msgId) => `collab:post:${msgId}`,
  user: (userId) => `collabs:user:${userId}`,
  dayCount: (d) => `stats:club:collabs:${d}`,
  total: "stats:club:collabs:total",
  pendingSync: "collab:sync:pending"
};
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const lower = (s) => String(s || "").replace(/^@/, "").toLowerCase();
const nameOf = (u) => (u.username ? `@${u.username}` : u.first_name || "участница");

// Partners tagged in a message: @username mentions and text mentions of people without a username.
function taggedPartners(message, authorId) {
  const text = message.text || message.caption || "";
  const entities = message.entities || message.caption_entities || [];
  const out = [];
  for (const e of entities) {
    if (e.type === "mention") out.push({ username: lower(text.slice(e.offset, e.offset + e.length)) });
    else if (e.type === "text_mention" && e.user && !e.user.is_bot) out.push({ id: e.user.id, username: lower(e.user.username), name: e.user.first_name });
  }
  const seen = new Set();
  return out.filter((p) => {
    const key = p.id ? `id:${p.id}` : `u:${p.username}`;
    if (String(p.id) === String(authorId) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

const load = async (msgId) => { try { return JSON.parse(await store.command("GET", K.post(msgId))); } catch { return null; } };
const save = (doc) => store.command("SET", K.post(doc.msg), JSON.stringify(doc), "EX", KEEP_SECONDS);

async function askToConfirm(chatId, replyTo, doc) {
  const who = doc.partners.map((p) => (p.username ? `@${p.username}` : p.name || "партнёрша")).join(", ");
  await telegram("sendMessage", {
    chat_id: chatId, reply_to_message_id: replyTo,
    text: `Какая красивая коллаборация 🤝✨ ${who}, подтверди, что вы создаёте это вместе, и коллаборация засчитается вам обеим в приложении и на «Уровнях» 📈🤍`,
    reply_markup: { inline_keyboard: [[{ text: "Подтверждаю 🤝", callback_data: `c:y:${doc.msg}` }]] }
  });
}

// A club group message. Returns true when it was about a collaboration.
async function handleGroupMessage(message) {
  const author = message.from;
  const text = `${message.text || ""} ${message.caption || ""}`;
  // The author tags partners in a reply to her own collaboration post.
  const replyTo = message.reply_to_message;
  if (replyTo && !COLLAB_TAG.test(text)) {
    const doc = await load(replyTo.message_id);
    if (!doc || String(doc.author.id) !== String(author.id) || doc.partners.length) return false;
    const partners = taggedPartners(message, author.id);
    if (!partners.length) return false;
    doc.partners = partners;
    await save(doc);
    await askToConfirm(message.chat.id, doc.msg, doc);
    return true;
  }
  if (!COLLAB_TAG.test(text)) return false;
  const doc = {
    id: `c:${message.chat.id}:${message.message_id}`, msg: message.message_id, at: new Date().toISOString(),
    author: { id: author.id, username: lower(author.username), name: author.first_name || "" },
    partners: taggedPartners(message, author.id), confirmed: []
  };
  await save(doc);
  if (doc.partners.length) await askToConfirm(message.chat.id, doc.msg, doc);
  else {
    await telegram("sendMessage", {
      chat_id: message.chat.id, reply_to_message_id: message.message_id,
      text: "Какая красивая коллаборация 🤝✨ Отметь в ответе на свой пост @партнёршу, чтобы коллаборация засчиталась вам обеим 🤍"
    });
  }
  return true;
}

// Sends a confirmed pair to «Уровни». Without LEVELS_SYNC_SECRET it is off; a failure waits for the evening retry.
async function syncToLevels(item) {
  const secret = process.env.LEVELS_SYNC_SECRET;
  if (!secret) return "off";
  if (item.handles.filter(Boolean).length < 2) return "no_usernames";
  try {
    const base = String(process.env.LEVELS_URL || "https://yrovni.ru").replace(/\/+$/, "");
    const response = await fetch(`${base}/api/club-collabs`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ id: item.id, handles: item.handles.filter(Boolean) })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return "sent";
  } catch (error) {
    console.error("Levels sync failed", error.message);
    await store.command("SADD", K.pendingSync, JSON.stringify(item)).catch(() => {});
    return "pending";
  }
}

// Evening cron: what did not reach «Уровни» goes again.
async function retrySync() {
  const items = (await store.command("SMEMBERS", K.pendingSync)) || [];
  let sent = 0;
  for (const raw of items) {
    await store.command("SREM", K.pendingSync, raw);
    let item;
    try { item = JSON.parse(raw); } catch { continue; }
    if ((await syncToLevels(item)) === "sent") sent += 1;
  }
  return { pending: items.length, sent };
}

// The «Подтверждаю» button.
async function handleCallback(cq) {
  const m = /^c:y:(\d+)$/.exec(String((cq && cq.data) || ""));
  if (!m) return false;
  const answer = (text) => telegram("answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});
  const user = cq.from || {};
  const doc = await load(m[1]);
  if (!doc) { await answer("Эта коллаборация уже в архиве 🤍"); return true; }
  const partner = doc.partners.find((p) => (p.id && String(p.id) === String(user.id)) || (p.username && p.username === lower(user.username)));
  if (!partner || String(user.id) === String(doc.author.id)) { await answer("Подтвердить может только отмеченная партнёрша 🤍"); return true; }
  if (doc.confirmed.includes(String(user.id))) { await answer("Уже засчитано 🤍"); return true; }

  const first = doc.confirmed.length === 0;
  doc.confirmed.push(String(user.id));
  if (!partner.username && user.username) partner.username = lower(user.username);
  await save(doc);
  await store.command("SADD", K.user(doc.author.id), doc.id);
  await store.command("SADD", K.user(user.id), doc.id);
  let total = null;
  if (first) {
    const d = day(Date.now());
    await store.command("INCR", K.dayCount(d));
    await store.command("EXPIRE", K.dayCount(d), STATS_KEEP_SECONDS);
    total = await store.command("INCR", K.total);
  }
  await syncToLevels({ id: doc.id, handles: [doc.author.username, lower(user.username)] });
  await answer("Коллаборация засчитана 🎉");
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : process.env.TELEGRAM_CLUB_CHAT_ID;
  await telegram("sendMessage", {
    chat_id: chatId, reply_to_message_id: doc.msg,
    text: `Коллаборация засчитана 🎉 ${nameOf({ username: doc.author.username, first_name: doc.author.name })} и ${nameOf(user)}${total ? `, это уже ${total}-я коллаборация клуба ✨` : " ✨"} Ваш рейтинг на «Уровнях» вырос 📈🤍`
  }).catch(() => {});
  return true;
}

async function countFor(userId) {
  return Number(await store.command("SCARD", K.user(userId))) || 0;
}

module.exports = { handleGroupMessage, handleCallback, retrySync, countFor, taggedPartners, COLLAB_TAG };
