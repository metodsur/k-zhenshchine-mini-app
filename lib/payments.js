// Bot-side handling of meeting payments (Telegram Payments with the YooKassa provider).
const orders = require("./orders");
const schedule = require("./schedule");
const messages = require("./meeting-messages");
const { telegram } = require("./telegram");
const { adminIds } = require("./http");

async function answerPreCheckout(query) {
  const deny = (error_message) => telegram("answerPreCheckoutQuery", { pre_checkout_query_id: query.id, ok: false, error_message });
  try {
    const order = await orders.getOrder(query.invoice_payload);
    if (!order || order.status !== "pending") return deny("Заказ устарел. Откройте встречи и попробуйте ещё раз.");
    if (String(order.user_id) !== String(query.from.id)) return deny("Этот счёт создан для другого аккаунта.");
    if (query.currency !== "RUB" || query.total_amount !== order.amount * 100) return deny("Сумма изменилась. Откройте встречи и попробуйте ещё раз.");
    // Re-check seats and dates at the moment of payment.
    const { resolvePurchase } = require("./handlers/invoice");
    const item = await resolvePurchase({ cityId: order.city_id, kind: order.kind, meeting: order.meeting });
    if (item.error) return deny(`${item.error}. Оплата не списана.`);
    return telegram("answerPreCheckoutQuery", { pre_checkout_query_id: query.id, ok: true });
  } catch (error) {
    console.error("Pre-checkout failed", error.message);
    return deny("Не получилось проверить заказ. Попробуйте ещё раз через минуту.");
  }
}

async function handleSuccessfulPayment(message) {
  const payment = message.successful_payment;
  const { order, firstTime } = await orders.markPaid(payment.invoice_payload, payment);
  if (!order) {
    console.error("Paid order not found", payment.invoice_payload);
    await notifyAdmins({ text: `⚠️ Пришла оплата без заказа в базе: ${payment.total_amount / 100} ₽, пользователь ${message.from.id}. Проверьте ЮKassa.` });
    return;
  }
  if (!firstTime) return;
  const doc = await schedule.loadSchedule();
  const city = schedule.findCity(doc, order.city_id);
  if (city) await telegram("sendMessage", { chat_id: message.chat.id, ...messages.ticketMessage(order, city) });
  await notifyAdmins(messages.adminPurchaseMessage(order));
}

async function notifyAdmins(message) {
  for (const id of adminIds()) {
    try { await telegram("sendMessage", { chat_id: id, ...message }); } catch { /* admin never started the bot */ }
  }
}

async function handleAdminCommand(message) {
  if (!adminIds().includes(String(message.from.id))) {
    await telegram("sendMessage", { chat_id: message.chat.id, text: `Ваш Telegram ID: ${message.from.id}\nЧтобы получить доступ к управлению встречами, его нужно добавить в настройки приложения.` });
    return;
  }
  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: "Управление расписанием встреч:",
    reply_markup: { inline_keyboard: [[{ text: "Открыть админку", web_app: { url: messages.appUrl("admin.html") } }]] }
  });
}

// Returns true when the update was a payment/admin update and has been handled.
async function handleUpdate(update) {
  if (update.pre_checkout_query) { await answerPreCheckout(update.pre_checkout_query); return true; }
  const message = update.message;
  if (message && message.successful_payment) { await handleSuccessfulPayment(message); return true; }
  if (message && message.chat && message.chat.type === "private" && typeof message.text === "string" && /^\/admin(@\w+)?(\s|$)/.test(message.text)) {
    await handleAdminCommand(message); return true;
  }
  return false;
}

module.exports = { handleUpdate, answerPreCheckout, handleSuccessfulPayment, notifyAdmins };
