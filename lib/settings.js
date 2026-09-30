// Links the owner sets on the admin page (buttons across the app use them).
const store = require("./store");

const KEY = "settings:v1";
const FIELDS = {
  materials_url: "Бесплатные материалы (этап «Целостность»)",
  ritual_url: "Кнопка «Пройти ритуал в Telegram»"
};

async function loadSettings() {
  const raw = await store.command("GET", KEY);
  let saved = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch { saved = {}; }
  return Object.fromEntries(Object.keys(FIELDS).map((k) => [k, saved[k] || ""]));
}

function normalizeSettings(input) {
  const errors = [];
  const settings = {};
  for (const [k, label] of Object.entries(FIELDS)) {
    const v = String((input && input[k]) || "").trim().slice(0, 500);
    if (v && !/^https:\/\/\S+$/.test(v)) errors.push(`${label}: ссылка должна начинаться с https://`);
    settings[k] = v;
  }
  return { errors, settings };
}

async function saveSettings(settings) {
  await store.command("SET", KEY, JSON.stringify(settings));
  return settings;
}

module.exports = { FIELDS, loadSettings, normalizeSettings, saveSettings };
