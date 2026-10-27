// Activity in the paid club group, counted by the bot (it is an admin there, so it sees every message):
//  - a collaboration = a post with #коллаборация (#коллаб also counts), confirmed by a tagged partner (lib/collabs.js);
//  - active women = different members who wrote in the group.
// Meetings and cities of the week come from the meetings schedule.
const store = require("./store");
const schedule = require("./schedule");

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_SECONDS = 45 * 24 * 60 * 60;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const K = {
  active: (d) => `stats:club:active:${d}`,
  collabs: (d) => `stats:club:collabs:${d}`,
  collabsTotal: "stats:club:collabs:total"
};

function isClubGroup(chat) {
  const id = String(process.env.TELEGRAM_CLUB_CHAT_ID || "").trim();
  return Boolean(id && chat && String(chat.id) === id);
}

async function trackGroupMessage(message, now = Date.now()) {
  if (!message || !isClubGroup(message.chat) || !message.from || message.from.is_bot) return false;
  const d = day(now);
  await store.command("SADD", K.active(d), message.from.id);
  await store.command("EXPIRE", K.active(d), KEEP_SECONDS);
  await require("./collabs").handleGroupMessage(message);
  return true;
}

async function summary(now = Date.now()) {
  const days = Array.from({ length: 7 }, (_, i) => day(now - i * DAY_MS));
  const [women, collabsDaily, total, doc] = await Promise.all([
    store.command("SUNION", ...days.map(K.active)),
    store.command("MGET", ...days.map(K.collabs)),
    store.command("GET", K.collabsTotal),
    schedule.loadSchedule()
  ]);
  let meetings = 0;
  const cities = new Set();
  for (const city of doc.cities) {
    for (const mid of schedule.MEETING_IDS) {
      const start = schedule.meetingStart(city.meetings[mid], city.timezone);
      if (start !== null && start <= now && start > now - 7 * DAY_MS) { meetings += 1; cities.add(city.id); }
    }
  }
  return {
    collabs_total: Number(total) || 0,
    week: {
      collabs: (collabsDaily || []).reduce((a, v) => a + (Number(v) || 0), 0),
      meetings,
      women: (women || []).length,
      cities: cities.size
    }
  };
}

module.exports = { trackGroupMessage, summary, isClubGroup };
