// Links the owner sets on the admin page (buttons across the app use them).
const store = require("./store");

const KEY = "settings:v1";
const FIELDS = {
  materials_url: "Бесплатные материалы (этап «Целостность»)",
  ritual_url: "Кнопка «Пройти ритуал в Telegram»",
  accept_video_url: "Ритуал «Я принимаю» на «Пути»: видео (ссылка VK или код «Экспортировать»)",
  friendship_url: "«Дни дружбы» → «Присоединиться» на «Пространстве»",
  abundance_video_1: "Изобильная реальность · видео 1 «Как получать подарки от пространства» (ссылка VK или код «Экспортировать»)",
  abundance_video_2: "Изобильная реальность · видео 2 «Как получать подарки от мужчин» (ссылка VK или код «Экспортировать»)",
  abundance_video_3: "Изобильная реальность · видео 3 «Как притягивать нужные ресурсы в любом объёме» (ссылка VK или код «Экспортировать»)",
  abundance_video_4: "Изобильная реальность · видео 4 «Нюансы создания желаемой реальности» (ссылка VK или код «Экспортировать»)",
  practice_video_url: "«Путь» → «Практика многомерности»: видео (ссылка VK или код «Экспортировать»)",
  mirror_video_url: "Видео о практике «Зеркало» (ссылка VK или код «Экспортировать»)",
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

const VIDEO_FIELDS = ["mirror_video_url", "accept_video_url", "practice_video_url", "abundance_video_1", "abundance_video_2", "abundance_video_3", "abundance_video_4"];
const VIDEO_HINT = "вставьте ссылку на видео VK (vkvideo.ru/video-123_456), код «Экспортировать» из VK целиком или ссылку Kinescope";

function normalizeSettings(input) {
  const errors = [];
  const settings = {};
  for (const [k, label] of Object.entries(FIELDS)) {
    const raw = String((input && input[k]) || "").trim();
    // Video fields also take the whole embed code; what is stored is the player address.
    if (VIDEO_FIELDS.includes(k)) {
      const embed = raw ? videoEmbed(raw) : "";
      if (raw && !embed) errors.push(`${label}: ${VIDEO_HINT}`);
      settings[k] = embed || "";
      continue;
    }
    const v = raw.slice(0, 500);
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

// Any video the team pastes → an embeddable player address:
// • VK: a link (vk.com/video-1_2, vkvideo.ru/video-1_2, clips), a video_ext.php address, or the whole
//   «Экспортировать» iframe code. Videos with access «по ссылке» need the code: it carries the hash.
// • Kinescope (no ads, private, domain lock): kinescope.io/<id> or kinescope.io/embed/<id>.
function videoEmbed(input) {
  let u = String(input || "").trim();
  if (!u) return null;
  const src = /src\s*=\s*["']([^"']+)["']/i.exec(u);
  if (src) u = src[1];
  u = u.replace(/&amp;/g, "&").trim();
  if (u.startsWith("//")) u = `https:${u}`;
  if (/^https:\/\/(vk\.com|vkvideo\.ru)\/video_ext\.php\?/.test(u)) return u.slice(0, 600);
  const kin = /^https:\/\/kinescope\.io\/(?:embed\/)?([\w-]{6,})/i.exec(u);
  if (kin) return `https://kinescope.io/embed/${kin[1]}`;
  const m = /(?:video|clip)(-?\d+)_(\d+)/.exec(u);
  if (!m || !/(vk\.com|vkvideo\.ru)/.test(u)) return null;
  const hash = /[?&]hash=([0-9a-f]+)/i.exec(u);
  return `https://vkvideo.ru/video_ext.php?oid=${m[1]}&id=${m[2]}&hd=2${hash ? `&hash=${hash[1]}` : ""}`;
}
const vkEmbed = videoEmbed;

module.exports = { vkEmbed, videoEmbed, VIDEO_FIELDS, TEXT_FIELDS, FIELDS, loadSettings, normalizeSettings, saveSettings };
