// Posts of the free channel «к Женщине» (TELEGRAM_CHANNEL_ID), texts approved by the owner on 25.10.2026.
// Launch week (27.10–01.11) has its own dated posts; from 02.11 the weekly grid repeats by weekday.
// The 9:00 morning cron schedules each of today's posts through QStash for its Moscow time;
// the 18:00 evening cron publishes whatever has not gone out by then. Each post goes out once.
// Buttons in a channel cannot open the Mini App directly, so they lead to the bot (/start go_<page>),
// which answers with the button to that page.
const { telegram } = require("./telegram");
const store = require("./store");

const LAUNCH_DATE = "2026-10-27";
const WEEKLY_FROM = "2026-11-02";
const K = { sent: (date, slot) => `channel_post:${date}:${slot}` };

// /start go_<key> → page of the app.
const PAGES = {
  ritual: "rituals.html", app: "space.html", abundance: "abundance.html", integrity: "integrity.html",
  accept: "accept.html", practice: "practice.html", about: "about.html", expert: "expert.html", path: "path.html"
};

// The approved closing lines; from 02.11 they rotate so a line never repeats within a week.
const AFFIRMATIONS = [
  "🤍 Ты уже достаточна, чтобы быть здесь.",
  "🏡 Женщина женщине — дом.",
  "✨ Ты самая лучшая версия себя — прямо сейчас.",
  "💛 Ты достойна изобилия во всём.",
  "🌙 Ты целая, даже когда собираешь себя по кусочкам.",
  "🌸 Принимать — это тоже щедрость.",
  "🫶 Женщина женщине — опора.",
  "💫 В тебе гораздо больше, чем ты о себе знаешь.",
  "🏆 Каждый твой маленький шаг — уже победа.",
  "🎙 Твой голос нужен этому миру.",
  "🌿 Ты идёшь в своём ритме, и это правильный ритм.",
  "🤍 Здесь тебя видят и слышат."
];

const INVITE_GIFTS = "10 подруг — две недели клуба в подарок 🎁 20 подруг — свой эфир в День эфиров 🎙";

const POST = {
  ritual: {
    text: "📌 Начни отсюда 🤍\n\n"
      + "Мы открываемся 🎉 «к Женщине» — это экосистема для женщины, которая хочет раскрыть свою многомерность и проявиться в мире ✨ Это путь из этапов, и каждый ты проходишь в своём ритме 🌿\n\n"
      + "Путь начинается с ритуала видимости ✨ Открой приложение и покажи себя пространству: кто ты, что тебе важно, куда ты идёшь. Видимость начинается с того, что ты разрешаешь себе быть увиденной 🫶\n\n"
      + "Это маленькое действие, и с него открывается первый этап — «Целостность» 🤍 Ритуал можно пройти в любой день, этот пост всегда ждёт тебя наверху 🌸",
    buttons: [["Пройти ритуал видимости ✨", "ritual"]], pin: true
  },
  rubrics: {
    text: "Что будет в канале каждую неделю 🗓✨\n\n"
      + "Каждый день — свой ритуал. Ритуалы — это маленькие ежедневные действия на пути к большой цели 🌿\n\n"
      + "☀️ Понедельник — Путь: твой этап, ритуал видимости и фишка приложения\n"
      + "🎙 Вторник — День эфиров: 5 эфиров по 30 минут с экспертами пространства (со следующей недели)\n"
      + "💛 Среда — Ресурсы: видео «Изобильная реальность» и задание\n"
      + "🤍 Четверг — Целостность: практики, чтобы собрать себя воедино\n"
      + "🫶 Пятница — День дружбы и ритуал принятия «Я принимаю»\n"
      + "💫 Суббота — Многомерность и сакральные знания и практики\n"
      + "🏆 Воскресенье — Внедрение: что ты внедрила и какие результаты\n\n"
      + "Иди в своём ритме: можно каждый день, а можно только то, что откликается 🌸\n\n"
      + "Наша первая цель — 100 женщин в пространстве, сейчас нас [N] 🤍 Пригласишь 10 подруг по своей ссылке — подарим две недели онлайн-клуба 🎁",
    buttons: []
  },
  explore: {
    text: "Загляни в приложение «к Женщине» 📱🤍\n\n"
      + "Там всё пространство в одном месте, и многое доступно бесплатно ✨\n\n"
      + "🌸 Пространство — ритуалы и события\n"
      + "🌿 Путь — этапы, «Твоя целостность», «Я принимаю», «Изобильная реальность», «Практика многомерности»\n"
      + "💫 Встречи — 6 живых встреч раскрытия многомерности в твоём городе\n"
      + "🤍 Обо мне — «Мой путь»: твой этап, прогресс и победы, а ещё твои ресурсы, задачи и личная ссылка-приглашение для подруг\n\n"
      + "Задание на вечер 🌙 Пройдись по всем разделам и напиши в комментариях, что тебе откликнулось больше всего 🫶",
    buttons: [["Открыть приложение 📱", "app"]]
  },
  resources: {
    text: (ctx) => "Среда — день ресурсов 🌿💛\n\n"
      + `Сегодня смотрим ${ctx.video.ordinal} видео серии «Изобильная реальность»: «${ctx.video.title}» 🎬 Оно бесплатно и ждёт тебя в приложении.\n\n`
      + "Ресурс приходит тогда, когда ты знаешь, что его ждёшь, и не боишься об этом сказать ✨\n\n"
      + "Задание дня 📝\n"
      + "1. Посмотри видео.\n"
      + "2. Напиши в комментариях, какой ресурс тебе нужен сейчас: время, деньги, поддержка, человек, знание.\n"
      + "3. Заяви об этом смело, без «если можно» 🙏\n\n"
      + "Может быть, то, что тебе нужно, уже есть у другой женщины в этом пространстве 🫶 Свои ресурсы можно добавить и в «Обо мне».",
    buttons: [["Смотреть видео 🎬", "abundance"]]
  },
  integrity: {
    text: "Четверг — день целостности 🤍🌙\n\n"
      + "Мы часто живём по кусочкам: немного для работы, немного для семьи, и почти ничего для себя. Целостность — первый этап пути, здесь ты собираешь себя воедино 🌿\n\n"
      + "В приложении, в разделе «Путь», тебя ждёт блок «Твоя целостность»: два видео и 11 аудиопрактик 🎧 Это бесплатно.\n\n"
      + "Ритуал дня ✨ Найди 15 минут только для себя. Выключи уведомления, надень наушники и сделай одну практику. Ты достойна этого времени 🫶\n\n"
      + "Напиши в комментариях одно слово: как ты себя чувствуешь после практики 🌸",
    buttons: [["Мои практики 🌿", "integrity"]]
  },
  accept: {
    text: "Пятница — День дружбы 🫶🌸\n\n"
      + "Дружба между женщинами начинается с умения принимать: тепло, помощь, внимание — без чувства долга 🤍\n\n"
      + "Перед Днём дружбы посмотри ритуал «Я принимаю» в приложении: видео и две аудиопрактики 🎧 Это бесплатно ✨\n\n"
      + "Ритуал дня 🌿\n"
      + "1. Сделай практику «Я принимаю».\n"
      + "2. Напиши одной женщине, за что ты ей благодарна.\n"
      + "3. Прими любой комплимент сегодня простой фразой «спасибо» 🙏\n\n"
      + "А если хочешь больше живых знакомств — в клубе «Наполнение» раз в две недели каждая получает новую пару для ритуала 🫶",
    buttons: [["Я принимаю 🤍", "accept"]]
  },
  friendship: {
    text: "Ритуал «День дружбы» 🫶🌸✨\n\n"
      + "Сегодня делимся изобилием. Вот как это работает:\n"
      + "1. 🎁 Подумай, чем ты можешь поделиться из своего изобилия: знанием, услугой, вещью, временем, вниманием, вдохновением.\n"
      + "2. 💬 Напиши в комментариях: «Дарю…» — и что именно ты готова подарить.\n"
      + "3. 🤍 Если подарок откликнулся, ответь на комментарий: «Принимаю, благодарю». Без оправданий и без «да не стоит» — просто принимаю 🙏\n"
      + "4. 🌿 Договоритесь в личных сообщениях, как подарок дойдёт до тебя.\n\n"
      + "Чем больше мы делимся, тем больше изобилия возвращается к каждой из нас 💫\n\n"
      + "Хочешь, чтобы изобилия стало ещё больше? 🌸 Расскажи о подарке, который подарила или получила, в своих соцсетях. Пригласи свою аудиторию в Дни дружбы: пусть тоже делятся и принимают 🫶 Приглашай по своей личной ссылке из приложения, раздел «Обо мне». Так каждая, кто придёт, попадёт в экосистему «к Женщине», а ты станешь ближе к подаркам: 10 подруг — две недели клуба 🎁, 20 подруг — свой эфир в День эфиров 🎙",
    buttons: [["Моя ссылка-приглашение 💫", "about"]]
  },
  multidim: {
    text: "Суббота — день многомерности ✨💫\n\n"
      + "Что такое многомерность? Это когда ты не сводишь себя к одной роли. Ты и мама, и девочка, и творец, и любимая, и профессионал — и все эти грани живые 🌌\n\n"
      + "Как её раскрывать 🌿\n— замечать, в какой грани ты сейчас;\n— давать внимание той, которую давно забыла;\n— делать маленький шаг из каждой грани, а не только из привычной.\n\n"
      + "Сегодня Варвара делится сакральными знаниями и практиками многомерности 🕯 Следи за каналом — они выйдут здесь сегодня ✨\n\n"
      + "А ещё в приложении тебя ждёт «Практика многомерности» — практика пространства многомерности ✨ Напиши в комментариях, какую свою грань ты сегодня вспомнила 🤍",
    buttons: [["Практика многомерности ✨", "practice"]]
  },
  implement: {
    text: "Воскресенье — день внедрения 🏆🤍\n\n"
      + "Меняет жизнь не то, что мы узнали, а то, что мы внедрили ✨ За эту неделю у нас были [неделя].\n\n"
      + "Расскажи в комментариях 💬\n— что ты внедрила в свою жизнь?\n— какой результат заметила, даже самый маленький?\nИ запиши победу в «Обо мне» → «Мой путь»: там виден весь твой прогресс 🌱\n\n"
      + "Хочешь проявиться? 💫 В экосистеме «к Женщине» есть платформа проявленности «Уровни» — yrovni.ru. Там можно уже сейчас сделать свою упаковку и мини-лендинг. А презентовать себя можно в клубе, в День коллабораций 🤝\n\n"
      + `Приведи подругу 🫶 Нас уже [N] из 100. Твоя личная ссылка-приглашение лежит в приложении, в разделе «Обо мне». ${INVITE_GIFTS}`,
    buttons: [["Мой путь и ссылка 💫", "about"]]
  },
  become_expert: {
    text: "Хочешь выйти в эфир перед женщинами пространства? 🎙✨\n\n"
      + "[Когда] вторник — День эфиров: 5 эфиров по 30 минут. Один из них может быть твоим 🤍\n\n"
      + "Как стать экспертом 🌿\n"
      + "1. 🫶 Пригласи в пространство 20 женщин по своей личной ссылке из «Обо мне». Счётчик там же, бот напишет тебе, когда цель будет достигнута.\n"
      + "2. 💫 Сделай свою упаковку на платформе проявленности «Уровни» — yrovni.ru.\n"
      + "3. 📝 Заполни анкету эксперта: тема эфира и ценности пространства.\n"
      + "4. 🗓 Мы свяжемся с тобой и выберем слот.\n\n"
      + "Эфир — это подарок женщинам пространства и твоё проявление в мире 🌸 Так тебя увидят те, кому нужно то, чем ты делишься.",
    buttons: [["Моя ссылка 💫", "about"], ["Анкета эксперта 📝", "expert"]]
  },
  monday: {
    text: (ctx) => "Новая неделя на твоём пути ☀️🤍\n\n"
      + "Напоминаем: «к Женщине» — это путь из этапов, и ты идёшь в своём ритме 🌿 Вход — ритуал видимости. Если ещё не прошла, начни с него ✨\n\n"
      + `Фишка недели 📱 ${ctx.feature}\n\n`
      + "Нас уже [N] из 100 🌸 Пригласи подругу по своей ссылке в «Обо мне» 🫶",
    buttons: [["Мой путь 💫", "about"]]
  },
  broadcasts: {
    text: (ctx) => "Сегодня День эфиров 🎙✨\n\n"
      + "5 эфиров по 30 минут. Приходи слушать, вдохновляться и знакомиться 🤍\n\n"
      + `Расписание 🕐\n${ctx.experts.map((e) => `${e.time} — ${e.name}, «${e.topic}»`).join("\n")}\n`
      + "Эфиры идут один за другим, с 16:00 до 18:30 по Москве\n\n"
      + "Как стать экспертом эфира 💫 Приведи в пространство 20 женщин по своей ссылке. Сделай свою упаковку на платформе проявленности «Уровни» (yrovni.ru) и заполни анкету с ценностями пространства 🌿",
    buttons: []
  }
};

const VIDEOS = [
  { ordinal: "первое", title: "Как притягивать нужные ресурсы в любом объёме" },
  { ordinal: "второе", title: "Нюансы создания желаемой реальности" },
  { ordinal: "третье", title: "Как получать подарки от пространства" },
  { ordinal: "четвёртое", title: "Как получать подарки от мужчин" }
];
const FEATURES = [
  "«Мой путь» — твой этап, прогресс и победы в «Обо мне» 🏆",
  "«Пригласи подруг» — личная ссылка и подарки за 10 и 20 подруг 🎁",
  "«Мои ресурсы» — чем ты можешь поделиться и что тебе нужно 🌿",
  "«Мои задачи» — личные цели и шаги к ним ✅",
  "«Встречи» — 6 живых встреч раскрытия многомерности в твоём городе 💫"
];
const LAUNCH_WEEK = "ритуал видимости, ресурсы, целостность, День дружбы и многомерность";
const USUAL_WEEK = "путь, День эфиров, ресурсы, целостность, День дружбы и многомерность";

// The plan of a day: [{ slot, post, affirmation? }]. Launch week keeps the affirmations as approved.
const LAUNCH = {
  "2026-10-27": [{ slot: "10:00", post: "ritual", aff: 0 }, { slot: "13:00", post: "rubrics", aff: 1 }, { slot: "17:00", post: "explore", aff: 2 }],
  "2026-10-28": [{ slot: "10:00", post: "resources", aff: 3 }],
  "2026-10-29": [{ slot: "10:00", post: "integrity", aff: 4 }],
  "2026-10-30": [{ slot: "10:00", post: "accept", aff: 5 }, { slot: "13:00", post: "friendship", aff: 6 }],
  "2026-10-31": [{ slot: "10:00", post: "multidim", aff: 7 }],
  "2026-11-01": [{ slot: "10:00", post: "implement", aff: 8 }, { slot: "13:00", post: "become_expert", aff: 9 }]
};
// Weekday (0 = Sunday) → posts of a usual week.
const WEEK = {
  1: [{ slot: "10:00", post: "monday" }],
  2: [{ slot: "10:00", post: "broadcasts" }],
  3: [{ slot: "10:00", post: "resources" }],
  4: [{ slot: "10:00", post: "integrity" }],
  5: [{ slot: "10:00", post: "accept" }, { slot: "13:00", post: "friendship" }],
  6: [{ slot: "10:00", post: "multidim" }],
  0: [{ slot: "10:00", post: "implement" }, { slot: "13:00", post: "become_expert" }]
};
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const DAY = 24 * 60 * 60 * 1000;
const mskNow = (now) => new Date(now + 3 * 60 * 60 * 1000);
const mskDate = (now) => mskNow(now).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const weeksSince = (from, date) => Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / (7 * DAY));

function plan(date) {
  if (date < LAUNCH_DATE) return [];
  if (LAUNCH[date]) return LAUNCH[date].map((p) => ({ ...p, launch: true }));
  if (date < WEEKLY_FROM) return [];
  const week = weeksSince(WEEKLY_FROM, date);
  const weekday = weekdayOf(date);
  // Index of the post within its week → an affirmation that does not repeat within the week.
  let index = 0;
  for (const d of WEEK_ORDER) { if (d === weekday) break; index += WEEK[d].length; }
  return WEEK[weekday].map((p, i) => ({ ...p, aff: (week * 9 + index + i + 3) % AFFIRMATIONS.length }));
}

const botName = () => String(process.env.TELEGRAM_BOT_USERNAME || "K_zhenshcine_bot").replace(/^@/, "");
const buttonUrl = (key) => `https://t.me/${botName()}?start=go_${key}`;

async function memberCount() {
  try { return Number(await telegram("getChatMemberCount", { chat_id: process.env.TELEGRAM_CHANNEL_ID })) || null; } catch { return null; }
}

// Experts with an assigned slot on that Tuesday (dashboard «Эксперты»).
async function expertsOn(date) {
  const items = await require("./os-collections").load("experts");
  return items.filter((e) => e.stage === "slot" && e.air_date === date && e.air_time)
    .sort((a, b) => a.air_time.localeCompare(b.air_time))
    .map((e) => ({ time: e.air_time, name: e.name || "эксперт", topic: e.title }));
}

// The finished post for a date and slot, or null (no post, or a Tuesday without experts).
async function build(date, slot) {
  const item = plan(date).find((p) => p.slot === slot);
  if (!item) return null;
  const def = POST[item.post];
  const ctx = {};
  if (item.post === "resources") ctx.video = VIDEOS[Math.max(0, weeksSince("2026-10-28", date)) % VIDEOS.length];
  if (item.post === "monday") ctx.feature = FEATURES[weeksSince(WEEKLY_FROM, date) % FEATURES.length];
  if (item.post === "broadcasts") {
    ctx.experts = await expertsOn(date);
    if (!ctx.experts.length) return { skipped: "no_experts", post: item.post };
  }
  let text = typeof def.text === "function" ? def.text(ctx) : def.text;
  if (text.includes("[N]")) {
    const n = await memberCount();
    text = text.replace(/\[N\]/g, n ? String(n) : "уже больше");
  }
  text = text.replace("[неделя]", item.launch ? LAUNCH_WEEK : USUAL_WEEK)
    .replace("[Когда]", item.launch ? "Со следующей недели каждый" : "Каждый");
  text += `\n\n${AFFIRMATIONS[item.aff]}`;
  const reply_markup = def.buttons.length ? { inline_keyboard: def.buttons.map(([t, key]) => [{ text: t, url: buttonUrl(key) }]) } : undefined;
  return { post: item.post, text, reply_markup, pin: Boolean(def.pin) };
}

// Publishes one post (once). Only today's posts, and never before their time.
async function publish(date, slot, now = Date.now()) {
  if (date !== mskDate(now)) return { skipped: "not_today" };
  if (mskNow(now).toISOString().slice(11, 16) < slot) return { skipped: "early" };
  const post = await build(date, slot);
  if (!post) return { skipped: "no_post" };
  if (post.skipped) {
    if (await store.claimOnce(K.sent(date, slot), 3 * DAY)) {
      await require("./payments").notifyAdmins({ text: "🎙 Сегодня вторник, но в дашборде «Эксперты» нет ни одного назначенного слота на сегодня, поэтому пост Дня эфиров в канал не вышел. Если эфир будет, опубликуйте расписание в канале вручную 🤍" }).catch(() => {});
    }
    return { skipped: post.skipped };
  }
  if (!(await store.claimOnce(K.sent(date, slot), 3 * DAY))) return { skipped: "already_sent" };
  const sent = await telegram("sendMessage", { chat_id: process.env.TELEGRAM_CHANNEL_ID, text: post.text, ...(post.reply_markup ? { reply_markup: post.reply_markup } : {}), link_preview_options: { is_disabled: true } });
  if (post.pin && sent && sent.message_id) {
    try { await telegram("pinChatMessage", { chat_id: process.env.TELEGRAM_CHANNEL_ID, message_id: sent.message_id }); } catch (error) { console.error("Pin failed", error.message); }
  }
  return { sent: post.post };
}

// Morning cron: a delayed call for each of today's posts at its Moscow time.
async function schedule(now = Date.now()) {
  const date = mskDate(now);
  const out = [];
  for (const { slot } of plan(date)) {
    const [h, m] = slot.split(":").map(Number);
    const at = Date.parse(`${date}T00:00:00Z`) - 3 * 60 * 60 * 1000 + (h * 60 + m) * 60 * 1000;
    const seconds = Math.max(60, Math.ceil((at - now) / 1000));
    await require("./qstash").scheduleCall("/api/telegram/reminder", { kind: "channel_post", date, slot }, `${seconds}s`);
    out.push({ slot, in_s: seconds });
  }
  return out;
}

// Evening cron: whatever did not go out today (QStash failed) is published now.
async function catchUp(now = Date.now()) {
  const date = mskDate(now);
  const out = {};
  for (const { slot } of plan(date)) {
    try { out[slot] = await publish(date, slot, now); } catch (error) { out[slot] = { error: error.message }; }
  }
  return out;
}

// For the owner: what will be posted on a date, sent to her private chat instead of the channel.
async function preview(chatId, date) {
  const items = plan(date);
  if (!items.length) {
    await telegram("sendMessage", { chat_id: chatId, text: `На ${date} постов в канале нет 🤍` });
    return 0;
  }
  for (const { slot } of items) {
    const post = await build(date, slot);
    if (post && post.skipped) {
      await telegram("sendMessage", { chat_id: chatId, text: `${date}, ${slot} — пост Дня эфиров не выйдет: в дашборде «Эксперты» нет назначенных слотов на этот день.` });
      continue;
    }
    await telegram("sendMessage", { chat_id: chatId, text: `👀 ${date}, ${slot} МСК${post.pin ? " (закрепить)" : ""}:\n\n${post.text}`, ...(post.reply_markup ? { reply_markup: post.reply_markup } : {}), link_preview_options: { is_disabled: true } });
  }
  return items.length;
}

module.exports = { PAGES, AFFIRMATIONS, plan, build, publish, schedule, catchUp, preview, mskDate };
