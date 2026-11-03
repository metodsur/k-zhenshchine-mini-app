// Posts of the paid club «Наполнение» in its Telegram group (TELEGRAM_CLUB_CHAT_ID), texts approved by the owner
// on 27.10.2026. The week: Пн «Я говорю ДА», Вт принятие, Ср День коллабораций, Чт «Я проявляю грань»,
// Пт «Я вижу и признаю твой объём» + «Зеркало», Сб наполнение себя, Вс «Я воплощаю и признаю созданное»;
// every evening at 20:00 «Волшебство дня». Each ritual has 4 versions, one per week in turn, so the club never
// gets the same text two weeks running.
// Every 2 weeks on Thursday — the big online networking (dates and time from the dashboard «Пары», which also
// opens the pairs ritual after the call): the day before at 17:00 an announcement, on the day at 10:00 the results
// of the two weeks (collaborations, new members, new experts) and a post about each new expert, at 11:50 the link.
// Times are Moscow. The 9:00 morning cron schedules today's posts through QStash; the 18:00 evening cron publishes
// what has not gone out by then. Each post goes out once. New members get a welcome in the group (onJoin).
const { telegram } = require("./telegram");
const store = require("./store");

const CLUB_FROM = "2026-11-02";
const DEFAULT_NETWORKING = { enabled: true, first_date: "2026-11-05", time: "12:00", every_weeks: 2, duration_min: 240 };
const DAY = 24 * 60 * 60 * 1000;
const K = {
  sent: (date, slot) => `club_post:${date}:${slot}`,
  welcome: (userId) => `club_welcome:${userId}`,
  joined: (d) => `stats:club:joined:${d}`,
  collabs: (d) => `stats:club:collabs:${d}`
};
const STATS_KEEP_SECONDS = 45 * 24 * 60 * 60;

const GIFTS = "А ещё помним про подарки: 10 подруг по твоей ссылке — две недели клуба в подарок 🎁 20 — свой эфир в День эфиров 🎙";
const BROADCASTS = "Сегодня в канале «к Женщине» День эфиров с экспертами 🎙 Приходи послушать.";
const SACRED = "А ещё сегодня Варвара делится сакральной практикой из места силы ✨🙏";
const MIRROR = "Хочешь увидеть себя ещё глубже? 🪞 «Зеркало» — личная практика с Мастером многомерности. Мастер отражает твой объём, который сама ты не видишь, и помогает его принять 🤍 Запись открыта только участницам клуба, выбери своего Мастера в приложении ✨";
const WIN = "Запиши эту победу в приложении, в «Мой путь» 🏆 Так ты увидишь, как растёшь неделя за неделей.";
const SUNDAY_GIFTS = "Хочешь, чтобы и подруги наполнялись с тобой? 🫶 Твоя личная ссылка в «Обо мне». 10 подруг — две недели клуба в подарок 🎁 20 — твой эфир в День эфиров 🎙";
const COLLAB_STEPS = "Ритуал дня 📝\n"
  + "1. Зайди в приложение, в «Обо мне», и обнови «Мои ресурсы»: что тебе нужно именно сейчас 🌱\n"
  + "2. Напиши под этим постом: кто ты, чем занимаешься, какие ресурсы тебе нужны и чем ты можешь быть полезна 💬 Есть упаковка на «Уровнях»? Прикрепи ссылку ✨\n"
  + "3. Договорились с кем-то? Напишите в группу #коллаборация и отметь @партнёршу 🤝 Когда она подтвердит, коллаборация засчитается вам обеим в приложении и поднимет ваш рейтинг на платформе «Уровни» 📈";

// [weekday] → 4 versions of the morning ritual (week 1 = the base texts), with buttons.
const RITUALS = {
  1: {
    buttons: [],
    texts: [
      "Новая неделя наполнения ☀️🤍\n\nРитуал «Я говорю ДА» ✨ Наполнение начинается с разрешения. Пока мы говорим «потом» и «не сейчас», новое не может войти в нашу жизнь 🌿\n\nНапиши в комментариях одно своё ДА на эту неделю 📝\n«Говорю ДА …» — новому знакомству, отдыху, своему проекту, помощи, деньгам, себе 💫\n\nМаленькое ДА сегодня — большое наполнение завтра 🌸",
      "Понедельник — день твоего ДА ☀️✨\n\nКаждое «нет» себе забирает силы, каждое «да» их возвращает 🌿 Выбери одно ДА, которое давно откладываешь, и напиши в комментариях: «На этой неделе я говорю ДА …» 📝\n\nВ воскресенье расскажешь, как оно прожилось 🏆",
      "Новая неделя — новое ДА 💫\n\nПредставь, что неделя уже прошла и ты довольна собой 🌸 Чему ты сказала ДА?\n\nНапиши это одной фразой в комментариях, пусть пространство услышит и поддержит 🤍",
      "Доброе утро, наполненная ☀️🤍\n\nСегодня ДА не делам, а себе: отдыху, удовольствию, помощи, просьбе 🌿 Наполнение начинается там, где ты разрешаешь себе получать.\n\nНапиши своё ДА в комментариях и поддержи сердечком ДА другой участницы 🫶"
    ]
  },
  2: {
    buttons: [],
    texts: [
      "Вторник — день принятия 🤲🤍\n\nМногие из нас умеют давать, но теряются, когда дают им 🌸 А наполнение — это всегда два движения: поделиться и принять ✨\n\nРитуал дня 📝\n1. Напиши в комментариях «Дарю…» — чем ты можешь поделиться из своего изобилия: знание, контакт, час своего времени, вещь, консультацию 🎁\n2. Увидела подарок, который откликнулся? Ответь на него: «Принимаю, благодарю» 🙏\n3. Заметь, что ты чувствуешь, когда принимаешь. Это тоже практика 🤍\n\nВажно не только поделиться, но и принять 🫶",
      "Вторник — день принятия 🤲✨\n\nПринять — значит позволить другой женщине проявить к тебе любовь 🌸\n\nРитуал дня 📝\n1. Напиши «Дарю…» — чем можешь поделиться из изобилия 🎁\n2. Ответь «Принимаю, благодарю» на подарок, который откликнулся 🙏\n3. Если принять трудно, напиши и об этом, это тоже шаг 🤍",
      "Вторник — учимся получать 🤲💛\n\nЧасто мы отказываемся словами «да не надо», «я сама» 🌿 Сегодня пробуем по-другому.\n\nРитуал дня 📝 Попроси в комментариях о том, что тебе сейчас нужно. Другим ответь «Дарю…», если можешь помочь. Получила — напиши «Принимаю, благодарю» 🙏",
      "Вторник — щедрость в обе стороны 🤲🤍\n\nИзобилие течёт, когда мы и даём, и принимаем ✨\n\nРитуал дня 📝\n1. Подари комплимент, совет или контакт одной участнице 🎁\n2. Прими то, что подарили тебе, словами «Принимаю, благодарю» 🙏\n3. Заметь, где сегодня тебе дали больше, чем ты ждала 🌸"
    ].map((t) => `${t}\n\n${BROADCASTS}`)
  },
  3: {
    buttons: [["Мои ресурсы 🌱", "about"], ["Моя ссылка 💫", "about"]],
    texts: [
      "Вместе мы создаём больше, чем поодиночке 💫 Сегодня ищем тех, с кем можно создать проект, обменяться услугами или поддержать друг друга 🌿",
      "Одна встреча может стать проектом, клиентом или подругой на годы ✨",
      "Твоё дело становится сильнее рядом с другими 🌿 Сегодня ищем тех, с кем по пути.",
      "Коллаборация — это когда 1 + 1 больше двух 💫 Сегодня собираемся в пары и команды."
    ].map((intro) => `Среда — День коллабораций 🤝✨\n\n${intro}\n\n${COLLAB_STEPS}\n\nВ клубе уже [C] коллабораций 🤍 ${GIFTS}`)
  },
  4: {
    buttons: [],
    texts: [
      "Четверг — день граней 💫🤍\n\nВ тебе намного больше, чем ты показываешь миру ✨ Есть грани, которые ты давно не доставала: танцующая, смешная, дерзкая, нежная, властная 🌸\n\nРитуал дня 📝 Покажи сегодня одну свою грань: фото, видео или пара строк в комментариях «Вот такая я тоже…» 🪞 А если хочется, добавь эту грань в приложении в «Обо мне» 💫",
      "Четверг — день граней 💫🤍\n\nКакой тебя знают немногие? Покажи сегодня эту грань: фото, видео или пара строк «А ещё я…» 🪞",
      "Четверг — день граней 💫🤍\n\nВспомни себя в 7 лет ✨ Что ты любила делать? Эта девочка — тоже твоя грань. Напиши о ней в комментариях 🌸",
      "Четверг — день граней 💫🤍\n\nГрань недели — твоя сила 💪✨ В чём ты по-настоящему сильна? Напиши без скромности, здесь это можно 🤍"
    ]
  },
  5: {
    buttons: [["Записаться на «Зеркало» 🪞", "mirror"]],
    texts: [
      "Каждая женщина раскрывается сильнее, когда её видят ✨ Иногда одна фраза другой женщины меняет целую неделю 🌸\n\nРитуал дня 📝 Выбери одну участницу клуба и напиши в комментариях: «@имя, я вижу в тебе…» 💫 Силу, красоту, талант, то, как она тебе помогла.",
      "Ритуал дня 📝 Напиши «@имя, спасибо тебе за…» участнице, которая на этой неделе тебя поддержала или вдохновила 🌸",
      "Ритуал дня 📝 Отметь женщину из клуба, в которой ты видишь то, что она сама в себе пока не видит: «@имя, я вижу в тебе…» ✨",
      "Признание по кругу 🫶 Напиши признание участнице, которая написала комментарий перед тобой. Следующая напишет тебе 🌸"
    ].map((t) => `Пятница — день признания 🪞🤍\n\n${t}\n\n${MIRROR}`)
  },
  6: {
    buttons: [],
    texts: [
      "Сегодня всё для тебя: для тела, для души, для силы 🌿 Наполненная женщина наполняет всё вокруг ✨\n\nРитуал дня 📝 Поделись в комментариях своей практикой, которая тебя наполняет 💬 Прогулка без телефона, ванна с солью, танец, дыхание, молитва, любимая музыка, что угодно 🌸 Твоя практика может стать чьим-то спасением сегодня.",
      "Практика недели — для тела 🌿 Поделись в комментариях, как ты возвращаешься в тело: движение, массаж, растяжка, баня, танец 💬",
      "Практика недели — для души 🌙 Что возвращает тебе радость: музыка, книга, природа, творчество? Поделись в комментариях 💬",
      "Утро наполненной женщины ☀️ Опиши в комментариях своё идеальное утро или маленький утренний ритуал, который тебя собирает 💬"
    ].map((t) => `Суббота — День наполнения себя 🌺🤍\n\n${t}\n\n${SACRED}`)
  },
  0: {
    buttons: [["Мой путь и ссылка 💫", "about"]],
    texts: [
      "Мы часто бежим дальше и не замечаем, сколько уже создали 🌸 Сегодня останавливаемся и признаём ✨\n\nРитуал дня 📝\n1. Напиши в комментариях, что ты воплотила за неделю: новая привычка, найденный ресурс, знакомство, деньги, сделанный шаг 💫\n2. Запиши эту победу в приложении, в «Мой путь» 🏆 Так ты увидишь, как растёшь неделя за неделей.\n3. Скажи себе: «Я признаю созданное» 🤍",
      `Что изменилось в тебе за эту неделю? Напиши одну вещь, которую ты сделала впервые 🏆\n\n${WIN}`,
      `Вспомни своё понедельничное ДА. Как оно прожилось? Что получилось, даже если не всё 🌸\n\n${WIN}`,
      `Победа недели в цифрах ✨ Деньги, клиенты, километры, страницы, часы сна — что выросло?\n\n${WIN}`
    ].map((t) => `Воскресенье — день признания себя 🏆🤍\n\n${t}\n\n${SUNDAY_GIFTS}`)
  }
};

const MAGIC_FIRST = {
  1: "Как сегодня прожилось твоё ДА? ☀️", 2: "Что ты сегодня приняла? 🤲", 3: "С кем ты сегодня познакомилась? 🤝",
  4: "Какая ты была сегодня? 💫", 5: "Кто тебя сегодня увидел? 🪞", 6: "Что тебя сегодня наполнило? 🌺",
  0: "За неделю в клубе было [M] историй волшебства ✨ Чем закончилась твоя?"
};
const magicText = (weekday) => `Волшебство дня 🌙✨\n\n${MAGIC_FIRST[weekday]}\n\nПоделись в комментариях 💬\n🏆 одним результатом дня, даже самым маленьким;\n✨ и тем, что волшебного сегодня произошло: встреча, знак, подарок, совпадение.\n\nТвоя история может стать чьим-то вдохновением завтра 🤍 #волшебстводня`;

const WELCOME_PIN = "Добро пожаловать в клуб «Наполнение» 🤍✨\n\n"
  + "Это второй этап твоего пути в экосистеме «к Женщине» 🌿 В «Целостности» ты собирала себя воедино. Здесь ты наполняешься: ресурсом, людьми, поддержкой, возможностями 💫\n\n"
  + "Почему это работает 🌸 Женщина наполняется не разовым рывком, а маленькими действиями каждый день. Одно ДА, один принятый подарок, одно новое знакомство, одно «я вижу тебя». А пространство женщин держит тебя в этом ритме, даже когда сил мало 🫶 Так из дня в день становится больше энергии, людей и результатов ✨\n\n"
  + "Что тебя ждёт каждую неделю 🗓\n☀️ Пн — «Я говорю ДА»\n🤲 Вт — наполнение через принятие\n🤝 Ср — День коллабораций\n💫 Чт — «Я проявляю грань», а раз в 2 недели — большой онлайн-нетворкинг с 12:00\n🪞 Пт — «Я вижу и признаю твой объём» и «Зеркало» с Мастерами\n🌺 Сб — День наполнения себя: практики для тела, души и сакральные практики\n🏆 Вс — «Я воплощаю и признаю созданное»\n🌙 Каждый вечер в 20:00 — «Волшебство дня»\n\n"
  + "Иди в своём ритме: даже один ритуал в неделю уже наполняет 🤍 Свой путь, победы и коллаборации смотри в приложении, в «Обо мне» 💫";

// ---------- calendar ----------
const mskNow = (now) => new Date(now + 3 * 60 * 60 * 1000);
const mskDate = (now) => mskNow(now).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const weeksSince = (from, date) => Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / (7 * DAY));
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// Networking dates come from the dashboard «Пары» (the same call opens the pairs ritual); until it is set — from 05.11.
async function networking() {
  let config = null;
  try { config = await require("./pairs").loadConfig(); } catch { config = null; }
  return config && config.enabled && config.first_date ? config : DEFAULT_NETWORKING;
}
function isNetworkingDay(config, date) {
  if (date < config.first_date) return false;
  const days = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${config.first_date}T12:00:00Z`)) / DAY);
  return days % (config.every_weeks * 7) === 0;
}
const minus = (time, minutes) => { const [h, m] = time.split(":").map(Number); const t = h * 60 + m - minutes; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };

// The plan of a day: [{ slot, post }].
async function plan(date) {
  if (date < CLUB_FROM) return [];
  const net = await networking();
  const weekday = weekdayOf(date);
  const items = [];
  if (isNetworkingDay(net, date)) {
    items.push({ slot: "10:00", post: "report" }, { slot: "10:05", post: "experts" }, { slot: minus(net.time, 10), post: "call_soon" });
  } else items.push({ slot: "10:00", post: "ritual" });
  if (isNetworkingDay(net, addDays(date, 1))) items.push({ slot: "17:00", post: "announce" });
  items.push({ slot: "20:00", post: "magic" });
  return items.sort((a, b) => a.slot.localeCompare(b.slot));
}

// ---------- numbers ----------
async function sumDays(keyOf, days, now) {
  const keys = Array.from({ length: days }, (_, i) => keyOf(new Date(now - i * DAY).toISOString().slice(0, 10)));
  return ((await store.command("MGET", ...keys)) || []).reduce((a, v) => a + (Number(v) || 0), 0);
}
async function joinedIn(days, now) {
  const keys = Array.from({ length: days }, (_, i) => K.joined(new Date(now - i * DAY).toISOString().slice(0, 10)));
  return ((await store.command("SUNION", ...keys)) || []).length;
}
// Experts who got a slot or went on air in the last two weeks (dashboard «Эксперты»).
async function newExperts(now) {
  const items = await require("./os-collections").load("experts");
  return items.filter((e) => (e.stage === "slot" || e.stage === "done") && Date.parse(e.updated_at || 0) > now - 14 * DAY);
}
async function callUrl() {
  try { return (await require("./settings").loadSettings()).club_call_url || ""; } catch { return ""; }
}

// ---------- building ----------
async function build(date, slot, now = Date.now()) {
  const item = (await plan(date)).find((p) => p.slot === slot);
  if (!item) return null;
  const { AFFIRMATIONS, keyboard, directOpen } = require("./channel-posts");
  const weekday = weekdayOf(date);
  const week = Math.max(0, weeksSince(CLUB_FROM, date));
  const aff = AFFIRMATIONS[(week * 5 + weekday + 7) % AFFIRMATIONS.length];
  const net = await networking();
  const url = await callUrl();
  const link = url || "ссылка придёт перед стартом";
  let text;
  let buttons = [];
  let texts = null;
  if (item.post === "ritual") {
    const ritual = RITUALS[weekday];
    text = ritual.texts[week % ritual.texts.length];
    buttons = ritual.buttons;
    if (text.includes("[C]")) text = text.replace("[C]", String(Number(await store.command("GET", "stats:club:collabs:total")) || 0));
    text += `\n\n${aff}`;
  } else if (item.post === "magic") {
    text = magicText(weekday);
    if (text.includes("[M]")) text = text.replace("[M]", String(await countMagic(now)));
  } else if (item.post === "announce") {
    const end = minus(net.time, -net.duration_min);
    text = `Завтра большой нетворкинг клуба 🤝✨ Четверг, ${net.time}–${end} по Москве, онлайн.\n\n`
      + "Зачем приходить 💫\n🤍 Живые знакомства. За один созвон ты узнаешь больше женщин, чем за полгода переписки в чате.\n🌿 Ресурсы. Каждая расскажет, что ей нужно и чем она может поделиться. Иногда нужный человек находится за 5 минут.\n🤝 Коллаборации. Именно тут рождаются совместные проекты, клиенты и партнёрства.\n🫶 Ритуал в паре. После созвона у тебя появится новая пара, и так каждые 2 недели одно близкое знакомство.\n\n"
      + "Подготовь презентацию себя на 1 минуту: кто ты, чем занимаешься, что тебе нужно 🎙 Есть упаковка на «Уровнях»? Возьми её с собой ✨ Можно прийти не на весь созвон, а на сколько получится 🌸\n\n🏡 Женщина женщине — дом.";
  } else if (item.post === "report") {
    const [collabs, joined, experts] = await Promise.all([sumDays(K.collabs, 14, now), joinedIn(14, now), newExperts(now)]);
    text = "Итоги двух недель клуба «Наполнение» 🎉🤍\n\n"
      + `🤝 Коллабораций: ${collabs}\n🌸 Новых участниц клуба: ${joined}\n🎙 Новых экспертов пространства: ${experts.length}\n\n`
      + `Спасибо каждой из вас ✨ Сегодня в ${net.time} большой нетворкинг: расскажем, что стоит за этими цифрами, и создадим новые 💫 Ссылка: ${link} 🔗`;
  } else if (item.post === "experts") {
    const experts = await newExperts(now);
    if (!experts.length) return { skipped: "no_experts", post: item.post };
    texts = experts.map((e) => `Знакомьтесь: ${e.name || "эксперт"} — эксперт пространства «к Женщине» 🎙✨\n\n`
      + `Она пригласила в пространство ${Number(e.invited) || 20} женщин и выходит в эфир с темой «${e.title}» 🌸`
      + `${e.levels_url ? ` Её упаковка на «Уровнях»: ${e.levels_url} 🔗` : ""}\n\n`
      + "Хочешь так же? Пригласи 20 подруг по своей ссылке из «Обо мне», и твой эфир ждёт тебя во вторник 🫶");
    buttons = [["Моя ссылка 💫", "about"]];
  } else if (item.post === "call_soon") {
    text = `Через 10 минут начинаем нетворкинг 🤝✨ Наливай чай и заходи: ${link} 🤍`;
    if (!url) await require("./payments").notifyAdmins({ text: "🤝 Через 10 минут нетворкинг клуба, а ссылки на созвон нет в админке → «Ссылки» («Ссылка на созвон нетворкинга клуба»). Пришлите её в группу клуба вручную 🤍" }).catch(() => {});
  }
  const reply_markup = buttons.length ? keyboard(buttons, await directOpen()) : undefined;
  return { post: item.post, texts: texts || [text], reply_markup };
}

async function countMagic(now) {
  return sumDays((d) => `stats:club:magic:${d}`, 7, now);
}

async function publish(date, slot, now = Date.now()) {
  const chatId = String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim();
  if (!chatId) return { skipped: "no_club" };
  if (date !== mskDate(now)) return { skipped: "not_today" };
  if (mskNow(now).toISOString().slice(11, 16) < slot) return { skipped: "early" };
  const post = await build(date, slot, now);
  if (!post) return { skipped: "no_post" };
  if (post.skipped) return { skipped: post.skipped };
  if (!(await store.claimOnce(K.sent(date, slot), 3 * DAY))) return { skipped: "already_sent" };
  for (const text of post.texts) {
    const sent = await telegram("sendMessage", { chat_id: chatId, text, ...(post.reply_markup ? { reply_markup: post.reply_markup } : {}), link_preview_options: { is_disabled: true } });
    // Replies to «Волшебство дня» are counted for the Sunday evening post.
    if (post.post === "magic" && sent && sent.message_id) await store.command("SET", `club_magic_post:${sent.message_id}`, "1", "EX", 8 * 24 * 60 * 60);
  }
  return { sent: post.post, count: post.texts.length };
}

// The pinned welcome post: once, on the first run.
async function ensureWelcomePin() {
  const chatId = String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim();
  if (!chatId || !(await store.claimOnce("club_post:welcome_pin", 10 * 365 * 24 * 60 * 60))) return false;
  const { keyboard, directOpen } = require("./channel-posts");
  const sent = await telegram("sendMessage", { chat_id: chatId, text: WELCOME_PIN, reply_markup: keyboard([["Мой путь 💫", "about"]], await directOpen()) });
  try { await telegram("pinChatMessage", { chat_id: chatId, message_id: sent.message_id }); } catch (error) { console.error("Club pin failed", error.message); }
  return true;
}

// Morning cron: the welcome pin (once) and a delayed call for each of today's posts.
async function schedule(now = Date.now()) {
  if (!String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim()) return [];
  const date = mskDate(now);
  // Nothing goes to the group before the club starts, the welcome pin included.
  if (date < CLUB_FROM) return [];
  try { await ensureWelcomePin(); } catch (error) { console.error("Club welcome pin failed", error.message); }
  const out = [];
  for (const { slot } of await plan(date)) {
    const [h, m] = slot.split(":").map(Number);
    const at = Date.parse(`${date}T00:00:00Z`) - 3 * 60 * 60 * 1000 + (h * 60 + m) * 60 * 1000;
    const seconds = Math.max(60, Math.ceil((at - now) / 1000));
    await require("./qstash").scheduleCall("/api/telegram/reminder", { kind: "club_post", date, slot }, `${seconds}s`);
    out.push({ slot, in_s: seconds });
  }
  return out;
}

// Evening cron (18:00): what is due by now and did not go out is published.
async function catchUp(now = Date.now()) {
  const date = mskDate(now);
  const out = {};
  for (const { slot } of await plan(date)) {
    try { out[slot] = await publish(date, slot, now); } catch (error) { out[slot] = { error: error.message }; }
  }
  return out;
}

// A new member of the club group: counted for the two-week results and welcomed once.
async function onJoin(user, now = Date.now()) {
  const chatId = String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim();
  if (!chatId || !user || user.is_bot) return false;
  const d = new Date(now).toISOString().slice(0, 10);
  await store.command("SADD", K.joined(d), user.id);
  await store.command("EXPIRE", K.joined(d), STATS_KEEP_SECONDS);
  // Before the club starts the pin is not there yet, so newcomers are only counted.
  if (mskDate(now) < CLUB_FROM) return false;
  if (!(await store.claimOnce(K.welcome(user.id), 365 * 24 * 60 * 60))) return false;
  const name = user.first_name || "Дорогая";
  await telegram("sendMessage", { chat_id: chatId, text: `${name}, добро пожаловать в клуб «Наполнение» 🤍✨ Мы так рады, что ты здесь 🌸 Расскажи в ответ пару слов о себе: из какого ты города, чем занимаешься и чего тебе сейчас хочется наполниться 🌿 Всё о клубе — в закрепе 📌` });
  return true;
}

// A reply to «Волшебство дня» (or #волшебстводня) in the group → the Sunday evening count.
async function trackMagic(message, now = Date.now()) {
  const reply = message.reply_to_message && message.reply_to_message.message_id;
  const isReply = reply && (await store.command("GET", `club_magic_post:${reply}`));
  if (!isReply && !/#волшебстводня/i.test(`${message.text || ""} ${message.caption || ""}`)) return false;
  const d = new Date(now).toISOString().slice(0, 10);
  await store.command("INCR", `stats:club:magic:${d}`);
  await store.command("EXPIRE", `stats:club:magic:${d}`, STATS_KEEP_SECONDS);
  return true;
}

module.exports = { plan, build, publish, schedule, catchUp, onJoin, trackMagic, ensureWelcomePin, RITUALS, CLUB_FROM };
