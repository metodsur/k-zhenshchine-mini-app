// Dashboard collections described by schemas: content production board, media pipeline,
// platforms registry and materials library. The dashboard draws forms and boards from these
// schemas, so adding a field is a one-line change here.
const crypto = require("crypto");
const store = require("./store");

const opts = (map) => Object.entries(map).map(([value, label]) => ({ value, label }));

const FORMATS = { reels: "Reels", shorts: "Shorts", tiktok: "TikTok", stories: "Stories", telegram: "Пост в Telegram", youtube: "YouTube", carousel: "Карусель", other: "Другое" };
const METRICS = [
  ["views", "Просмотры"], ["retention", "Удержание, %"], ["completion", "Досмотры, %"], ["saves", "Сохранения"],
  ["shares", "Пересылки"], ["comments", "Комментарии"], ["clicks", "Переходы"], ["follows", "Подписки"]
];

const SCHEMAS = {
  content: {
    title: "Контент-производство",
    item: "Ролик",
    perm: "content.edit",
    stages: { idea: "Idea", script: "Script", shoot: "Shoot", edit: "Edit", approved: "Approved", scheduled: "Scheduled", published: "Published", analyzed: "Analyzed" },
    done_from: "published",
    due_field: "due",
    calendar: { field: "publish_date", time: "publish_time", kind: "content", label: "Публикация" },
    fields: [
      { id: "title", label: "Тема / рабочее название", type: "text", required: true, card: true },
      { id: "format", label: "Формат", type: "select", options: opts(FORMATS), card: true },
      { id: "platform", label: "Площадка", type: "text", card: true },
      { id: "owner", label: "Ответственный", type: "text", card: true },
      { id: "due", label: "Срок этапа", type: "date", card: true },
      { id: "source_ref", label: "Исходник (SOURCE ID или ссылка)", type: "text", group: "Источник" },
      { id: "source_rule", label: "Правило использования", type: "select", group: "Источник", options: opts({ source: "SOURCE", verbatim: "VERBATIM", paraphrase: "PARAPHRASE", derived: "DERIVED IDEA", new: "NEW SCRIPT" }) },
      { id: "hook", label: "Hook", type: "long", group: "Съёмочный пакет для Варвары" },
      { id: "first_frame", label: "Первый кадр", type: "long", group: "Съёмочный пакет для Варвары" },
      { id: "screen_text", label: "Текст на экране", type: "long", group: "Съёмочный пакет для Варвары" },
      { id: "visual_notes", label: "Визуальные указания", type: "long", group: "Съёмочный пакет для Варвары" },
      { id: "script", label: "Сценарий", type: "long", group: "Съёмочный пакет для Варвары" },
      { id: "raw_url", label: "Снятый материал (ссылка)", type: "url", group: "Производство" },
      { id: "edit_url", label: "Готовый монтаж (ссылка)", type: "url", group: "Производство" },
      { id: "cover_url", label: "Обложка (ссылка)", type: "url", group: "Производство" },
      { id: "caption", label: "Описание к публикации", type: "long", group: "Производство" },
      { id: "publish_date", label: "Дата публикации", type: "date", group: "Публикация" },
      { id: "publish_time", label: "Время", type: "time", group: "Публикация" },
      { id: "post_url", label: "Ссылка на публикацию", type: "url", group: "Публикация" },
      { id: "metrics", label: "Результаты", type: "metrics", group: "Аналитика", metrics: METRICS },
      { id: "notes", label: "Заметки", type: "long", group: "Аналитика" }
    ]
  },
  media: {
    title: "Медийность",
    item: "Медийный выход",
    perm: "media.edit",
    stages: { target: "Target", contacted: "Contacted", replied: "Replied", negotiation: "Negotiation", booked: "Booked", preparation: "Preparation", appearance: "Appearance", published: "Published", distribution: "Distribution", analytics: "Analytics" },
    done_from: "appearance",
    due_field: "next_date",
    calendar: { field: "date", time: "time", kind: "media", label: "Медийный выход" },
    fields: [
      { id: "title", label: "Площадка / проект", type: "text", required: true, card: true },
      { id: "kind", label: "Тип", type: "select", card: true, options: opts({ podcast: "Подкаст", youtube: "YouTube-интервью", press: "СМИ", forum: "Форум", conference: "Конференция", talk: "Выступление", collab: "Коллаборация", special: "Спецпроект" }) },
      { id: "audience", label: "Аудитория (размер, кто)", type: "text", card: true },
      { id: "owner", label: "Ответственный", type: "text", card: true },
      { id: "contact_name", label: "Редактор / продюсер", type: "text", group: "Контакт" },
      { id: "contact", label: "Контакт", type: "text", group: "Контакт" },
      { id: "next_date", label: "Следующий шаг — дата", type: "date", group: "Контакт", card: true },
      { id: "next_action", label: "Следующий шаг — действие", type: "text", group: "Контакт" },
      { id: "topic", label: "Тема", type: "text", group: "Подготовка" },
      { id: "pitch", label: "Pitch", type: "long", group: "Подготовка" },
      { id: "theses", label: "Тезисы выступления / интервью", type: "long", group: "Подготовка" },
      { id: "date", label: "Дата выхода", type: "date", group: "Выход", card: true },
      { id: "time", label: "Время", type: "time", group: "Выход" },
      { id: "logistics", label: "Логистика", type: "long", group: "Выход" },
      { id: "cta", label: "CTA для аудитории", type: "text", group: "Выход" },
      { id: "tracking", label: "Метка источника (для ссылки на бота)", type: "code", group: "Выход" },
      { id: "recording_url", label: "Запись (ссылка)", type: "url", group: "После выхода" },
      { id: "publication_url", label: "Публикация (ссылка)", type: "url", group: "После выхода" },
      { id: "in_factory", label: "Запись передана в Content Factory", type: "check", group: "После выхода" },
      { id: "notes", label: "Заметки и результаты", type: "long", group: "После выхода" }
    ]
  },
  platforms: {
    title: "Площадки",
    item: "Площадка",
    perm: "library.edit",
    fields: [
      { id: "title", label: "Название", type: "text", required: true, card: true },
      { id: "owner", label: "Чья", type: "select", card: true, options: opts({ varvara: "Варвара", project: "«к Женщине»" }) },
      { id: "kind", label: "Тип", type: "select", card: true, options: opts({ instagram: "Instagram", telegram_channel: "Telegram-канал", telegram_chat: "Telegram-чат", mini_app: "Mini App / бот", youtube: "YouTube", vk: "VK", tiktok: "TikTok", site: "Сайт / лендинг", form: "Форма регистрации", payment: "Страница оплаты", archive: "Архив", other: "Другое" }) },
      { id: "url", label: "Актуальная ссылка", type: "url", required: true, card: true },
      { id: "role", label: "Роль", type: "select", card: true, options: opts({ discovery: "Discovery", trust: "Trust", community: "Community", conversion: "Conversion", retention: "Retention" }) },
      { id: "followers", label: "Подписчики", type: "number", card: true },
      { id: "audience", label: "Аудитория — для кого", type: "long" },
      { id: "content", label: "Контент — форматы", type: "long" },
      { id: "frequency", label: "Частота (фактический ритм)", type: "text" },
      { id: "cta", label: "CTA — следующее действие", type: "text" },
      { id: "route", label: "Маршрут — куда ведёт CTA", type: "text" },
      { id: "responsible", label: "Ответственный (готовит / публикует / проверяет)", type: "text" },
      { id: "kpi", label: "KPI", type: "text" }
    ]
  },
  training: {
    title: "Материалы обучения",
    item: "Материал",
    perm: "masters.edit",
    fields: [
      { id: "title", label: "Название", type: "text", required: true, card: true },
      { id: "audience", label: "Для кого", type: "select", card: true, options: opts({ student: "Ученицам обучения", master: "Мастерам многомерности", all: "Всем" }) },
      { id: "module", label: "Раздел", type: "select", card: true, options: opts({ "1": "Встреча 1", "2": "Встреча 2", "3": "Встреча 3", extra: "Дополнительно", method: "Методика ведения" }) },
      { id: "kind", label: "Тип", type: "select", card: true, options: opts({ video: "Видео", doc: "Документ", practice: "Практика", task: "Задание" }) },
      { id: "url", label: "Ссылка (видео, файл)", type: "url" },
      { id: "text", label: "Описание или текст задания", type: "long" },
      { id: "order", label: "Порядок (1, 2, 3…)", type: "number" }
    ]
  },
  instructions: {
    title: "Инструкции для Мастеров",
    item: "Инструкция",
    perm: "masters.edit",
    fields: [
      { id: "title", label: "Название", type: "text", required: true, card: true },
      { id: "section", label: "Раздел", type: "select", card: true, options: opts({ ideology: "Идеология экосистемы", possibilities: "Возможности экосистемы", meetings: "Как проводить встречи многомерности", circle: "Как проводить женский круг офлайн", other: "Другое" }) },
      { id: "text", label: "Текст инструкции", type: "long" },
      { id: "url", label: "Видео или файл (ссылка)", type: "url" },
      { id: "order", label: "Порядок (1, 2, 3…)", type: "number" }
    ]
  },
  templates: {
    title: "Шаблоны сообщений",
    item: "Шаблон",
    perm: "crm.edit",
    fields: [
      { id: "title", label: "Название", type: "text", required: true, card: true },
      { id: "category", label: "Для чего", type: "select", card: true, options: opts({ invite: "Приглашение", reminder: "Напоминание", seats: "Свободные места", club: "Клуб", objection: "Ответ на возражение", followup: "Follow-up", other: "Другое" }) },
      { id: "text", label: "Текст ({имя} и {город} подставятся сами)", type: "long", required: true }
    ]
  },
  library: {
    title: "Библиотека материалов",
    item: "Материал",
    perm: "library.edit",
    fields: [
      { id: "title", label: "Название", type: "text", required: true, card: true },
      { id: "category", label: "Раздел", type: "select", card: true, options: opts({ bio: "Био Варвары", project: "Описание проекта", ideology: "Идеология «Женщина женщине — дом»", photos: "Фотографии", logos: "Логотипы и визуал", mediakit: "Презентации и media kit", products: "Продуктовая линейка", prices: "Цены, даты, места, ссылки", recordings: "Интервью и выступления", reviews: "Отзывы участниц" }) },
      { id: "url", label: "Ссылка (Диск, файл)", type: "url", card: true },
      { id: "text", label: "Текст (для копирования)", type: "long" },
      { id: "approved", label: "Утверждено к использованию", type: "check", card: true },
      { id: "notes", label: "Заметки (где можно использовать, ограничения)", type: "long" }
    ]
  }
};

const clean = (value, max = 300) => String(value == null ? "" : value).replace(/[ \t]+/g, " ").trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const key = (name) => `os:col:${name}`;

// Starter templates until the team saves its own.
const DEFAULT_TEMPLATES = [
  { id: "t1", category: "invite", title: "Приглашение на цикл", text: "{имя}, привет! 🤍 Это команда «к Женщине». Скоро стартует новый цикл многомерности ({город}) — 6 живых встреч, где женщина раскрывает свой объём и опору. Хочешь, расскажу подробнее и придержу для тебя место?" },
  { id: "t2", category: "seats", title: "Осталось несколько мест", text: "{имя}, в ближайшем цикле ({город}) осталось всего несколько мест. Если чувствуешь отклик — записаться можно прямо в приложении, в разделе «Встречи». Будем очень рады тебе 🤍" },
  { id: "t3", category: "reminder", title: "Не завершила оплату", text: "{имя}, видим, что запись на встречу не завершилась. Если что-то не получилось с оплатой — напиши, поможем. Место пока свободно 🤍" },
  { id: "t4", category: "club", title: "Приглашение в клуб", text: "{имя}, в клубе «к Женщине» каждый день — ритуалы наполнения ресурса, ритуалы в паре и Дни коллабораций. Ждём тебя в клубе: 999 ₽ в месяц, отменить можно в любой момент." },
  { id: "t5", category: "objection", title: "«Дорого»", text: "{имя}, понимаю. Можно начать с одной встречи — почувствовать, откликается ли. А если решишь пройти весь путь, пакет из 6 встреч выгоднее, чем по отдельности." },
  { id: "t6", category: "followup", title: "После 1-й встречи", text: "{имя}, как ты после встречи? 🤍 Многие говорят, что раскрытие только начинается — следующая встреча продолжает путь. Хочешь, забронирую тебе место?" }
];

// Starter structure of the Masters' instructions: organisation only — the method itself is added by Varvara.
const DEFAULT_INSTRUCTIONS = [
  { id: "i0", section: "ideology", order: 1, title: "Женщина женщине — дом", text: "Наша миссия — перевести миллионы женщин из состояния функции в многомерный, многогранный объём, раскрыть внутри состояние Женщины Мира и создать одну из лучших экосистем проявленности женщины.\n\nМы создаём пространство, в котором женщина может возвращаться к своей целостности, раскрывать многомерность и по-новому взаимодействовать с другой женщиной. Ритуалы — не обязательные задания, а живые практики, через которые мы проявляемся, видим друг друга, поддерживаем, создаём связи и воплощаем своё.\n\n[Полный текст идеологии добавит Варвара]" },
  { id: "i00", section: "possibilities", order: 1, title: "Что есть в экосистеме «к Женщине»", text: "• Бесплатный канал и приложение: ритуал видимости, путь, материалы «Целостность».\n• Клуб «к Женщине» (999 ₽/мес): ежедневные ритуалы наполнения, ритуалы в паре, практика «Зеркало» с Мастерами, Дни коллабораций, авторские серии Варвары.\n• Живые встречи многомерности: 6 встреч в городах и женский круг после встречи.\n• Путь Мастера: обучение, статус Мастера многомерности, ведение групп и «Зеркала», доход за встречи.\n• Путь Партнёра: размещение своего проекта в экосистеме, коллаборации с участницами.\n\nКак Мастеру использовать экосистему: приглашайте женщин по своей реферальной ссылке, рекомендуйте клуб участницам групп, предлагайте «Зеркало» и следующую встречу.\n\n[Дополнит Варвара]" },
  { id: "i1", section: "meetings", order: 1, title: "Подготовка к встрече многомерности", text: "• За 3 дня: проверьте площадку, технику (звук, свет, коврики, пледы), запишите участниц из кабинета («Мои группы»).\n• За день: бот сам напомнит участницам о встрече — проверьте, что дата и адрес в цикле указаны верно.\n• В день встречи: приходите за 40–60 минут, подготовьте пространство, свечи, воду, музыку.\n\n[Содержание и методику встреч 1–6 добавит Варвара]" },
  { id: "i2", section: "meetings", order: 2, title: "Ход встречи", text: "[Структура встречи, практики и тайминг — добавит Варвара]\n\nОбщее для всех встреч:\n• Отметьте присутствующих в кабинете Мастера (вкладка «Мои группы»).\n• Бережность: не давайте медицинских и психологических диагнозов; при тяжёлом состоянии участницы — мягко предложите обратиться к специалисту и сообщите команде." },
  { id: "i3", section: "meetings", order: 3, title: "После встречи", text: "• Наутро бот сам попросит участниц оценить встречу — отзывы и оценки появятся у команды.\n• Передайте фото и видео (если была съёмка) команде для контента.\n• Ответьте участницам, которые написали вам лично." },
  { id: "i4", section: "circle", order: 1, title: "Как проводить женский круг офлайн", text: "[Формат, ритуал открытия и закрытия круга, правила круга — добавит Варвара]\n\nОрганизация:\n• Круг проходит после живой встречи многомерности.\n• Пространство: стулья или подушки по кругу, без столов между участницами.\n• Правила круга проговаривайте в начале: конфиденциальность, говорим от себя, не даём советов без запроса.\n• Завершение: благодарность, приглашение на следующую встречу и в клуб." }
];

async function load(name) {
  const raw = await store.command("GET", key(name));
  if (!raw && name === "templates") return DEFAULT_TEMPLATES.map((t) => ({ ...t }));
  if (!raw && name === "instructions") return DEFAULT_INSTRUCTIONS.map((t) => ({ ...t }));
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
const save = (name, list) => store.command("SET", key(name), JSON.stringify(list)).then(() => list);

function normalize(schema, src) {
  const errors = [];
  const item = {};
  for (const f of schema.fields) {
    const v = src ? src[f.id] : undefined;
    if (f.type === "check") { item[f.id] = Boolean(v); continue; }
    if (f.type === "metrics") {
      const out = {};
      for (const [mid, label] of f.metrics) {
        const raw = v && v[mid];
        if (raw === "" || raw == null) continue;
        const n = Number(String(raw).replace(",", "."));
        if (!(n >= 0)) errors.push(`${label}: нужно число`);
        else out[mid] = n;
      }
      item[f.id] = out;
      continue;
    }
    if (f.type === "number") {
      if (v === "" || v == null) { item[f.id] = null; continue; }
      const n = Math.round(Number(v));
      if (!(n >= 0)) errors.push(`${f.label}: нужно целое число`);
      item[f.id] = n >= 0 ? n : null;
      continue;
    }
    const value = clean(v, f.type === "long" ? 5000 : f.type === "url" ? 600 : 200);
    if (f.required && !value) errors.push(`Заполните поле «${f.label}»`);
    if (value && f.type === "date" && !isDate(value)) errors.push(`${f.label}: дата в формате ГГГГ-ММ-ДД`);
    if (value && f.type === "time" && !/^\d{2}:\d{2}$/.test(value)) errors.push(`${f.label}: время в формате ЧЧ:ММ`);
    if (value && f.type === "url" && !/^https?:\/\/\S+$/i.test(value)) errors.push(`${f.label}: ссылка должна начинаться с https://`);
    if (value && f.type === "code" && !/^[A-Za-z0-9_-]{1,64}$/.test(value)) errors.push(`${f.label}: только латиница, цифры, _ и -`);
    if (value && f.type === "select" && !f.options.some((o) => o.value === value)) errors.push(`${f.label}: неизвестное значение`);
    item[f.id] = value;
  }
  return { errors, item };
}

// Creates or updates an item; stage moves are recorded with their date (for deadlines and reports).
async function saveItem(name, input, by) {
  const schema = SCHEMAS[name];
  const src = input && typeof input === "object" ? input : {};
  const { errors, item } = normalize(schema, src);
  let stage = null;
  if (schema.stages) {
    stage = schema.stages[src.stage] ? src.stage : Object.keys(schema.stages)[0];
  }
  if (errors.length) return { status: 400, errors };
  const list = await load(name);
  const at = new Date().toISOString();
  let saved;
  let beforeItem = null;
  if (src.id) {
    const i = list.findIndex((x) => x.id === src.id);
    if (i === -1) return { status: 404, errors: ["Карточка не найдена"] };
    const before = list[i];
    beforeItem = before;
    saved = { ...before, ...item, updated_at: at };
    if (schema.stages && stage !== before.stage) {
      saved.stage = stage;
      saved.stage_at = at;
      saved.history = [...(before.history || []), { at, by, text: `${schema.stages[before.stage]} → ${schema.stages[stage]}` }].slice(-100);
    }
    list[i] = saved;
  } else {
    saved = { id: crypto.randomBytes(5).toString("hex"), ...item, created_at: at, updated_at: at, history: [{ at, by, text: "Создано" }] };
    if (schema.stages) { saved.stage = stage; saved.stage_at = at; }
    list.push(saved);
  }
  await save(name, list);
  return { status: 200, item: saved, before: src.id ? beforeItem : null };
}

async function removeItem(name, id) {
  const list = await load(name);
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return { status: 404, errors: ["Карточка не найдена"] };
  await save(name, next);
  return { status: 200 };
}

// What the dashboard needs to draw forms and boards.
function publicSchema(name) {
  const s = SCHEMAS[name];
  return {
    name, title: s.title, item: s.item, perm: s.perm, due_field: s.due_field || null, done_from: s.done_from || null,
    stages: s.stages || null, stage_order: s.stages ? Object.keys(s.stages) : null, fields: s.fields
  };
}

module.exports = { SCHEMAS, FORMATS, METRICS, load, saveItem, removeItem, publicSchema, normalize };
