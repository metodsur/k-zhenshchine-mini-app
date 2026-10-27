// One-time move from Vercel (Upstash Redis REST) to Timeweb (Valkey).
// Runs on the old Vercel deployment, which alone knows the Upstash settings and the
// environment values. Enabled only while MIGRATE_SECRET is set; remove it afterwards.
//   export-env — the environment values to carry over to Timeweb;
//   hold / release — the bot webhook answers 503 meanwhile, Telegram keeps the updates;
//   copy — copies every key (with its TTL) to MIGRATE_VALKEY_URL, in resumable batches;
//   count — number of keys on both sides.
const HOLD_KEY = "maint:hold";
const ENV_NAMES = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_SETUP_SECRET", "TELEGRAM_CHANNEL_ID", "TELEGRAM_CHANNEL_URL",
  "TELEGRAM_CLUB_CHAT_ID", "TELEGRAM_CLUB_URL", "TELEGRAM_BOT_USERNAME", "APP_BASE_URL", "OS_BASE_URL", "ADMIN_TELEGRAM_IDS",
  "CRON_SECRET", "QSTASH_TOKEN", "QSTASH_URL", "TELEGRAM_REMINDER_SECRET", "TRIBUTE_API_KEY", "TRIBUTE_SUBSCRIPTION_ID",
  "YOOKASSA_PROVIDER_TOKEN", "YOOKASSA_RECEIPT_VAT_CODE", "VK_GROUP_ID", "VK_GROUP_TOKEN", "LEVELS_SYNC_SECRET", "LEVELS_URL",
  "VAULT_KEY", "OWNER_NAME", "CLUB_REMINDER_DAYS", "REMINDER_TIMEZONE"
];

function upstash() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash is not configured");
  return { url: url.replace(/\/$/, ""), token };
}

// Upstash pipeline with base64 values, so any bytes survive the trip.
async function pipeline(commands) {
  if (!commands.length) return [];
  const cfg = upstash();
  const response = await fetch(`${cfg.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", "Upstash-Encoding": "base64" },
    body: JSON.stringify(commands.map((c) => c.map(String)))
  });
  const data = await response.json();
  if (!response.ok || !Array.isArray(data)) throw new Error(`Upstash pipeline failed (${response.status})`);
  return data.map((item) => {
    if (item.error) throw new Error(`Upstash: ${item.error}`);
    return item.result;
  });
}

const buf = (value) => Buffer.from(String(value), "base64");
const text = (value) => buf(value).toString("utf8");
// Short status replies may come back plain; take whichever reading makes sense.
const TYPES = ["string", "hash", "list", "set", "zset", "stream", "none"];
const typeOf = (value) => (TYPES.includes(text(value)) ? text(value) : String(value));
const cursorOf = (value) => (/^\d+$/.test(text(value)) ? text(value) : String(value));

let target = null;
function valkey() {
  if (!process.env.MIGRATE_VALKEY_URL) throw new Error("MIGRATE_VALKEY_URL is not set");
  if (!target) {
    const Redis = require("ioredis");
    target = new Redis(process.env.MIGRATE_VALKEY_URL, { maxRetriesPerRequest: 2 });
  }
  return target;
}

async function copyBatch(keys) {
  const meta = await pipeline(keys.flatMap((k) => [["TYPE", k], ["PTTL", k]]));
  const reads = [];
  keys.forEach((k, i) => {
    const type = typeOf(meta[i * 2]);
    const read = { string: ["GET", k], hash: ["HGETALL", k], list: ["LRANGE", k, 0, -1], set: ["SMEMBERS", k], zset: ["ZRANGE", k, 0, -1, "WITHSCORES"] }[type];
    if (read) reads.push({ key: k, type, ttl: Number(meta[i * 2 + 1]), read });
    else if (type !== "none") console.error("Migrate: skipped key of type", type);
  });
  const values = await pipeline(reads.map((r) => r.read));
  const multi = valkey().pipeline();
  reads.forEach((r, i) => {
    const v = values[i];
    if (v === null || v === undefined) return;
    multi.del(r.key);
    if (r.type === "string") multi.set(r.key, buf(v));
    else if (!v.length) return;
    else if (r.type === "hash" || r.type === "list" || r.type === "set") {
      const items = v.map(buf);
      for (let j = 0; j < items.length; j += 500) {
        const part = items.slice(j, j + 500);
        if (r.type === "hash") multi.hset(r.key, ...part);
        else if (r.type === "list") multi.rpush(r.key, ...part);
        else multi.sadd(r.key, ...part);
      }
    } else if (r.type === "zset") {
      const args = [];
      for (let j = 0; j < v.length; j += 2) args.push(text(v[j + 1]), buf(v[j]));
      for (let j = 0; j < args.length; j += 1000) multi.zadd(r.key, ...args.slice(j, j + 1000));
    }
    if (r.ttl > 0) multi.pexpire(r.key, r.ttl);
  });
  const results = await multi.exec();
  const failed = (results || []).filter(([error]) => error);
  if (failed.length) throw new Error(`Valkey write failed: ${failed[0][0].message}`);
  return reads.length;
}

async function copy({ cursor = "0", fresh = false } = {}) {
  const started = Date.now();
  if (fresh && String(cursor) === "0") await valkey().flushdb();
  let copied = 0;
  let next = String(cursor);
  do {
    const [nextCursor, keys] = await pipeline([["SCAN", next, "COUNT", 200]]).then(([r]) => [cursorOf(r[0]), r[1].map(text)]);
    next = nextCursor;
    const wanted = keys.filter((k) => k !== HOLD_KEY);
    if (wanted.length) copied += await copyBatch(wanted);
  } while (next !== "0" && Date.now() - started < 40000);
  return { copied, cursor: next, done: next === "0" };
}

async function count() {
  const [source] = await pipeline([["DBSIZE"]]);
  return { upstash: source, valkey: await valkey().dbsize() };
}

function exportEnv() {
  const env = {};
  for (const name of ENV_NAMES) if (process.env[name]) env[name] = process.env[name];
  return { env };
}

async function run(action, query) {
  if (action === "export-env") return exportEnv();
  if (action === "hold") { await pipeline([["SET", HOLD_KEY, "1", "EX", 3600]]); return { hold: true }; }
  if (action === "release") { await pipeline([["DEL", HOLD_KEY]]); return { hold: false }; }
  if (action === "copy") return copy({ cursor: query.cursor || "0", fresh: query.fresh === "1" });
  if (action === "count") return count();
  throw new Error("Unknown action");
}

// True while the bot webhook should stay quiet (only on the deployment being migrated).
async function onHold() {
  if (!process.env.MIGRATE_SECRET) return false;
  try { return Boolean(await require("./store").command("GET", HOLD_KEY)); } catch { return false; }
}

module.exports = { run, onHold, HOLD_KEY };
