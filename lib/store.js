// Minimal Upstash Redis REST client (works with Vercel's Upstash/KV integration).
// Every call is best-effort: when storage is not configured, reads return null
// and writes are skipped, so the app keeps working without it.

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

function isConfigured() {
  return Boolean(config());
}

async function command(...args) {
  const cfg = config();
  if (!cfg) return null;
  const response = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args.map(String))
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error("Storage command failed");
  return data.result;
}

const userKey = (userId) => `user:${userId}`;

// Keeps the first known date: re-joining the channel does not reset it.
async function rememberChannelJoin(userId, isoDate) {
  return command("HSETNX", userKey(userId), "channel_joined_at", isoDate);
}

async function getChannelJoin(userId) {
  return command("HGET", userKey(userId), "channel_joined_at");
}

// Returns true only the first time a key is claimed (used to send a reminder once).
async function claimOnce(key, ttlSeconds) {
  if (!isConfigured()) return true;
  return (await command("SET", key, "1", "NX", "EX", ttlSeconds)) === "OK";
}

module.exports = { isConfigured, command, rememberChannelJoin, getChannelJoin, claimOnce };
