const crypto = require("crypto");
const store = require("../lib/store");
const { verifyInitData } = require("../lib/telegram");

const DEVICE_TTL = 30 * 60;
const COMMAND_TTL = 60;
const OWNER_INITDATA_TTL = 5 * 60;
const PRACTICES = Object.freeze({
  "/practice": "Практика многомерности",
  "/integrity": "Твоя целостность",
  "/accept": "Я принимаю",
  "/abundance": "Изобильная реальность",
  "/mirror": "Зеркало"
});
const deviceKey = (id) => `practice_remote:device:${id}`;
const commandKey = (id) => `practice_remote:command:${id}`;
const rateKey = (id, minute, kind) => `practice_remote:rate:${kind}:${id}:${minute}`;
const reply = (res, status, data) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.end(JSON.stringify(data));
};
const validId = (id) => /^[a-f0-9-]{36}$/.test(String(id || ""));
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
function bodyOf(req) {
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body && typeof req.body === "object" ? req.body : {};
}
function ownerFrom(body) {
  const configured = String(process.env.PRACTICE_REMOTE_OWNER_ID || "");
  if (!/^\d{1,20}$/.test(configured)) return null;
  try {
    const user = verifyInitData(body.initData, OWNER_INITDATA_TTL);
    return String(user.id) === configured ? configured : null;
  } catch { return null; }
}
async function readDevice(id) {
  const raw = await store.command("GET", deviceKey(id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function limited(id, kind, maximum) {
  const minute = Math.floor(Date.now() / 60000);
  const key = rateKey(id, minute, kind);
  const count = Number(await store.command("INCR", key));
  if (count === 1) await store.command("EXPIRE", key, 120);
  return count <= maximum;
}

module.exports = async function handler(req, res) {
  const body = bodyOf(req);
  if (req.method === "POST") {
    const ownerId = ownerFrom(body);
    if (!ownerId) return reply(res, process.env.PRACTICE_REMOTE_OWNER_ID ? 401 : 503, { ok: false, error: "Owner authorization unavailable" });
    if (!store.isConfigured()) return reply(res, 503, { ok: false, error: "Remote control storage unavailable" });

    if (body.action === "status") {
      const deviceId = String(body.deviceId || "");
      if (deviceId && !validId(deviceId)) return reply(res, 400, { ok: false, error: "Invalid device" });
      const device = deviceId ? await readDevice(deviceId) : null;
      return reply(res, 200, { ok: true, isOwner: true, enabled: Boolean(device && device.ownerId === ownerId) });
    }

    if (body.action === "enable") {
      if (!validId(body.deviceId)) return reply(res, 400, { ok: false, error: "Invalid device" });
      const token = crypto.randomBytes(32).toString("hex");
      const record = { ownerId, tokenHash: hashToken(token), enabledAt: Date.now() };
      await store.command("SET", deviceKey(body.deviceId), JSON.stringify(record), "EX", DEVICE_TTL);
      await store.command("DEL", commandKey(body.deviceId));
      console.log("Practice remote enabled", JSON.stringify({ device: body.deviceId, owner: ownerId }));
      return reply(res, 200, { ok: true, enabled: true, token, expiresIn: DEVICE_TTL });
    }

    if (body.action === "disable") {
      if (!validId(body.deviceId)) return reply(res, 400, { ok: false, error: "Invalid device" });
      const device = await readDevice(body.deviceId);
      if (device && device.ownerId !== ownerId) return reply(res, 403, { ok: false, error: "Forbidden" });
      await store.command("DEL", deviceKey(body.deviceId), commandKey(body.deviceId));
      console.log("Practice remote disabled", JSON.stringify({ device: body.deviceId, owner: ownerId }));
      return reply(res, 200, { ok: true, enabled: false });
    }

    if (body.action === "command") {
      const id = String(body.deviceId || "");
      const route = String(body.path || "");
      if (!validId(id) || !Object.hasOwn(PRACTICES, route)) return reply(res, 400, { ok: false, error: "Unsupported device or practice" });
      if (!(await limited(id, "command", 20))) return reply(res, 429, { ok: false, error: "Rate limit exceeded" });
      const device = await readDevice(id);
      if (!device || device.ownerId !== ownerId) return reply(res, 409, { ok: false, error: "Remote control is disabled or expired" });
      const requestId = String(body.requestId || "");
      if (!/^[a-f0-9-]{36}$/.test(requestId)) return reply(res, 400, { ok: false, error: "Invalid request id" });
      const claimed = await store.command("SET", `practice_remote:dedupe:${ownerId}:${requestId}`, "1", "NX", "EX", 600);
      if (claimed !== "OK") return reply(res, 200, { ok: true, duplicate: true });
      const command = { id: requestId, path: route, issuedAt: Date.now() };
      await store.command("SET", commandKey(id), JSON.stringify(command), "EX", COMMAND_TTL);
      console.log("Practice remote command queued", JSON.stringify({ device: id, owner: ownerId, path: route, commandId: requestId }));
      return reply(res, 200, { ok: true, queued: true, practice: PRACTICES[route] });
    }
    return reply(res, 400, { ok: false, error: "Unsupported action" });
  }

  if (req.method === "GET") {
    const id = String((req.query && req.query.deviceId) || "");
    const token = String((req.headers && req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!validId(id) || !/^[a-f0-9]{64}$/.test(token)) return reply(res, 401, { ok: false });
    const device = await readDevice(id);
    if (!device || !crypto.timingSafeEqual(Buffer.from(device.tokenHash || ""), Buffer.from(hashToken(token)))) return reply(res, 401, { ok: false });
    // Browser storage may be shared by Telegram accounts on the same origin. Bind every
    // delivery poll to the currently signed-in Telegram user, not only to a stored token.
    let pollUser;
    try {
      const initData = String((req.headers && req.headers["x-telegram-init-data"]) || "");
      pollUser = verifyInitData(initData, DEVICE_TTL);
    } catch { return reply(res, 401, { ok: false }); }
    if (String(pollUser.id) !== String(device.ownerId)) return reply(res, 401, { ok: false });
    if (!(await limited(id, "poll", 30))) return reply(res, 429, { ok: false });
    // The Redis TTL is absolute from enable time; polling never extends the session.
    const raw = await store.command("GET", commandKey(id));
    if (!raw) return reply(res, 200, { ok: true, command: null });
    await store.command("DEL", commandKey(id));
    try {
      const command = JSON.parse(raw);
      if (!Object.hasOwn(PRACTICES, command.path) || Date.now() - command.issuedAt > COMMAND_TTL * 1000) return reply(res, 200, { ok: true, command: null });
      return reply(res, 200, { ok: true, command });
    } catch { return reply(res, 200, { ok: true, command: null }); }
  }
  return reply(res, 405, { ok: false, error: "Method not allowed" });
};

module.exports.PRACTICES = PRACTICES;
module.exports.ownerFrom = ownerFrom;
module.exports.validId = validId;
