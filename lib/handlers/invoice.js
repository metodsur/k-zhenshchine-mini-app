const schedule = require("../schedule");
const orders = require("../orders");
const { telegram } = require("../telegram");
const { send, readBody, telegramUser } = require("../http");

// Optional 54-FZ receipt (for an IP with an online cash register in YooKassa).
function receiptData(description, amount) {
  const vat = Number(process.env.YOOKASSA_RECEIPT_VAT_CODE);
  if (!vat) return undefined;
  return JSON.stringify({ receipt: { items: [{
    description: description.slice(0, 128), quantity: "1.00",
    amount: { value: amount.toFixed(2), currency: "RUB" },
    vat_code: vat, payment_mode: "full_payment", payment_subject: "service"
  }] } });
}

// Checks that the requested item can be bought right now; returns { city, amount, title, description } or { error }.
async function resolvePurchase({ cityId, kind, meeting }) {
  const doc = await schedule.loadSchedule();
  const city = schedule.findCity(doc, cityId);
  if (!city) return { error: "Город не найден" };
  const counts = await schedule.soldCounts(doc);
  const now = Date.now();
  if (kind === "package") {
    const status = schedule.packageStatus(city, counts, now);
    if (status !== "open") return { error: status === "sold_out" ? "Места закончились" : "Запись на пакет ещё не открыта", status };
    return {
      city, amount: doc.prices.package,
      title: "Все 6 встреч «к Женщине»",
      description: `${city.name}. Полный путь из 6 офлайн-встреч, старт — ${schedule.formatMeetingDate(city.meetings["1"], city.timezone)}.`
    };
  }
  if (!schedule.MEETING_IDS.includes(String(meeting))) return { error: "Встреча не найдена" };
  const m = city.meetings[meeting];
  const status = schedule.meetingStatus(m, city.timezone, counts[`${city.id}:${meeting}`] || 0, now);
  if (status !== "open") return { error: status === "sold_out" ? "Места закончились" : status === "soon" ? "Дата ещё не объявлена" : "Запись закрыта", status };
  const title = schedule.MEETINGS[meeting].title;
  return {
    city, amount: doc.prices.single,
    title: `Встреча «${title}»`.slice(0, 32),
    description: `${city.name}, ${schedule.formatMeetingDate(m, city.timezone)}${m.venue ? `, ${m.venue}` : ""}. Офлайн-встреча «${title}».`.slice(0, 255)
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const body = readBody(req);
  const user = telegramUser(body);
  if (!user) return send(res, 401, { ok: false, error: "Откройте приложение из Telegram" });
  const token = process.env.YOOKASSA_PROVIDER_TOKEN;
  if (!token) return send(res, 503, { ok: false, error: "Оплата скоро заработает" });

  const kind = body.kind === "package" ? "package" : "single";
  try {
    const item = await resolvePurchase({ cityId: String(body.city || ""), kind, meeting: String(body.meeting || "") });
    if (item.error) return send(res, 409, { ok: false, error: item.error, status: item.status || null });
    const order = await orders.createPendingOrder({ user, city: item.city, kind, meeting: String(body.meeting || ""), amount: item.amount });
    const link = await telegram("createInvoiceLink", {
      title: item.title,
      description: item.description,
      payload: order.id,
      provider_token: token,
      currency: "RUB",
      prices: [{ label: item.title, amount: item.amount * 100 }],
      need_name: true,
      need_phone_number: true,
      need_email: true,
      send_email_to_provider: true,
      provider_data: receiptData(item.title, item.amount)
    });
    return send(res, 200, { ok: true, invoice_link: link, order_id: order.id });
  } catch (error) {
    console.error("Invoice creation failed", error.message);
    return send(res, 500, { ok: false, error: "Не получилось создать оплату. Попробуйте ещё раз." });
  }
};

module.exports.resolvePurchase = resolvePurchase;
