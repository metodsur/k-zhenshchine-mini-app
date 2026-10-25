// Daily caring messages from the bot at 11:00 Moscow, at most one a day per woman. The 9:00 morning cron
// schedules the run through QStash; the 18:00 evening cron sends them if that call never came.
//  1. her new stage on the path, if she moved up since yesterday;
//  2. otherwise the ritual of the day by the free-channel week (Sunday — "запиши победу недели").
// Until the channel reaches 100 women, Monday and Sunday messages (and any day a new ten is reached)
// carry the counter «нас уже N из 100».
// Goes to women with a CRM card who did not send /stop; a woman who never started the bot simply gets nothing.
const { telegram } = require("./telegram");
const store = require("./store");
const journey = require("./journey");

const GOAL = 100;
const BATCH = 25;
const SEND_HOUR_MSK = 11;
const STOP = "\n\nНе хочешь получать такие сообщения — отправь /stop";
const K = {
  stage: "nudge:stage",          // hash: user id → last known stage index
  milestone: "nudge:milestone",  // the last ten of the goal already announced
  run: (d) => `nudge:run:${d}`
};

const appUrl = () => (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const appButton = (text, page) => ({ text, web_app: { url: `${appUrl()}/${page}` } });

// 0 = Sunday … 6 = Saturday, by the free-channel week.
const DAYS = {
  1: { text: "Доброе утро, {имя} ☀️🤍\nНовая неделя на твоём пути ✨ Сегодня день видимости: загляни в «Мой путь» и сделай один маленький шаг — покажи себя пространству 🌸", button: () => appButton("Мой путь 💫", "about.html") },
  2: { text: "{имя}, сегодня День эфиров 🎙✨\n5 эфиров по 30 минут с экспертами пространства. Приходи слушать, вдохновляться и знакомиться 🤍🫶", button: () => (process.env.TELEGRAM_CHANNEL_URL ? { text: "Открыть канал 🌸", url: process.env.TELEGRAM_CHANNEL_URL } : appButton("Открыть пространство 🌸", "space.html")) },
  3: { text: "Доброе утро, {имя} 🌿💛\nСегодня день ресурсов. Посмотри одно видео «Изобильная реальность» и спроси себя: какой ресурс мне нужен сейчас? Заяви об этом — пространство слышит 🙏✨", button: () => appButton("Смотреть видео 🎬", "abundance.html") },
  4: { text: "{имя}, сегодня день целостности 🤍🌙\nНайди 15 минут только для себя и сделай практику из блока «Твоя целостность». Ты достойна этого времени 🫶✨", button: () => appButton("Мои практики 🌿", "integrity.html") },
  5: { text: "Сегодня День дружбы 🫶🌸\n{имя}, это время видеть друг друга и принимать тепло без чувства долга 🤍 Если ещё не смотрела «Я принимаю», начни с него ✨", button: (links) => (links.friendship_url ? { text: "Присоединиться 🤍", url: links.friendship_url } : appButton("Я принимаю 🤍", "accept.html")) },
  6: { text: "{имя}, сегодня день многомерности ✨💫\nТы не одна роль — ты целая вселенная граней 🌌 Подари себе практику многомерности и немного тишины 🕯🌿", button: () => appButton("Практика многомерности ✨", "practice.html") },
  0: { text: "Воскресенье — день побед 🏆🤍\n{имя}, что получилось у тебя на этой неделе? Новая привычка, найденный ресурс, тёплое знакомство — запиши свою победу в «Мой путь» ✨\nИ позови подругу в пространство по своей ссылке 🫶", button: () => appButton("Записать победу 🏆", "about.html") }
};

const STAGE_TEXT = {
  1: { text: "Поздравляем, {имя}! 🎉🤍\nТы сделала первый шаг и перешла на этап «Целостность» ✨ Здесь бесплатные практики, чтобы собрать себя воедино 🌿🫶", page: "path.html" },
  2: { text: "Добро пожаловать в «Наполнение», {имя}! 🌸🎉\nТеперь с тобой ежедневные ритуалы, новая пара каждые две недели и День коллабораций 🫶✨ Мы так рады тебе 🤍", page: "about.html" },
  3: { text: "{имя}, ты на этапе «Раскрытие многомерного объёма»! 💫🎉\nВпереди 6 живых встреч, на которых ты раскроешь свой объём 🤍✨", page: "meetings.html" },
  4: { text: "{имя}, ты на этапе «Проявление»! 👑✨\nТвой объём идёт в мир — мы счастливы идти этот путь вместе 🤍🙏", page: "path.html" }
};

const mskDay = (now) => new Date(now + 3 * 60 * 60 * 1000);
// Messages written for the morning, if they go out with the evening fallback.
const forTime = (text, now) => (mskDay(now).getUTCHours() >= 15 ? text.replace("Доброе утро", "Добрый вечер") : text);

// Morning cron: run the daily messages at 11:00 Moscow.
async function schedule(now = Date.now()) {
  const at = mskDay(now);
  at.setUTCHours(SEND_HOUR_MSK, 0, 0, 0);
  const seconds = Math.max(60, Math.ceil((at.getTime() - 3 * 60 * 60 * 1000 - now) / 1000));
  await require("./qstash").scheduleCall("/api/telegram/reminder", { kind: "nudges" }, `${seconds}s`);
  return { scheduled_in_s: seconds };
}
const fill = (text, card) => require("./crm").fill(text, card);

async function channelCount() {
  const id = String(process.env.TELEGRAM_CHANNEL_ID || "").trim();
  if (!id) return null;
  try { return Number(await telegram("getChatMemberCount", { chat_id: id })); } catch { return null; }
}

// The counter line for today, or null. A newly reached ten is announced to everyone once.
async function counterLine(count, weekday) {
  if (count === null || !Number.isFinite(count)) return null;
  const ten = Math.min(GOAL, Math.floor(count / 10) * 10);
  const announced = Number(await store.command("GET", K.milestone)) || 0;
  if (ten > announced) {
    await store.command("SET", K.milestone, String(ten));
    if (announced > 0 || weekday === 1 || weekday === 0) {
      return ten >= GOAL ? `🎉 Нас уже ${count}! Мы вместе дошли до первой сотни — спасибо, что приводишь подруг домой 🤍🫶`
        : `🎉 Нас уже ${count} из ${GOAL}! Позови подругу по своей ссылке в «Обо мне» 🫶✨`;
    }
  }
  if (count < GOAL && (weekday === 1 || weekday === 0)) return `🌸 Нас уже ${count} из ${GOAL}. Позови подругу по своей ссылке в «Обо мне» 🫶`;
  return null;
}

// Cheap stage for the daily run: no Telegram calls per woman.
async function stageOf(userId, subscribers) {
  const [start, orders, person] = await Promise.all([
    store.onboardingState(userId).catch(() => ({})),
    require("./orders").userOrders(userId).catch(() => []),
    require("./masters").getPerson(userId).catch(() => null)
  ]);
  const sub = subscribers.find((s) => String(s.telegramUserId) === String(userId));
  const inClub = Boolean(sub && (sub.status === "active" || sub.status === "pre_cancelled") && (!sub.expireAt || Date.parse(sub.expireAt) > Date.now()));
  return journey.currentStage(journey.reachedStages({ ritualDone: Boolean(start.ritual_done), inClub, hasTickets: orders.length > 0, isMaster: Boolean(person) }));
}

async function messageFor(card, { weekday, counter, links, subscribers, now }) {
  const uid = String(card.tg_id);
  const stage = await stageOf(uid, subscribers);
  const known = await store.command("HGET", K.stage, uid);
  await store.command("HSET", K.stage, uid, String(stage));
  // The first run only remembers where everyone is, so nobody is congratulated on an old stage.
  if (known !== null && known !== undefined && stage > Number(known) && STAGE_TEXT[stage]) {
    const s = STAGE_TEXT[stage];
    return { kind: "stage", text: fill(s.text, card), button: appButton("Мой путь 💫", s.page) };
  }
  const day = DAYS[weekday];
  return { kind: weekday === 0 ? "wins" : "ritual", text: forTime(fill(day.text, card), now) + (counter ? `\n\n${counter}` : ""), button: day.button(links) };
}

async function runDaily(now = Date.now()) {
  if (mskDay(now).getUTCHours() < SEND_HOUR_MSK) return { early: true };
  const date = mskDay(now).toISOString().slice(0, 10);
  if (!(await store.claimOnce(K.run(date), 2 * 24 * 60 * 60))) return { skipped: true };
  const weekday = mskDay(now).getUTCDay();
  const crm = require("./crm");
  const [cards, count, links, subscribers] = await Promise.all([
    crm.listCards(),
    channelCount(),
    require("./settings").loadSettings().catch(() => ({})),
    require("./tribute").listSubscribers().catch(() => [])
  ]);
  const counter = await counterLine(count, weekday);
  const audience = cards.filter((c) => c.tg_id && !c.opt_out);
  const result = { recipients: audience.length, sent: 0, failed: 0, stage: 0 };
  for (let i = 0; i < audience.length; i += BATCH) {
    await Promise.all(audience.slice(i, i + BATCH).map(async (card) => {
      try {
        const m = await messageFor(card, { weekday, counter, links: links || {}, subscribers, now });
        await telegram("sendMessage", { chat_id: card.tg_id, text: m.text + STOP, reply_markup: { inline_keyboard: [[m.button]] } });
        result.sent += 1;
        if (m.kind === "stage") result.stage += 1;
      } catch { result.failed += 1; }
    }));
    if (i + BATCH < audience.length) await new Promise((r) => setTimeout(r, 1000));
  }
  return result;
}

module.exports = { runDaily, schedule, counterLine, DAYS, STAGE_TEXT };
