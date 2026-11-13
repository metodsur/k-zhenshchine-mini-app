// Issue #5: opt-in workflow bridge. The existing Mini App remains the only bot-token owner.
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const store = require("./store");
const { telegram, safeEqualString } = require("./telegram");
const { isAdmin } = require("./http");

const CLOUD_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const LOCAL_DOWNLOAD_LIMIT = 6 * 1024 * 1024 * 1024;
const RECEIPT_TTL = 30 * 86400;
const PROMPT_TTL = 7 * 86400;
const BOT_USERNAME = "k_zhenshcine_bot";
const IDENTITY_TTL = 5 * 60 * 1000;
const identityCache = new Map(); // SHA-256 keys only; never retain token-bearing cache keys.
const VIDEO_MIMES = { mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm" };
const METHODS = {
  sendMessage: ["chat_id", "text", "parse_mode", "reply_markup", "disable_web_page_preview", "disable_notification", "protect_content"],
  sendVideo: ["chat_id", "video", "caption", "parse_mode", "reply_markup", "supports_streaming", "duration", "width", "height", "disable_notification", "protect_content"],
  sendDocument: ["chat_id", "document", "caption", "parse_mode", "reply_markup", "disable_content_type_detection", "disable_notification", "protect_content"],
  answerCallbackQuery: ["callback_query_id", "text", "show_alert", "cache_time"],
  getFile: ["file_id", "chat_id"],
  getMe: [],
  getWebhookInfo: []
};
const id = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";
const privateId = (value) => /^[1-9]\d{0,15}$/.test(id(value));
const fileId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const modeKey = (userId) => `cf:bridge:mode:${userId}`;
const promptKey = (chatId, messageId) => `cf:bridge:prompt:${chatId}:${messageId}`;
const receiptKey = (chatId, value) => `cf:bridge:file:${chatId}:${hash(value)}`;
const callbackKey = (value) => `cf:bridge:callback:${hash(value)}`;
function failure(status, code, message = code) {
  return Object.assign(new Error(message), { status, code });
}
function enabled() { return process.env.CF_BRIDGE_ENABLED === "1"; }
function authorized(userId, chatId = userId) {
  const user = id(userId);
  const allowed = String(process.env.CF_ALLOWED_TELEGRAM_IDS || "").split(/[\s,;]+/).filter(Boolean);
  return privateId(user) && id(chatId) === user && isAdmin({ id: user }) && allowed.includes(user);
}
function factoryBase() {
  try {
    const url = new URL(process.env.CONTENT_FACTORY_URL || "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, "");
  } catch { throw failure(503, "BRIDGE_NOT_CONFIGURED"); }
}
function strongSecret() {
  return typeof process.env.CF_BRIDGE_SECRET === "string" && process.env.CF_BRIDGE_SECRET.length >= 32;
}
function configured() {
  factoryBase();
  if (!strongSecret() || !store.isConfigured()) throw failure(503, "BRIDGE_NOT_CONFIGURED");
}
function authenticated(req) {
  const secret = req.headers?.["x-cf-bridge-secret"];
  return strongSecret() && typeof secret === "string" && safeEqualString(secret, process.env.CF_BRIDGE_SECRET);
}
function localApiBase() {
  if (!process.env.CF_TELEGRAM_API_BASE) return null;
  try {
    const url = new URL(process.env.CF_TELEGRAM_API_BASE);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, "");
  } catch { throw failure(503, "BRIDGE_NOT_CONFIGURED"); }
}
function localFilesEnabled() { return Boolean(localApiBase() && process.env.CF_TELEGRAM_FILE_ROOT); }
async function botCall(method, payload) {
  const base = localApiBase();
  if (!base && method !== "getFile") return telegram(method, payload);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw failure(503, "BRIDGE_NOT_CONFIGURED");
  // Only an administrator-configured, ALREADY existing Bot API is used; nothing is deployed here.
  const response = await fetch(`${base || "https://api.telegram.org"}/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    redirect: "error", signal: AbortSignal.timeout(30000)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    if (method === "getFile" && /file is too big/i.test(String(data.description || ""))) throw failure(413, "LARGE_FILE");
    throw failure(502, "TELEGRAM_GATEWAY_FAILED");
  }
  return data.result;
}
async function verifyBotIdentity() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw failure(503, "BRIDGE_NOT_CONFIGURED");
  const key = hash(JSON.stringify([token, localApiBase() || "https://api.telegram.org"]));
  let cached = identityCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    // A failed read never authorizes a bridge operation or falls back to a stale result.
    let actual;
    try { actual = await botCall("getMe", {}); }
    catch { throw failure(502, "TELEGRAM_GATEWAY_FAILED"); }
    cached = { matches: actual?.is_bot === true && typeof actual.username === "string"
      && actual.username.toLowerCase() === BOT_USERNAME, expiresAt: Date.now() + IDENTITY_TTL };
    for (const [digest, value] of identityCache) if (value.expiresAt <= Date.now()) identityCache.delete(digest);
    identityCache.set(key, cached);
  }
  if (!cached.matches) throw failure(503, "BOT_IDENTITY_MISMATCH");
}
async function save(key, value, ttl) {
  if (!store.isConfigured() || await store.command("SET", key, JSON.stringify(value), "EX", ttl) !== "OK") {
    throw failure(503, "BRIDGE_STORAGE_UNAVAILABLE");
  }
}
async function load(key) {
  const raw = await store.command("GET", key);
  try { return typeof raw === "string" ? JSON.parse(raw) : null; } catch { return null; }
}
async function forward(envelope) {
  configured();
  await verifyBotIdentity();
  let response;
  try {
    response = await fetch(`${factoryBase()}/api/workflow/telegram`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-cf-bridge-secret": process.env.CF_BRIDGE_SECRET },
      body: JSON.stringify(envelope), redirect: "error", signal: AbortSignal.timeout(30000)
    });
    const result = await response.json();
    if (!response.ok || result?.ok === false) throw new Error();
    return result;
  } catch { throw failure(503, "FACTORY_UNAVAILABLE"); }
}
function mediaInput(update) {
  const message = update?.message;
  if (!message || !Number.isSafeInteger(update.update_id) || update.update_id < 0
      || !Number.isSafeInteger(message.message_id) || message.message_id < 1) return null;
  const native = message.video || message.video_note || message.animation;
  const media = native || message.document;
  if (!media || !fileId(media.file_id) || !fileId(media.file_unique_id)) return null;
  let mime = String(media.mime_type || "").toLowerCase();
  const name = typeof media.file_name === "string" ? media.file_name.slice(0, 255) : "";
  const ext = name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (ext && !Object.hasOwn(VIDEO_MIMES, ext)) return null;
  if (native) {
    mime = mime || "video/mp4";
  } else if (!Object.values(VIDEO_MIMES).includes(mime)) {
    // Some clients send videos as generic documents; never trust an extension over a conflicting MIME.
    if (mime && mime !== "application/octet-stream") return null;
    if (!ext) return null;
    mime = VIDEO_MIMES[ext];
  }
  if (!Object.values(VIDEO_MIMES).includes(mime)) return null;
  const size = media.file_size ?? 0;
  if (!Number.isSafeInteger(size) || size < 0) return null;
  const input = {
    updateId: update.update_id, userId: id(message.from?.id), chatId: id(message.chat?.id),
    messageId: message.message_id, fileId: media.file_id, fileUniqueId: media.file_unique_id,
    fileName: name || `${media.file_unique_id}.${Object.keys(VIDEO_MIMES).find((key) => VIDEO_MIMES[key] === mime)}`, fileSize: size, mime
  };
  if (typeof message.media_group_id === "string") input.mediaGroupId = message.media_group_id;
  return input;
}
async function existingIntake(message) {
  // Fail closed even if an earlier legacy handler failed; never appropriate its pending state/reply.
  if (await store.command("GET", `conv:${message.from.id}`)) return true;
  const reply = message.reply_to_message?.message_id;
  if (!reply) return false;
  return Boolean(await store.command("GET", `tmsg:${message.chat.id}:${reply}`)
    || await store.command("GET", `dbmsg:${message.chat.id}:${reply}`));
}
async function handleUpdate(update) {
  if (!enabled()) return false;
  const query = update?.callback_query;
  if (typeof query?.data === "string" && query.data.startsWith("cf:")) {
    await verifyBotIdentity();
    const userId = id(query.from?.id);
    const chatId = id(query.message?.chat?.id);
    if (query.message?.chat?.type !== "private" || !authorized(userId, chatId)) {
      if (typeof query.id === "string") await botCall("answerCallbackQuery", { callback_query_id: query.id, text: "Нет доступа к фабрике контента." });
      return true;
    }
    configured();
    if (!/^cf:[a-f0-9]{32}:\d+:(publish|schedule|revise|skip|status)$/.test(query.data)
        || Buffer.byteLength(query.data) > 64 || typeof query.id !== "string" || !query.id || query.id.length > 512) {
      if (typeof query.id === "string") await botCall("answerCallbackQuery", { callback_query_id: query.id, text: "Некорректная кнопка." });
      return true;
    }
    await save(callbackKey(query.id), { userId, chatId }, 600);
    await forward({ kind: "callback", userId, chatId, id: query.id, data: query.data, messageId: query.message.message_id });
    return true;
  }
  const message = update?.message;
  if (message?.chat?.type !== "private" || !authorized(message.from?.id, message.chat.id)) return false;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const command = /^\/(reels|reels_off)(@\w+)?\s*$/.exec(text);
  if (command) {
    configured();
    await verifyBotIdentity();
    if (command[1] === "reels") await save(modeKey(message.from.id), true, RECEIPT_TTL);
    else await store.command("DEL", modeKey(message.from.id));
    await botCall("sendMessage", { chat_id: message.chat.id, text: command[1] === "reels"
      ? "Приём видео для фабрики контента включён на 30 дней. Пришлите видео или видеофайл. Задачи и база данных работают как раньше. Отключить: /reels_off."
      : "Приём новых видео для фабрики контента отключён. Кнопки и ответы на уже созданные задания продолжат работать." });
    return true;
  }
  if (text.startsWith("/")) return false;
  // Gateway ForceReply receipts, not arbitrary text or bot-message replies, authorize workflow text.
  if (text && Number.isSafeInteger(message.reply_to_message?.message_id)) {
    if (await existingIntake(message)) return false;
    const replyTo = message.reply_to_message.message_id;
    const prompt = await load(promptKey(message.chat.id, replyTo));
    if (!prompt || prompt.userId !== id(message.from.id)) return false;
    await forward({ kind: "text", userId: id(message.from.id), chatId: id(message.chat.id), text: message.text, replyTo });
    // Keep the receipt: a rejected ISO time can be corrected, and factory dedupes/pending state owns acceptance.
    return true;
  }
  const input = mediaInput(update);
  if (!input) return false;
  if (await existingIntake(message) || await load(modeKey(input.userId)) !== true) return false;
  configured();
  await verifyBotIdentity();
  await save(receiptKey(input.chatId, input.fileId), { userId: input.userId, chatId: input.chatId, input }, RECEIPT_TTL);
  await forward({ kind: "media", input });
  return true;
}
function signedFileUrl(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\\\s]/.test(value)) return false;
  try {
    const base = new URL(factoryBase());
    const url = new URL(value);
    const prefix = `${base.pathname.replace(/\/$/, "")}/api/public/`;
    const tail = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    return url.protocol === "https:" && url.origin === base.origin && !url.username && !url.password && !url.hash
      && /^\d+\/[^/]+$/.test(tail) && !/%2f|%5c|%00/i.test(tail)
      && Number.isSafeInteger(Number(url.searchParams.get("exp"))) && Number(url.searchParams.get("exp")) > Math.floor(Date.now() / 1000)
      && /^[a-f0-9]{64}$/i.test(url.searchParams.get("sig") || "")
      && [...url.searchParams.keys()].every((key) => key === "exp" || key === "sig")
      && url.searchParams.getAll("exp").length === 1 && url.searchParams.getAll("sig").length === 1;
  } catch { return false; }
}
async function receipt(chatId, value) {
  if (!authorized(chatId) || !fileId(value)) throw failure(403, "FILE_NOT_AUTHORIZED");
  const saved = await load(receiptKey(id(chatId), value));
  if (!saved || saved.userId !== id(chatId) || saved.chatId !== id(chatId) || saved.input?.fileId !== value) {
    throw failure(403, "FILE_NOT_AUTHORIZED");
  }
  const limit = localFilesEnabled() ? LOCAL_DOWNLOAD_LIMIT : CLOUD_DOWNLOAD_LIMIT;
  if (saved.input.fileSize > limit) throw failure(413, "LARGE_FILE",
    "File exceeds the configured gateway limit (cloud: 20 MiB; existing local Bot API: 6 GiB). Offer the authenticated factory direct-upload link; do not retry this file through Telegram.");
  return saved;
}
function safeFilePath(value) {
  return typeof value === "string" && value.length <= 1024 && /^[A-Za-z0-9_./-]+$/.test(value)
    && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== "..");
}
async function localFile(value) {
  if (!localFilesEnabled() || typeof value !== "string" || !path.isAbsolute(value)) throw failure(502, "INVALID_TELEGRAM_FILE_PATH");
  let root, real, stat;
  try {
    if (!path.isAbsolute(process.env.CF_TELEGRAM_FILE_ROOT)) throw new Error();
    root = await fsp.realpath(process.env.CF_TELEGRAM_FILE_ROOT);
    real = await fsp.realpath(value);
    const relative = path.relative(root, real);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error();
    stat = await fsp.stat(real);
    if (!stat.isFile()) throw new Error();
  } catch { throw failure(403, "LOCAL_FILE_NOT_AUTHORIZED"); }
  if (stat.size > LOCAL_DOWNLOAD_LIMIT) throw failure(413, "LARGE_FILE", "Local gateway cap is 6 GiB. Offer the authenticated factory direct-upload link.");
  return { root, real, size: stat.size };
}
async function fileMetadata(chatId, value) {
  const saved = await receipt(chatId, value);
  let result;
  try { result = await botCall("getFile", { file_id: value }); }
  catch (error) {
    if (error.code === "LARGE_FILE") throw failure(413, "LARGE_FILE", "Offer the authenticated factory direct-upload link; cloud downloads are limited to 20 MiB.");
    throw failure(502, "TELEGRAM_FILE_UNAVAILABLE", "Telegram could not provide this file (cloud download limit: 20 MiB). Offer the authenticated factory direct-upload link.");
  }
  if (typeof result?.file_path === "string" && path.isAbsolute(result.file_path)) {
    const local = await localFile(result.file_path);
    // Local Bot API paths can contain the bot token as a directory: export only an opaque marker.
    return { saved, local, result: { file_id: value, file_unique_id: saved.input.fileUniqueId, file_size: local.size, file_path: `local/${hash(value)}` } };
  }
  if (!safeFilePath(result?.file_path)) throw failure(502, "INVALID_TELEGRAM_FILE_PATH");
  if (Number(result.file_size) > CLOUD_DOWNLOAD_LIMIT || saved.input.fileSize > CLOUD_DOWNLOAD_LIMIT) throw failure(413, "LARGE_FILE", "Use the authenticated factory direct-upload link for files above 20 MiB when no local absolute file is available.");
  return { saved, result: {
    file_id: value, file_unique_id: saved.input.fileUniqueId,
    file_size: Number.isSafeInteger(result.file_size) && result.file_size >= 0 ? result.file_size : saved.input.fileSize,
    file_path: result.file_path
  } };
}
async function gateway(method, payload) {
  configured();
  if (typeof method !== "string" || !Object.hasOwn(METHODS, method) || !payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).some((key) => !METHODS[method].includes(key))) throw failure(400, "INVALID_OPERATION");
  if (method !== "getMe") await verifyBotIdentity();
  if (method === "getFile") return (await fileMetadata(payload.chat_id, payload.file_id)).result;
  if (method.startsWith("send")) {
    if (!authorized(payload.chat_id)) throw failure(403, "CHAT_NOT_AUTHORIZED");
    if (method === "sendMessage" && (typeof payload.text !== "string" || !payload.text || payload.text.length > 4096)) throw failure(400, "INVALID_TEXT");
    if (method !== "sendMessage" && !signedFileUrl(payload[method === "sendVideo" ? "video" : "document"])) throw failure(400, "SIGNED_FACTORY_FILE_REQUIRED");
  }
  if (method === "answerCallbackQuery") {
    if (typeof payload.callback_query_id !== "string" || !payload.callback_query_id || payload.callback_query_id.length > 512) throw failure(400, "INVALID_CALLBACK");
    const saved = await load(callbackKey(payload.callback_query_id));
    if (!saved || !authorized(saved.userId, saved.chatId)) throw failure(403, "CALLBACK_NOT_AUTHORIZED");
  }
  const result = await botCall(method, payload);
  if (method === "sendMessage" && payload.reply_markup?.force_reply === true) {
    if (!Number.isSafeInteger(result?.message_id) || result.message_id < 1) throw failure(502, "INVALID_PROMPT_RESPONSE");
    await save(promptKey(id(payload.chat_id), result.message_id), { userId: id(payload.chat_id) }, PROMPT_TTL);
  }
  if (method === "getMe") {
    // Identity comes from a live read-only diagnostic, never a hardcoded bot claim.
    return Object.fromEntries(["id", "is_bot", "first_name", "username", "can_join_groups", "can_read_all_group_messages", "supports_inline_queries", "has_main_web_app"].filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
  }
  if (method === "getWebhookInfo") {
    // Do not export webhook URLs, IPs or Telegram error text that could contain credentials.
    return Object.fromEntries(["has_custom_certificate", "pending_update_count", "max_connections", "allowed_updates", "last_error_date"].filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
  }
  return result;
}
async function download(req, res) {
  configured();
  await verifyBotIdentity();
  const { file_id: value, chat_id: chatId } = req.query || {};
  const { saved, result, local } = await fileMetadata(chatId, value);
  if (local) {
    let handle;
    try {
      // realpath containment rejects traversal/symlink escape; O_NOFOLLOW also rejects final-component races.
      handle = await fsp.open(local.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      // Linux FD canonicalization checks the opened inode too, closing ancestor-symlink race windows.
      const openedPath = await fsp.realpath(`/proc/self/fd/${handle.fd}`);
      const relative = path.relative(local.root, openedPath);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure(403, "LOCAL_FILE_NOT_AUTHORIZED");
      const stat = await handle.stat();
      if (!stat.isFile()) throw failure(403, "LOCAL_FILE_NOT_AUTHORIZED");
      if (stat.size > LOCAL_DOWNLOAD_LIMIT) throw failure(413, "LARGE_FILE", "Local gateway cap is 6 GiB. Offer the authenticated factory direct-upload link.");
      res.statusCode = 200;
      res.setHeader("Content-Type", saved.input.mime);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Length", stat.size);
      await pipeline(handle.createReadStream({ start: 0, end: Math.max(0, stat.size - 1) }), res);
    } finally { if (handle) await handle.close().catch(() => {}); }
    return;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw failure(503, "BRIDGE_NOT_CONFIGURED");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  timer.unref?.();
  const abort = () => controller.abort();
  res.once("close", abort);
  try {
    // This URL never leaves the Mini App. Redirects could expose the token and are prohibited.
    const upstream = await fetch(`${localApiBase() || "https://api.telegram.org"}/file/bot${token}/${result.file_path}`, {
      redirect: "error", signal: controller.signal
    });
    if (!upstream.ok || !upstream.body) throw failure(502, "TELEGRAM_DOWNLOAD_FAILED");
    const length = upstream.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > CLOUD_DOWNLOAD_LIMIT)) throw failure(413, "LARGE_FILE", "Use the authenticated factory direct-upload link for files above 20 MiB.");
    res.statusCode = 200;
    res.setHeader("Content-Type", saved.input.mime);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (length) res.setHeader("Content-Length", length);
    let bytes = 0;
    const bounded = new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.length;
      done(bytes > CLOUD_DOWNLOAD_LIMIT ? failure(413, "LARGE_FILE") : null, chunk);
    } });
    await pipeline(Readable.fromWeb(upstream.body), bounded, res);
  } finally {
    clearTimeout(timer);
    res.removeListener("close", abort);
    controller.abort();
  }
}
module.exports = { enabled, authenticated, handleUpdate, gateway, download, authorized, mediaInput, signedFileUrl };
