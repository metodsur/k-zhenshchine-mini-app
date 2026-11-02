// Posts of the free channel «к Женщине» (TELEGRAM_CHANNEL_ID), texts approved by the owner on 25.10.2026.
// Launch week (27.10–01.11) has its own dated posts; from 02.11 the weekly grid repeats by weekday.
// The 9:00 morning cron schedules each of today's posts through QStash for its Moscow time;
// the 18:00 evening cron publishes whatever has not gone out by then. Each post goes out once.
// Buttons are links at the end of the text (inline buttons would hide the comments); with the bot's main
// Mini App they open the app at once (startapp), otherwise they lead to the bot (/start go_<page>).
// If VK is configured (lib/vk.js), every post is repeated on the VK community wall; its buttons become
// links /start vk_<page>, so women from VK are counted as the VK source. VK never blocks the Telegram post.
const { telegram } = require("./telegram");
const store = require("./store");

const LAUNCH_DATE = "2026-10-27";
const WEEKLY_FROM = "2026-11-02";
const K = { sent: (date, slot) => `channel_post:${date}:${slot}`, vk: (date, slot) => `vk_post:${date}:${slot}`, vkError: (date) => `vk_post_error:${date}` };

// /start go_<key> (or startapp=<key>, see access-guard.js) → page of the app. The ritual page opens with
// ?open=1, otherwise a woman who has passed the ritual is sent on to «Пространство».
const PAGES = {
  ritual: "rituals.html?open=1", app: "space.html", abundance: "abundance.html", integrity: "integrity.html",
  accept: "accept.html", practice: "practice.html", about: "about.html", expert: "expert.html", path: "path.html",
  mirror: "mirror.html"
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
      + "Меняет жизнь не то, что мы узнали, а то, что мы внедрили ✨ На этой неделе мы говорили о [неделя].\n\n"
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
    text: "Новая неделя — мягкий шаг к себе ☀️🤍\n\n"
      + "Привет, дорогая! Начинается новая неделя — и у каждой из нас она будет своей 🌿 У каждой свой путь и свой темп. Здесь не нужно становиться кем-то другим или подгонять себя под чужой образ. Можно понемногу возвращаться к себе: чего я хочу? что чувствую? что для меня сейчас по-настоящему важно? ✨\n\n"
      + "В «к Женщине» у пути есть своя внутренняя логика: от дефицита — к целостности и наполненности, от наполненности — к изобилию. А дальше мы постепенно раскрываем больший объём себя и учимся воплощать его в жизни 💫 Не за один день и не по чужому сценарию — шаг за шагом, в своём ритме.\n\n"
      + "«Женщина женщине — дом» 🏡🤍 Это про отношения, в которых можно попросить о поддержке, принять тепло и внимание — и не чувствовать, что теперь ты обязана чем-то отплатить. Одна делится тем, чем может поделиться из своего избытка; другая принимает, наполняется и однажды передаёт дальше уже то, что родилось из её собственного изобилия 🫶\n\n"
      + "И всё, что меняется внутри, может постепенно находить место в обычной жизни: в наших выборах, отношениях, семье, проектах, деньгах и пространстве 🌱\n\n"
      + "На этой неделе не нужно успеть всё и сразу. Давай просто выберем один бережный шаг: чего я сейчас действительно хочу — и что поможет дать этому немного больше места в моей жизни? 🤍\n\n"
      + "Если захочется, поделись в комментариях своим намерением на эту неделю. Нам будет очень тепло прочитать 🌸",
    buttons: [["Мой путь 💫", "about"]]
  },
  broadcasts: {
    text: (ctx) => `Сегодня ${ctx.experts.length === 1 ? "эфир" : "эфиры"} по расписанию 🎙✨\n\n`
      + "Приходи слушать, вдохновляться и знакомиться 🤍\n\n"
      + `Расписание 🕐\n${ctx.experts.map((e) => `${e.time} — ${e.name}, «${e.topic}»`).join("\n")}\n`
      + "Как стать экспертом эфира 💫 Приведи в пространство 20 женщин по своей ссылке. Сделай свою упаковку на платформе проявленности «Уровни» (yrovni.ru) и заполни анкету с ценностями пространства 🌿",
    buttons: []
  },
  broadcasts_empty: {
    text: "Вторник — день голоса, идей и передачи дальше 🎙🤍\n\n"
      + "Дорогие, расписание эфиров на эту неделю пока не сформировано — экспертов на вторник ещё не набрали. Поэтому не будем обещать встречу, которая пока не подтверждена 🌿 Как только появится готовое расписание, мы о нём расскажем.\n\n"
      + "А пока поговорим о том, что стоит за передачей дальше ✨ В «к Женщине» женщина делится не потому, что должна что-то доказать или немедленно кому-то отдать. Передача рождается из наполненности — когда внутри уже есть опыт, знание или практика, которыми хочется поделиться 🫶\n\n"
      + "И это не обязательный следующий шаг для каждой. Можно просто быть участницей пространства, слушать, задавать вопросы и искать то, что откликается именно тебе 🌸 А если тебе самой хочется когда-нибудь выйти в эфир — подумай: о чём ты могла бы говорить с женщинами так, чтобы это было по-настоящему твоим?\n\n"
      + "Расскажи в комментариях, какую тему или вопрос тебе хотелось бы услышать 🤍 А если хочешь предложить себя в качестве эксперта — заполни анкету в приложении. Мы будем собирать темы и сообщим, когда расписание будет подтверждено 💫",
    buttons: [["Анкета эксперта 📝", "expert"]]
  }
};

const VIDEOS = [
  { ordinal: "первое", title: "Как притягивать нужные ресурсы в любом объёме" },
  { ordinal: "второе", title: "Нюансы создания желаемой реальности" },
  { ordinal: "третье", title: "Как получать подарки от пространства" },
  { ordinal: "четвёртое", title: "Как получать подарки от мужчин" }
];
const LAUNCH_WEEK = "ритуале видимости, ресурсах, целостности, Дне дружбы и многомерности";
const USUAL_WEEK = "пути, Дне эфиров, ресурсах, целостности, Дне дружбы и многомерности";
const NOVEMBER_8_WEEK = "собственном пути, передаче знаний, ресурсах, целостности, Дне дружбы и многомерности 🤍";

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
const buttonUrl = (key, direct) => (direct ? `https://t.me/${botName()}?startapp=${key}` : `https://t.me/${botName()}?start=go_${key}`);

// With the bot's main Mini App switched on (BotFather → Bot Settings → Configure Mini App), a button opens
// the app at once (startapp); otherwise it goes through the bot, which answers with the page button.
let directCache = null;
async function directOpen() {
  if (directCache && directCache.at > Date.now() - 10 * 60 * 1000) return directCache.value;
  // A failed check (Telegram slow to answer) is not remembered and counts as switched on: it is on since 27.10.
  try {
    const me = await telegram("getMe", {});
    if (!me || typeof me.has_main_web_app !== "boolean") return true;
    directCache = { at: Date.now(), value: me.has_main_web_app };
    return directCache.value;
  } catch { return true; }
}
// A channel post with inline buttons loses its comments, so the buttons go into the text as links.
const escapeHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const htmlWithLinks = (text, buttons, direct) => [escapeHtml(text),
  ...buttons.map(([t, key]) => `👉 <a href="${escapeHtml(buttonUrl(key, direct))}">${escapeHtml(t)}</a>`)].join("\n\n");
const keyboard = (buttons, direct) => (buttons.length ? { inline_keyboard: buttons.map(([t, key]) => [{ text: t, url: buttonUrl(key, direct) }]) } : undefined);

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
  let postName = item.post;
  let def = POST[postName];
  const ctx = {};
  if (item.post === "resources") ctx.video = VIDEOS[Math.max(0, weeksSince("2026-10-28", date)) % VIDEOS.length];
  if (item.post === "broadcasts") {
    ctx.experts = await expertsOn(date);
    if (!ctx.experts.length) {
      postName = "broadcasts_empty";
      def = POST[postName];
    }
  }
  let text = typeof def.text === "function" ? def.text(ctx) : def.text;
  if (text.includes("[N]")) {
    const n = await memberCount();
    text = text.replace(/\[N\]/g, n ? String(n) : "уже больше");
  }
  const weekSummary = item.launch ? LAUNCH_WEEK : (date === "2026-11-08" ? NOVEMBER_8_WEEK : USUAL_WEEK);
  text = text.replace("[неделя]", weekSummary)
    .replace("[Когда]", item.launch ? "Со следующей недели каждый" : "Каждый");
  text += `\n\n${AFFIRMATIONS[item.aff]}`;
  const html = htmlWithLinks(text, def.buttons, await directOpen());
  return { post: postName, text, html, buttons: def.buttons, pin: Boolean(def.pin) };
}

// Publishes one post (once). Only today's posts, and never before their time.
async function publish(date, slot, now = Date.now()) {
  if (date !== mskDate(now)) return { skipped: "not_today" };
  if (mskNow(now).toISOString().slice(11, 16) < slot) return { skipped: "early" };
  const post = await build(date, slot);
  if (!post) return { skipped: "no_post" };
  const result = await publishTelegram(date, slot, post);
  if (require("./vk").isConfigured()) result.vk = await publishVk(date, slot, post);
  return result;
}

async function publishTelegram(date, slot, post) {
  if (!(await store.claimOnce(K.sent(date, slot), 3 * DAY))) return { skipped: "already_sent" };
  const sent = await telegram("sendMessage", { chat_id: process.env.TELEGRAM_CHANNEL_ID, text: post.html, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  if (post.pin && sent && sent.message_id) {
    try { await telegram("pinChatMessage", { chat_id: process.env.TELEGRAM_CHANNEL_ID, message_id: sent.message_id }); } catch (error) { console.error("Pin failed", error.message); }
  }
  return { sent: post.post };
}

// The VK version of a post: the buttons become links under the text.
function vkText(post) {
  const buttons = (post.buttons || []).map(([t, key]) => `${t}\n${buttonUrl(key, false).replace("?start=go_", "?start=vk_")}`);
  return [post.text, ...buttons].join("\n\n");
}

// Once per post; a failed post is released so the evening run tries again, the team hears about it once a day.
async function publishVk(date, slot, post) {
  if (!(await store.claimOnce(K.vk(date, slot), 3 * DAY))) return "already_sent";
  try {
    await require("./vk").wallPost(vkText(post));
    return "sent";
  } catch (error) {
    console.error("VK post failed", error.message);
    await store.command("DEL", K.vk(date, slot)).catch(() => {});
    if (await store.claimOnce(K.vkError(date), DAY)) {
      await require("./payments").notifyAdmins({ text: `⚠️ Пост не вышел во ВКонтакте (${date}, ${slot}): ${error.message}\nВ Telegram-канале всё вышло. Вечером бот попробует ещё раз 🤍` }).catch(() => {});
    }
    return "error";
  }
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
    await telegram("sendMessage", { chat_id: chatId, text: `👀 ${date}, ${slot} МСК${post.pin ? " (закрепить)" : ""}:\n\n${post.html}`, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
  return items.length;
}

// Owner command /fixpinned: the pinned ritual post gets the current buttons (e.g. after the main Mini App
// was switched on, or after a fix of where the buttons lead).
async function refreshPinned() {
  const chat = await telegram("getChat", { chat_id: process.env.TELEGRAM_CHANNEL_ID });
  const pinned = chat && chat.pinned_message;
  if (!pinned || !pinned.message_id) return { ok: false, reason: "no_pinned" };
  if (!String(pinned.text || "").startsWith("📌 Начни отсюда")) return { ok: false, reason: "not_ritual_post" };
  const direct = await directOpen();
  await telegram("editMessageReplyMarkup", { chat_id: process.env.TELEGRAM_CHANNEL_ID, message_id: pinned.message_id, reply_markup: keyboard(POST.ritual.buttons, direct) });
  return { ok: true, direct };
}

// Owner command /fixbutton: any channel post of the bot gets one url button (e.g. the launch post
// leads to the owner's own post with the ritual).
async function setButton(messageId, url, text = "Пройти ритуал видимости ✨") {
  await telegram("editMessageReplyMarkup", { chat_id: process.env.TELEGRAM_CHANNEL_ID, message_id: messageId, reply_markup: { inline_keyboard: [[{ text, url }]] } });
}

// Owner command /fixpost: a post that went out with inline buttons gets the text with links instead.
async function rewrite(messageId, date, slot) {
  const post = await build(date, slot);
  if (!post || post.skipped) return { ok: false };
  await telegram("editMessageText", { chat_id: process.env.TELEGRAM_CHANNEL_ID, message_id: messageId, text: post.html, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  return { ok: true };
}

module.exports = { rewrite, keyboard, setButton, refreshPinned, directOpen, resetDirect: () => { directCache = null; }, PAGES, AFFIRMATIONS, plan, build, publish, vkText, schedule, catchUp, preview, mskDate };
