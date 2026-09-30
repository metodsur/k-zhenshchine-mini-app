const schedule = require("../schedule");
const orders = require("../orders");
const messages = require("../meeting-messages");
const store = require("../store");
const { telegram, safeEqualString } = require("../telegram");
const { send } = require("../http");

function localDate(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

// Every ticket holder of a meeting that happens tomorrow (in the city's own time zone) gets one reminder.
async function runMeetingReminders(now = Date.now()) {
  const doc = await schedule.loadSchedule();
  const result = { meetings: 0, sent: 0, skipped: 0, failed: 0 };
  for (const city of doc.cities) {
    const tomorrow = localDate(now + 24 * 60 * 60 * 1000, city.timezone);
    for (const mid of schedule.MEETING_IDS) {
      if (city.meetings[mid].date !== tomorrow) continue;
      result.meetings += 1;
      const message = messages.reminderMessage(city, mid);
      for (const order of await orders.ordersFor(city.id, mid)) {
        if (order.status !== "paid") continue;
        try {
          if (!(await store.claimOnce(`reminder:meeting:${order.id}:${mid}:${tomorrow}`, 7 * 24 * 60 * 60))) { result.skipped += 1; continue; }
          await telegram("sendMessage", { chat_id: order.user_id, ...message });
          result.sent += 1;
        } catch { result.failed += 1; }
      }
    }
  }
  return result;
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqualString(req.headers.authorization, `Bearer ${secret}`)) return send(res, 403, { ok: false });
  try {
    const result = await runMeetingReminders();
    console.log("Meeting reminders", JSON.stringify(result));
    return send(res, 200, { ok: true, ...result });
  } catch (error) {
    console.error("Meeting reminders failed", error.message);
    return send(res, 500, { ok: false });
  }
};
module.exports.runMeetingReminders = runMeetingReminders;
