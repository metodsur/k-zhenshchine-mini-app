// Delayed calls to our own endpoints through Upstash QStash (e.g. "remind in an hour").
async function scheduleCall(path, body, delay) {
  const token = process.env.QSTASH_TOKEN;
  const secret = process.env.TELEGRAM_REMINDER_SECRET;
  const baseUrl = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!token || !secret || !baseUrl) throw new Error("Delayed calls are not configured");
  const destination = `${baseUrl}${path}`;
  const response = await fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(destination)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Upstash-Delay": delay, "Upstash-Forward-X-Reminder-Secret": secret },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error("Could not schedule a delayed call");
}

module.exports = { scheduleCall };
