// Tribute API: https://tribute.tg/api/v1 (header "Api-Key").
const BASE_URL = "https://tribute.tg/api/v1";
const CACHE_MS = 60 * 1000;
let cache = { at: 0, list: null };

async function listSubscribers() {
  const apiKey = process.env.TRIBUTE_API_KEY;
  if (!apiKey) throw new Error("Missing TRIBUTE_API_KEY");
  if (cache.list && Date.now() - cache.at < CACHE_MS) return cache.list;

  const url = new URL(`${BASE_URL}/subscribers`);
  const subscriptionId = String(process.env.TRIBUTE_SUBSCRIPTION_ID || "").trim();
  if (subscriptionId) url.searchParams.set("subscriptionID", subscriptionId);

  const response = await fetch(url, { headers: { "Api-Key": apiKey } });
  if (!response.ok) throw new Error(`Tribute subscribers request failed (${response.status})`);
  const data = await response.json();
  const list = Array.isArray(data) ? data : (Array.isArray(data && data.result) ? data.result : []);
  cache = { at: Date.now(), list };
  return list;
}

const STATUS_RANK = { active: 3, pre_cancelled: 2, cancelled: 1 };

// Picks the most relevant subscription record for one Telegram user.
function pickSubscriber(list, telegramUserId) {
  const own = list.filter((item) => String(item.telegramUserId) === String(telegramUserId));
  own.sort((a, b) =>
    (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0) ||
    new Date(b.expireAt || 0) - new Date(a.expireAt || 0));
  return own[0] || null;
}

async function getSubscriber(telegramUserId) {
  return pickSubscriber(await listSubscribers(), telegramUserId);
}

function resetCache() {
  cache = { at: 0, list: null };
}

module.exports = { listSubscribers, pickSubscriber, getSubscriber, resetCache };
