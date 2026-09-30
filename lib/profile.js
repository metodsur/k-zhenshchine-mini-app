// A member's own page data ("Как я вижу себя", грани, ресурсы), stored on the server so it
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
    resources: Array.isArray(saved.resources) ? saved.resources : []
  };
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
  await store.command("SET", key(userId), JSON.stringify(next));
  return next;
}

module.exports = { loadProfile, saveProfile, DEFAULT_FACETS };
