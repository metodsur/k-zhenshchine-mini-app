// Links the owner sets on the admin page (buttons across the app use them).
const store = require("./store");

const KEY = "settings:v1";
const FIELDS = {
  materials_url: "Бесплатные материалы (этап «Целостность»)",
  ritual_url: "Кнопка «Пройти ритуал в Telegram»",
  accept_url: "Ритуал «Я принимаю» на «Пути» (бесплатные материалы)",
  friendship_url: "«Дни дружбы» → «Присоединиться» на «Пространстве»",
  abundance_url: "«Как создавать изобильную реальность» → «Посмотреть сейчас»",
  mirror_video_url: "Видео о практике «Зеркало» (ссылка на VK Видео)",
  master_contract_url: "Договор с Мастерами (ссылка на файл: Яндекс Диск, Google Drive)",
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
  if (settings.mirror_video_url && !vkEmbed(settings.mirror_video_url)) errors.push(`${FIELDS.mirror_video_url}: нужна ссылка на видео вида vkvideo.ru/video-123_456`);
  for (const k of Object.keys(TEXT_FIELDS)) settings[k] = String((input && input[k]) || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return { errors, settings };
}

async function saveSettings(settings) {
  await store.command("SET", KEY, JSON.stringify(settings));
  return settings;
}

// A VK Video link (vk.com/video-1_2, vkvideo.ru/video-1_2, clip links, or a ready embed) → embeddable player URL.
function vkEmbed(url) {
  const u = String(url || "").trim();
  if (!u) return null;
  if (/^https:\/\/(vk\.com|vkvideo\.ru)\/video_ext\.php\?/.test(u)) return u;
  const m = /(?:video|clip)(-?\d+)_(\d+)/.exec(u);
  return m ? `https://vkvideo.ru/video_ext.php?oid=${m[1]}&id=${m[2]}&hd=2` : null;
}

module.exports = { vkEmbed, TEXT_FIELDS, FIELDS, loadSettings, normalizeSettings, saveSettings };
