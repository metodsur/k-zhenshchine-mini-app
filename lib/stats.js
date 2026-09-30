// Lightweight counters for the analytics page. Tracking is best-effort and never breaks the request.
const store = require("./store");

const day = (date = new Date()) => date.toISOString().slice(0, 10);
const KEYS = {
  started: "stats:started",          // pressed /start in the bot
  appUsers: "stats:app_users",       // opened the Mini App from Telegram
  onboarded: "stats:onboarded",      // reached the main pages as a channel member
  paidOrders: "orders:paid",         // paid meeting orders
  startsOn: (d) => `stats:starts:${d}`,
  joinsOn: (d) => `stats:joins:${d}`
};

async function safe(task) { try { return await task(); } catch { return null; } }

async function trackStart(userId) {
  return safe(async () => {
    if (Number(await store.command("SADD", KEYS.started, userId)) === 1) await store.command("INCR", KEYS.startsOn(day()));
  });
}
const trackAppUser = (userId) => safe(() => store.command("SADD", KEYS.appUsers, userId));
const trackOnboarded = (userId) => safe(() => store.command("SADD", KEYS.onboarded, userId));
const trackChannelJoin = (date) => safe(() => store.command("INCR", KEYS.joinsOn(day(date))));
const trackPaidOrder = (orderId) => safe(() => store.command("SADD", KEYS.paidOrders, orderId));

module.exports = { KEYS, day, trackStart, trackAppUser, trackOnboarded, trackChannelJoin, trackPaidOrder };
