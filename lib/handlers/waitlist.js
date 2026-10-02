const schedule = require("../schedule");
const orders = require("../orders");
const crm = require("../crm");
const { send, readBody, telegramUser } = require("../http");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const body = readBody(req);
  const user = telegramUser(body);
  if (!user) return send(res, 401, { ok: false, error: "Откройте приложение из Telegram" });

  const target = body.kind === "package" ? "package" : String(body.meeting || "");
  if (target !== "package" && !schedule.MEETING_IDS.includes(target)) return send(res, 400, { ok: false, error: "Встреча не найдена" });
  try {
    const doc = await schedule.loadSchedule();
    const city = schedule.findCity(doc, String(body.city || ""));
    if (!city) return send(res, 400, { ok: false, error: "Город не найден" });
    await orders.joinWaitlist(city.id, target, user.id);
    const what = target === "package" ? "все 6 встреч" : `встреча «${schedule.MEETINGS[target].title}»`;
    await crm.safeTouch(user, { type: "waitlist", interest: "cycle", city: city.name, text: `Лист ожидания: ${city.name}, ${what}` });
    return send(res, 200, { ok: true });
  } catch (error) {
    console.error("Waitlist failed", error.message);
    return send(res, 500, { ok: false, error: "Не получилось записаться. Попробуйте ещё раз." });
  }
};
