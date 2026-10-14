// «База данных» in the team dashboard: files of any kind (photos, videos, documents) plus links
// and texts, each with a description and a folder. Files are kept in Telegram (file_id), the same
// way as task attachments: up to 3 MB straight from the dashboard, bigger ones sent to the bot.
const crypto = require("crypto");
const store = require("./store");
const team = require("./team");
const conversations = require("./conversations");
const { telegram, telegramUpload } = require("./telegram");
const { fileFromMessage, kindOfMime, normalizeUrl, MAX_UPLOAD_BYTES } = require("./tasks");

const KEY = "os:db";
const MAX_ITEMS = 1000;
const KINDS = { photo: "Фото", video: "Видео", file: "Файл", link: "Ссылка", text: "Текст", note: "Запись" };
const clean = (v, max = 200) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const msgKey = (chatId, messageId) => `dbmsg:${chatId}:${messageId}`;

async function load() {
  const raw = await store.command("GET", KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function save(list) { await store.command("SET", KEY, JSON.stringify(list)); return list; }

// What the item holds: its file decides, then a link, then a text.
function kindOf(item) {
  if (item.file_id) return item.send === "photo" ? "photo" : ["video", "animation", "video_note"].includes(item.send) ? "video" : kindOfMime(item.mime);
  if (item.url) return "link";
  if (item.text) return "text";
  return "note";
}
const withKind = (item) => ({ ...item, kind: kindOf(item) });
const canRemove = (member, item) => team.can(member, "tasks.review") || String(item.by_id || "") === String(member.id);

async function list() { return (await load()).map(withKind); }

// Title, description, folder, link and text; the file is set separately (upload or the bot).
async function saveItem(input, actor) {
  const s = input && typeof input === "object" ? input : {};
  const fields = {
    title: clean(s.title, 200),
    description: String(s.description == null ? "" : s.description).trim().slice(0, 5000),
    folder: clean(s.folder, 80),
    text: String(s.text == null ? "" : s.text).trim().slice(0, 20000)
  };
  const rawUrl = String(s.url == null ? "" : s.url).trim();
  fields.url = rawUrl ? normalizeUrl(rawUrl) : "";
  if (rawUrl && !fields.url) return { status: 400, errors: ["Проверьте ссылку — например, https://disk.yandex.ru/…"] };
  const items = await load();
  let item = s.id ? items.find((x) => x.id === s.id) : null;
  if (s.id && !item) return { status: 404, errors: ["Запись не найдена"] };
  if (!fields.title) fields.title = item ? item.title : clean(s.name, 200);
  if (!fields.title) return { status: 400, errors: ["Напишите название"] };
  if (item) Object.assign(item, fields, { updated_at: nowIso(), updated_by: actor.name });
  else {
    if (items.length >= MAX_ITEMS) return { status: 400, errors: [`В базе уже ${MAX_ITEMS} записей — удалите ненужные`] };
    item = { id: crypto.randomBytes(5).toString("hex"), ...fields, by: actor.name, by_id: String(actor.id), at: nowIso(), updated_at: nowIso(), updated_by: actor.name };
    items.unshift(item);
  }
  await save(items);
  return { status: 200, item: withKind(item) };
}

async function setFile(id, file, actor) {
  const items = await load();
  const item = items.find((x) => x.id === id);
  if (!item) return { status: 404, errors: ["Запись не найдена"] };
  Object.assign(item, {
    file_id: String(file.file_id).slice(0, 300),
    send: ["photo", "video", "animation", "video_note", "document"].includes(file.send) ? file.send : "document",
    mime: clean(file.mime, 100), name: clean(file.name, 200), size: Number(file.size) || 0,
    updated_at: nowIso(), updated_by: actor.name
  });
  await save(items);
  return { status: 200, item: withKind(item) };
}

// A file from the dashboard (base64), with the item's fields: creates the item or replaces its file.
// Stored in Telegram through the uploader's chat with the bot.
async function upload(input, file, actor) {
  const f = file && typeof file === "object" ? file : {};
  const buffer = Buffer.from(String(f.data || "").replace(/^data:[^,]*,/, ""), "base64");
  if (!buffer.length) return { status: 400, errors: ["Файл пустой"] };
  if (buffer.length > MAX_UPLOAD_BYTES) return { status: 400, errors: ["Файл больше 3 МБ. Сохраните запись и нажмите «Прислать через бот» — бот попросит файл."] };
  const mime = clean(f.mime, 100) || "application/octet-stream";
  const name = clean(f.name, 200) || "файл";
  const saved = await saveItem({ ...(input || {}), name }, actor);
  if (saved.status !== 200) return saved;
  let sent;
  try {
    sent = await telegramUpload("sendDocument", { chat_id: actor.id, caption: `🗂 База данных: «${saved.item.title}»`.slice(0, 1000), disable_content_type_detection: true }, "document", buffer, name, mime);
  } catch { return { status: 400, errors: ["Не получилось сохранить файл. Откройте бота, нажмите «Старт» и попробуйте ещё раз."], item: saved.item }; }
  const got = fileFromMessage(sent);
  if (!got) return { status: 400, errors: ["Не получилось сохранить файл"], item: saved.item };
  if (sent.message_id) { try { await store.command("SET", msgKey(actor.id, sent.message_id), saved.item.id, "EX", 60 * 86400); } catch { /* replies just won't map */ } }
  return setFile(saved.item.id, { file_id: got.file_id, send: got.send, mime, name, size: buffer.length }, actor);
}

// Big files: the bot asks for the file; a reply to that message (or the next file sent) lands in the item.
async function requestViaBot(id, actor) {
  const item = (await load()).find((x) => x.id === id);
  if (!item) return { status: 404, errors: ["Запись не найдена"] };
  let sent;
  try {
    sent = await telegram("sendMessage", { chat_id: actor.id, text: `🗂 База данных: «${item.title}»\n\nПришлите сюда файл (фото, видео, документ) ответом на это сообщение — он сохранится в записи и появится в кабинете.` });
  } catch { return { status: 400, errors: ["Бот не смог написать вам. Откройте бота, нажмите «Старт» и попробуйте ещё раз."] }; }
  if (sent && sent.message_id) await store.command("SET", msgKey(actor.id, sent.message_id), item.id, "EX", 7 * 86400);
  await conversations.open(actor.id, "db_file", { item_id: item.id }, 3600);
  return { status: 200, item: withKind(item) };
}

async function removeItem(id, member) {
  const items = await load();
  const item = items.find((x) => x.id === id);
  if (!item) return { status: 404, errors: ["Запись не найдена"] };
  if (!canRemove(member, item)) return { status: 403, errors: ["Удалить может автор записи, владелица или директор"] };
  await save(items.filter((x) => x.id !== id));
  return { status: 200 };
}

async function find(id) {
  const item = (await load()).find((x) => x.id === id && x.file_id);
  return item ? withKind(item) : null;
}

// A photo, video or document sent to the bot as a reply to the «Пришлите файл» message
// (or right after pressing «Прислать через бот») → the item's file.
async function handleMedia(message) {
  if (!message || !message.chat || message.chat.type !== "private" || !message.from || typeof message.text === "string") return false;
  const file = fileFromMessage(message);
  if (!file) return false;
  let itemId = null;
  const reply = message.reply_to_message;
  if (reply && reply.message_id) itemId = await store.command("GET", msgKey(message.chat.id, reply.message_id));
  let state = null;
  if (!itemId) { state = await conversations.get(message.from.id); if (state && state.topic === "db_file") itemId = state.item_id; }
  if (!itemId) return false;
  const member = await team.getMember(message.from.id);
  if (!member || !team.can(member, "os.workspace")) return false;
  if (state) await conversations.close(message.from.id);
  const r = await setFile(itemId, file, { name: member.name || member.role_label, id: member.id });
  await telegram("sendMessage", { chat_id: message.chat.id, text: r.status === 200 ? `🗂 Файл сохранён в базе данных: «${r.item.title}». Уже видно в кабинете.` : r.errors[0] });
  return true;
}

module.exports = { KINDS, list, saveItem, upload, requestViaBot, removeItem, find, handleMedia, canRemove };
