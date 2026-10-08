// A member's own page data ("Как я вижу себя", грани, ресурсы, свои ресурсы, мои задачи), stored on the server so it
// follows her to any device.
const store = require("./store");

const key = (userId) => `profile:${userId}`;
const DEFAULT_FACETS = ["Женщина", "Мама", "Предприниматель", "Творец", "Путешественница", "Партнёр", "Исследователь"];
const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

async function loadProfile(userId) {
  const raw = await store.command("GET", key(userId));
  let saved = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch { saved = {}; }
  return {
    vision: saved.vision || "",
    vision_updated_at: saved.vision_updated_at || null,
    facets: Array.isArray(saved.facets) ? saved.facets : DEFAULT_FACETS,
    resources: Array.isArray(saved.resources) ? saved.resources : [],
    custom_resources: Array.isArray(saved.custom_resources) ? saved.custom_resources : [],
    tasks: Array.isArray(saved.tasks) ? saved.tasks : []
  };
}

// "Мои задачи": her own to-do list. Up to 60 items; text, done flag and dates only.
function cleanTasks(list) {
  const seen = new Set();
  const now = new Date().toISOString();
  const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
  return list.map((t) => {
    const text = clean(t && t.text, 200);
    let id = clean(t && t.id, 16).replace(/[^\w-]/g, "");
    if (!text) return null;
    if (!id || seen.has(id)) id = Math.random().toString(36).slice(2, 10);
    seen.add(id);
    const done = Boolean(t.done);
    return { id, text, done, created_at: isIso(t.created_at) ? t.created_at : now, done_at: done ? (isIso(t.done_at) ? t.done_at : now) : null };
  }).filter(Boolean).slice(0, 60);
}

async function saveProfile(userId, input) {
  const current = await loadProfile(userId);
  const next = { ...current };
  if (typeof input.vision === "string") {
    const vision = String(input.vision).trim().slice(0, 1200);
    if (vision !== current.vision) { next.vision = vision; next.vision_updated_at = new Date().toISOString(); }
  }
  if (Array.isArray(input.facets)) next.facets = [...new Set(input.facets.map((f) => clean(f, 40)).filter(Boolean))].slice(0, 20);
  if (Array.isArray(input.resources)) next.resources = [...new Set(input.resources.map((r) => clean(r, 40)).filter(Boolean))].slice(0, 30);
  if (Array.isArray(input.custom_resources)) next.custom_resources = [...new Set(input.custom_resources.map((r) => clean(r, 40)).filter(Boolean))].slice(0, 30);
  if (Array.isArray(input.tasks)) next.tasks = cleanTasks(input.tasks);
  await store.command("SET", key(userId), JSON.stringify(next));
  return next;
}

module.exports = { loadProfile, saveProfile, DEFAULT_FACETS };
