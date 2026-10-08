const { telegram, isChannelMember, safeEqualString } = require("../../lib/telegram");

function send(res, status, body) { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); }

const TEXTS = {
  "10m": "Мы очень хотим видеть тебя в нашем пространстве 😍\nПосле вступления в канал тебе откроется полный функционал приложения.",
  "24h": "Мы всё ещё ждём тебя в пространстве «к Женщине» 🤍\nЗдесь женщины поддерживают друг друга, проходят ритуалы и встречаются вживую. Присоединяйся — тебе здесь рады."
};

// An hour after an invoice was created: if it is still unpaid (and nothing newer for the same
// meeting was paid), the woman gets a gentle reminder and the CRM card gets a next step.
async function checkoutReminder(orderId) {
  const orders = require("../../lib/orders");
  const schedule = require("../../lib/schedule");
  const crm = require("../../lib/crm");
  const { resolvePurchase } = require("../../lib/handlers/invoice");
  const order = await orders.getOrder(orderId);
  if (!order) return { skipped: "expired" };
  if (order.status === "paid") return { skipped: "paid" };
  const paidLater = (await orders.userOrders(order.user_id)).some((o) => o.city_id === order.city_id && o.kind === order.kind && (o.kind === "package" || o.meeting === order.meeting) && o.paid_at > order.created_at);
  if (paidLater) return { skipped: "paid" };
  const item = await resolvePurchase({ cityId: order.city_id, kind: order.kind, meeting: order.meeting });
  if (item.error) return { skipped: "closed" };
  if (order.kind === "training") {
    const t = await require("../../lib/masters").findTraining(order.meeting);
    const base0 = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
    await telegram("sendMessage", { chat_id: order.user_id, text: `Ты начала запись на обучение Мастеров многомерности${t ? ` «${t.title}»` : ""}, но оплата не завершилась.\nМесто в потоке пока свободно — можно продолжить, когда будет удобно 🤍`,
      reply_markup: { inline_keyboard: [[{ text: "Продолжить запись", web_app: { url: `${base0}/master.html` } }]] } });
    await require("../../lib/conversations").open(order.user_id, "checkout");
    await crm.safeTouch({ id: order.user_id, first_name: order.name || undefined, username: order.username || undefined }, {
      type: "checkout", interest: "master", stage_min: "offer",
      next_step: { date: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), action: "Не завершила оплату обучения Мастеров — помочь" },
      text: `Не завершила оплату обучения Мастеров (${order.amount} ₽). Бот отправил напоминание.`
    });
    return { sent: 1 };
  }
  const doc = await schedule.loadSchedule();
  const city = schedule.findCity(doc, order.city_id);
  const what = order.kind === "package" ? "полный путь из 6 встреч" : `встречу «${schedule.MEETINGS[order.meeting].title}»`;
  const when = order.kind === "package" ? schedule.formatMeetingDate(city.meetings["1"], city.timezone) : schedule.formatMeetingDate(city.meetings[order.meeting], city.timezone);
  const base = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
  await telegram("sendMessage", {
    chat_id: order.user_id,
    text: `Ты начала запись на ${what} — ${city.name}, ${order.kind === "package" ? "старт " : ""}${when}, но оплата не завершилась.\nМесто пока свободно — можно продолжить, когда будет удобно 🤍\nЕсли что-то не получилось с оплатой, просто ответь на это сообщение.`,
    reply_markup: { inline_keyboard: [[{ text: "Продолжить запись", web_app: { url: `${base}/meetings.html` } }]] }
  });
  await require("../../lib/conversations").open(order.user_id, "checkout");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  await crm.safeTouch({ id: order.user_id, first_name: order.name || undefined, username: order.username || undefined }, {
    type: "checkout", interest: "cycle", city: order.city_name, stage_min: "offer",
    next_step: { date: today, action: `Не завершила оплату: ${what}, ${city.name} — помочь с записью` },
    text: `Не завершила оплату: ${what}, ${city.name} (${order.amount} ₽). Бот отправил напоминание.`
  });
  return { sent: 1 };
}

// Delayed by QStash after /start. Only people who still have not joined the channel get the message.
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  if (!safeEqualString(req.headers["x-reminder-secret"], process.env.TELEGRAM_REMINDER_SECRET)) return send(res, 403, { ok: false });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { return send(res, 400, { ok: false }); }
  if (body.kind === "pairs") {
    try { return send(res, 200, { ok: true, result: await require("../../lib/pairs").handleDelayed(body) }); } catch (error) { console.error("Pairs step failed", error.message); return send(res, 500, { ok: false }); }
  }
  if (body.kind === "checkout") {
    try { return send(res, 200, { ok: true, ...(await checkoutReminder(body.orderId)) }); } catch { return send(res, 500, { ok: false }); }
  }
  const { chatId, userId } = body;
  if (!chatId || !userId) return send(res, 400, { ok: false });
  try {
    if (await isChannelMember(userId)) return send(res, 200, { ok: true, skipped: "member" });
    await telegram("sendMessage", {
      chat_id: chatId,
      text: TEXTS[body.stage] || TEXTS["10m"],
      reply_markup: { inline_keyboard: [[{ text: "Присоединиться к пространству", url: process.env.TELEGRAM_CHANNEL_URL }]] }
    });
    return send(res, 200, { ok: true });
  } catch { return send(res, 500, { ok: false }); }
};
