// Personal messages from the bot to each woman, at 11:00 Moscow, at most one a day. Only what is about
// her (the daily rituals are posted in the channel, not here):
//  1. congratulations on her new stage on the path, if she moved up since yesterday;
//  2. on Sunday — "запиши победу недели" in «Мой путь».
// The 9:00 morning cron schedules the run through QStash; the 18:00 evening cron sends them if that call never came.
// Goes to women with a CRM card who did not send /stop; nothing before the launch on 27 October.
const { telegram } = require("./telegram");
const store = require("./store");
const journey = require("./journey");

const BATCH = 25;
const SEND_HOUR_MSK = 11;
const LAUNCH_DATE = "2026-10-27";
const STOP = "\n\nНе хочешь получать такие сообщения — отправь /stop";
const K = {
  stage: "nudge:stage",          // hash: user id → last known stage index
  run: (d) => `nudge:run:${d}`
};

const appUrl = () => (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const appButton = (text, page) => ({ text, web_app: { url: `${appUrl()}/${page}` } });

const WINS = { text: "Воскресенье — день побед 🏆🤍\n{имя}, что получилось у тебя на этой неделе? Новая привычка, найденный ресурс, тёплое знакомство — запиши свою победу в «Мой путь» ✨", button: () => appButton("Записать победу 🏆", "about.html") };

const STAGE_TEXT = {
  1: { text: "Поздравляем, {имя}! 🎉🤍\nТы сделала первый шаг и перешла на этап «Целостность» ✨ Здесь бесплатные практики, чтобы собрать себя воедино 🌿🫶", page: "path.html" },
  2: { text: "Добро пожаловать в «Наполнение», {имя}! 🌸🎉\nТеперь с тобой ежедневные ритуалы, новая пара каждые две недели и День коллабораций 🫶✨ Мы так рады тебе 🤍", page: "about.html" },
  3: { text: "{имя}, ты на этапе «Раскрытие многомерного объёма»! 💫🎉\nВпереди 6 живых встреч, на которых ты раскроешь свой объём 🤍✨", page: "meetings.html" },
  4: { text: "{имя}, ты на этапе «Проявление»! 👑✨\nТвой объём идёт в мир — мы счастливы идти этот путь вместе 🤍🙏", page: "path.html" }
};

const mskDay = (now) => new Date(now + 3 * 60 * 60 * 1000);
// Morning cron: run the daily messages at 11:00 Moscow.
async function schedule(now = Date.now()) {
  const at = mskDay(now);
  at.setUTCHours(SEND_HOUR_MSK, 0, 0, 0);
  const seconds = Math.max(60, Math.ceil((at.getTime() - 3 * 60 * 60 * 1000 - now) / 1000));
  await require("./qstash").scheduleCall("/api/telegram/reminder", { kind: "nudges" }, `${seconds}s`);
  return { scheduled_in_s: seconds };
}
const fill = (text, card) => require("./crm").fill(text, card);

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

// Her message for today, or null when there is nothing personal to say.
async function messageFor(card, { weekday, subscribers }) {
  const uid = String(card.tg_id);
  const stage = await stageOf(uid, subscribers);
  const known = await store.command("HGET", K.stage, uid);
  await store.command("HSET", K.stage, uid, String(stage));
  // The first run only remembers where everyone is, so nobody is congratulated on an old stage.
  if (known !== null && known !== undefined && stage > Number(known) && STAGE_TEXT[stage]) {
    const s = STAGE_TEXT[stage];
    return { kind: "stage", text: fill(s.text, card), button: appButton("Мой путь 💫", s.page) };
  }
  if (weekday === 0) return { kind: "wins", text: fill(WINS.text, card), button: WINS.button() };
  return null;
}

async function runDaily(now = Date.now()) {
  if (mskDay(now).getUTCHours() < SEND_HOUR_MSK) return { early: true };
  const date = mskDay(now).toISOString().slice(0, 10);
  if (date < LAUNCH_DATE) return { before_launch: true };
  if (!(await store.claimOnce(K.run(date), 2 * 24 * 60 * 60))) return { skipped: true };
  const weekday = mskDay(now).getUTCDay();
  const [cards, subscribers] = await Promise.all([
    require("./crm").listCards(),
    require("./tribute").listSubscribers().catch(() => [])
  ]);
  const audience = cards.filter((c) => c.tg_id && !c.opt_out);
  const result = { recipients: audience.length, sent: 0, failed: 0, stage: 0 };
  for (let i = 0; i < audience.length; i += BATCH) {
    await Promise.all(audience.slice(i, i + BATCH).map(async (card) => {
      try {
        const m = await messageFor(card, { weekday, subscribers });
        if (!m) return;
        await telegram("sendMessage", { chat_id: card.tg_id, text: m.text + STOP, reply_markup: { inline_keyboard: [[m.button]] } });
        result.sent += 1;
        if (m.kind === "stage") result.stage += 1;
      } catch { result.failed += 1; }
    }));
    if (i + BATCH < audience.length) await new Promise((r) => setTimeout(r, 1000));
  }
  return result;
}

module.exports = { runDaily, schedule, STAGE_TEXT };
