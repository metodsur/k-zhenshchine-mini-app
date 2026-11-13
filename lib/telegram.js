const crypto = require("crypto");

const PROXY_URL = "https://content.towomen.ru/cf-staging/api/workflow/local-telegram";
const LEGACY_FILE_LIMIT = 50 * 1024 * 1024;
const LOCAL_FILE_LIMIT = 6 * 1024 * 1024 * 1024;
const TOKEN_PATTERN = /^8824620595:[A-Za-z0-9_-]{20,128}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
function transportError(method, status, code) {
  return Object.assign(new Error(`Telegram ${/^[A-Za-z]+$/.test(method) ? method : "operation"} failed`), {
    ...(status ? { status } : {}), ...(code ? { code } : {})
  });
}
// An explicitly set but invalid/empty flag is a configuration failure, NEVER cloud fallback.
function telegramProxyConfig() {
  if (process.env.TELEGRAM_API_PROXY_URL === undefined) return null;
  const token = process.env.TELEGRAM_BOT_TOKEN, secret = process.env.CF_BRIDGE_SECRET;
  if (process.env.TELEGRAM_API_PROXY_URL !== PROXY_URL || typeof secret !== "string" || secret.length < 32
      || typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw transportError("proxy", 503, "TELEGRAM_PROXY_NOT_CONFIGURED");
  }
  return { url: PROXY_URL, token, secret };
}
function safeFailure(error, method, proxy) {
  // No fetch exception with request credentials/URL may reach API errors or server logs.
  const queue = error ? [error] : [];
  let credentialsInError = false;
  for (let i = 0; i < 12 && queue.length; i++) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    const text = [item.message, item.stack, item.url].filter(v => typeof v === "string").join(" ");
    if ([process.env.TELEGRAM_BOT_TOKEN, process.env.CF_BRIDGE_SECRET].some(s => s && text.includes(s))
        || /(?:api\.telegram\.org\/(?:file\/)?bot|\/bot\d+:)/i.test(text)) credentialsInError = true;
    if (item.cause && item.cause !== item) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors.slice(0, 4));
  }
  if (proxy || credentialsInError) {
    return transportError(method, error?.status === 413 ? 413 : 502, error?.status === 413 ? "LARGE_FILE" : "TELEGRAM_GATEWAY_FAILED");
  }
  return error;
}
async function telegramProxyRequest(method, payload, options = {}) {
  const proxy = telegramProxyConfig();
  if (!proxy) throw transportError("proxy", 503, "TELEGRAM_PROXY_NOT_CONFIGURED");
  try {
    const response = await fetch(proxy.url, {
      method: "POST", headers: { "Content-Type": "application/json", "x-cf-bridge-secret": proxy.secret },
      body: JSON.stringify({ method, payload, token: proxy.token }), redirect: "error",
      signal: options.signal || AbortSignal.timeout(method === "download" || method.startsWith("send") ? 600000 : 30000)
    });
    if (!response.ok) throw transportError(method, response.status === 413 ? 413 : 502, response.status === 413 ? "LARGE_FILE" : "TELEGRAM_GATEWAY_FAILED");
    return response;
  } catch (error) { throw safeFailure(error, method, true); }
}
async function telegram(method, payload, options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const proxy = telegramProxyConfig();
  const started = Date.now();
  let phase = "fetch", upstreamStatus = null, apiErrorCode = null;
  try {
    const response = proxy ? await telegramProxyRequest(method, payload, options) : await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.redirect ? { redirect: options.redirect } : {})
    });
    upstreamStatus = response.status;
    phase = "json";
    const data = await response.json();
    phase = "api";
    apiErrorCode = data?.error_code;
    if (!response.ok || !data.ok) throw transportError(method);
    return data.result;
  } catch (error) {
    const safe = safeFailure(error, method, !!proxy);
    if (typeof options.onFailure === "function") {
      try { options.onFailure({ phase, upstreamStatus, apiErrorCode, elapsedMs: Date.now() - started }, safe); } catch { /* telemetry cannot change failure behavior */ }
    }
    throw safe;
  }
}

// Existing multipart sendDocument uploads remain multipart; only the opt-in wire envelope changes.
async function telegramUpload(method, payload, field, buffer, filename, mime) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const proxy = telegramProxyConfig();
  const form = new FormData();
  if (proxy) {
    if (method !== "sendDocument" || field !== "document" || buffer.byteLength > LEGACY_FILE_LIMIT
        || /[\\/\r\n\0]/.test(filename || "file") || (filename || "file").length > 255) throw transportError("upload", 400, "INVALID_TELEGRAM_UPLOAD");
    form.append("method", method);
    form.append("token", token);
    form.append("payload", JSON.stringify(payload));
  } else {
    for (const [k, v] of Object.entries(payload)) if (v !== undefined && v !== null) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  form.append(field, new Blob([buffer], { type: mime || "application/octet-stream" }), filename || "file");
  try {
    const response = await fetch(proxy ? proxy.url : `https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", body: form,
      ...(proxy ? { headers: { "x-cf-bridge-secret": proxy.secret }, redirect: "error", signal: AbortSignal.timeout(600000) } : {})
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw transportError(method);
    return data.result;
  } catch (error) { throw safeFailure(error, method, !!proxy); }
}

// Legacy browser consumers buffer only small files. CF uses its separately receipt-bound
// streaming path (6 GiB). Never derive a cross-host download URL from opaque local metadata.
async function telegramDownload(fileId, options = {}) {
  if (!FILE_ID_PATTERN.test(fileId || "")) throw transportError("download", 400, "INVALID_TELEGRAM_FILE_ID");
  const proxy = telegramProxyConfig();
  const limit = options.maxBytes === undefined ? LEGACY_FILE_LIMIT : options.maxBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LOCAL_FILE_LIMIT) throw transportError("download", 400, "INVALID_TELEGRAM_FILE_LIMIT");
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000), ...(options.signal ? [options.signal] : [])]);
  try {
    let response;
    if (proxy) response = await telegramProxyRequest("download", { file_id: fileId }, { signal });
    else {
      const file = await telegram("getFile", { file_id: fileId }, { signal });
      if (typeof file?.file_path !== "string" || !/^[A-Za-z0-9_./-]+$/.test(file.file_path)
          || file.file_path.split("/").some(p => !p || p === "." || p === "..")) throw transportError("download", 502, "INVALID_TELEGRAM_FILE_PATH");
      response = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, {
        redirect: "error", signal, ...(options.dispatcher ? { dispatcher: options.dispatcher } : {})
      });
    }
    if (!response.ok) throw transportError("download", 502);
    const length = response.headers?.get("content-length");
    if (length !== undefined && length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw transportError("download", 413, "LARGE_FILE");
    // Real fetch Responses always have a Web body; arrayBuffer compatibility keeps legacy test fakes valid.
    if (!response.body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > limit) throw transportError("download", 413, "LARGE_FILE");
      return buffer;
    }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw transportError("download", 413, "LARGE_FILE");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (length != null && Number(length) !== size) throw transportError("download", 502);
    return Buffer.concat(chunks, size);
  } catch (error) { throw safeFailure(error, "download", !!proxy); }
  finally { controller.abort(); }
}

function isMemberStatus(status) {
  return status === "creator" || status === "administrator" || status === "member" || status === "restricted";
}
async function isChatMember(chatId, userId) {
  const member = await telegram("getChatMember", { chat_id: chatId, user_id: userId });
  return isMemberStatus(member.status) && member.is_member !== false;
}
async function isChannelMember(userId) {
  const channelId = String(process.env.TELEGRAM_CHANNEL_ID || "").trim();
  if (!channelId) throw new Error("Missing TELEGRAM_CHANNEL_ID");
  return isChatMember(channelId, userId);
}
async function isClubMember(userId) {
  const clubId = String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim();
  if (!clubId) throw new Error("Missing TELEGRAM_CLUB_CHAT_ID");
  return isChatMember(clubId, userId);
}
function verifyInitData(initData, maxAgeSeconds = 86400) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!receivedHash || !Number.isFinite(authDate)) throw new Error("Invalid initData");
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > maxAgeSeconds) throw new Error("Expired initData");
  const pairs = [];
  for (const [key, value] of params.entries()) if (key !== "hash") pairs.push(`${key}=${value}`);
  pairs.sort();
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const calculated = crypto.createHmac("sha256", secretKey).update(pairs.join("\n")).digest("hex");
  const a = Buffer.from(calculated, "hex"), b = Buffer.from(receivedHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Invalid signature");
  const rawUser = params.get("user");
  const user = rawUser ? JSON.parse(rawUser) : null;
  if (!user || !user.id) throw new Error("Missing Telegram user");
  return user;
}
function safeEqualString(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(String(left)), b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { telegram, telegramUpload, telegramDownload, telegramProxyConfig, telegramProxyRequest, isChatMember, isChannelMember, isClubMember, isMemberStatus, verifyInitData, safeEqualString };
