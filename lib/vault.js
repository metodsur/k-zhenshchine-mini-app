// «Доступы»: logins and passwords of the project's services (personal accounts, payments, hosting…).
// Passwords are encrypted (AES-256-GCM) before they reach storage and are never sent in the list:
// the dashboard asks for one password at a time, and every reveal is logged (who and when).
// Owner and director see every entry; other team members only entries where they are listed
// in «У кого доступ».
const crypto = require("crypto");
const store = require("./store");

const KEY = "os:vault";
const CATEGORIES = { social: "Соцсети", payments: "Платежи и банк", sites: "Сайт и хостинг", mail: "Почта", tools: "Сервисы и инструменты", other: "Другое" };
const clean = (v, max = 200) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

// The key lives only in the server environment (VAULT_KEY), never in storage.
// Without VAULT_KEY it is derived from the webhook secret, which is also server-only.
function key() {
  const base = process.env.VAULT_KEY || process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!base) throw new Error("Vault key is not configured");
  return crypto.createHash("sha256").update(`kz-vault:${base}`).digest();
}

function encrypt(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

function decrypt(box) {
  if (!box) return "";
  const [v, iv, tag, data] = String(box).split(":");
  if (v !== "v1") throw new Error("Unknown format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

async function loadAll() {
  const raw = await store.command("GET", KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
const saveAll = (list) => store.command("SET", KEY, JSON.stringify(list));

const seesAll = (member) => require("./team").can(member, "vault.all");
const lower = (v) => clean(v).toLowerCase();
function visibleTo(entry, member) {
  if (seesAll(member)) return true;
  const me = lower(member.name);
  return Boolean(me) && (entry.access || []).some((n) => lower(n) === me);
}

// What the dashboard shows in the list: everything except the password itself.
function view(e) {
  return {
    id: e.id, title: e.title, url: e.url, login: e.login, category: e.category, access: e.access || [], notes: e.notes,
    has_password: Boolean(e.password), updated_at: e.updated_at, updated_by: e.updated_by,
    last_view: (e.views || []).slice(-1)[0] || null
  };
}

async function list(member) {
  return (await loadAll()).filter((e) => visibleTo(e, member)).sort((a, b) => a.title.localeCompare(b.title, "ru")).map(view);
}

async function save(input, member) {
  const src = input && typeof input === "object" ? input : {};
  const title = clean(src.title, 120);
  if (!title) return { status: 400, errors: ["Укажите название сервиса"] };
  let url = clean(src.url, 500);
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  const entry = {
    title, url, login: clean(src.login, 200), notes: String(src.notes == null ? "" : src.notes).trim().slice(0, 2000),
    category: CATEGORIES[src.category] ? src.category : "other",
    access: [...new Set((Array.isArray(src.access) ? src.access : String(src.access || "").split(",")).map((n) => clean(n, 80)).filter(Boolean))].slice(0, 30)
  };
  const by = member.name || member.role_label;
  // Someone who sees only her own entries keeps access to what she adds.
  if (!seesAll(member) && member.name && !entry.access.some((n) => lower(n) === lower(member.name))) entry.access.push(member.name);
  const all = await loadAll();
  const at = new Date().toISOString();
  if (src.id) {
    const i = all.findIndex((e) => e.id === src.id);
    if (i === -1 || !visibleTo(all[i], member)) return { status: 404, errors: ["Запись не найдена"] };
    // An empty password field means "keep the current one".
    const password = typeof src.password === "string" && src.password !== "" ? encrypt(src.password.slice(0, 500)) : all[i].password;
    all[i] = { ...all[i], ...entry, password, updated_at: at, updated_by: by };
    await saveAll(all);
    return { status: 200, entry: view(all[i]) };
  }
  const created = { id: crypto.randomBytes(5).toString("hex"), ...entry, password: encrypt(String(src.password || "").slice(0, 500)), created_at: at, updated_at: at, updated_by: by, views: [] };
  all.push(created);
  await saveAll(all);
  return { status: 200, entry: view(created) };
}

async function reveal(id, member) {
  const all = await loadAll();
  const e = all.find((x) => x.id === id);
  if (!e || !visibleTo(e, member)) return { status: 404, errors: ["Запись не найдена"] };
  let password = "";
  try { password = decrypt(e.password); } catch { return { status: 500, errors: ["Пароль не удалось расшифровать — введите его заново"] }; }
  e.views = [...(e.views || []), { at: new Date().toISOString(), by: member.name || member.role_label }].slice(-30);
  await saveAll(all);
  return { status: 200, password };
}

async function remove(id, member) {
  if (!seesAll(member)) return { status: 403, errors: ["Удалять доступы может владелец или операционный директор"] };
  const all = await loadAll();
  const e = all.find((x) => x.id === id);
  if (!e || !visibleTo(e, member)) return { status: 404, errors: ["Запись не найдена"] };
  await saveAll(all.filter((x) => x.id !== id));
  return { status: 200 };
}

module.exports = { CATEGORIES, list, save, reveal, remove, encrypt, decrypt };
