// Links the owner sets on the admin page (buttons across the app use them).
const store = require("./store");

const KEY = "settings:v1";
const FIELDS = {
  materials_url: "Бесплатные материалы (этап «Целостность»)",
  ritual_url: "Кнопка «Пройти ритуал в Telegram»",
  accept_url: "Ритуал «Я принимаю» на «Пути» (бесплатные материалы)",
  friendship_url: "«Дни дружбы» → «Присоединиться» на «Пространстве»",
  abundance_url: "«Как создавать изобильную реальность» → «Посмотреть сейчас»",
  privacy_url: "Своя Политика обработки персональных данных (если пусто — страница в приложении)"
};
// Operator details shown in the in-app privacy policy (152-FZ requires them).
const TEXT_FIELDS = {
  operator_name: "Оператор данных: ИП или организация (как в документах)",
  operator_inn: "ИНН / ОГРН(ИП)",
  operator_address: "Адрес оператора",
  operator_email: "Email для обращений и отзыва согласия"
};

async function loadSettings() {
  const raw = await store.command("GET", KEY);
  let saved = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch { saved = {}; }
  return Object.fromEntries([...Object.keys(FIELDS), ...Object.keys(TEXT_FIELDS)].map((k) => [k, saved[k] || ""]));
}

function normalizeSettings(input) {
  const errors = [];
  const settings = {};
  for (const [k, label] of Object.entries(FIELDS)) {
    const v = String((input && input[k]) || "").trim().slice(0, 500);
    if (v && !/^https:\/\/\S+$/.test(v)) errors.push(`${label}: ссылка должна начинаться с https://`);
    settings[k] = v;
  }
  for (const k of Object.keys(TEXT_FIELDS)) settings[k] = String((input && input[k]) || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return { errors, settings };
}

async function saveSettings(settings) {
  await store.command("SET", KEY, JSON.stringify(settings));
  return settings;
}

module.exports = { TEXT_FIELDS, FIELDS, loadSettings, normalizeSettings, saveSettings };
