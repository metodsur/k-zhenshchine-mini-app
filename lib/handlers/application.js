// Applications for the development paths (Партнёр / Мастер) from the new pages.
const store = require("../store");
const orders = require("../orders");
const crm = require("../crm");
const { send, readBody, telegramUser } = require("../http");
const { notifyAdmins } = require("../payments");

const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const KINDS = { partner: "Путь Партнёра", master: "Путь Мастера" };

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const body = readBody(req);
  const user = telegramUser(body);
  if (!user) return send(res, 401, { ok: false, error: "Откройте приложение из Telegram" });
  const kind = KINDS[body.kind] ? body.kind : null;
  const name = clean(body.name, 80);
  const contact = clean(body.contact, 120);
  if (!kind) return send(res, 400, { ok: false, error: "Неизвестная заявка" });
  if (!name || !contact) return send(res, 400, { ok: false, error: "Укажите имя и контакт" });

  let passed = null;
  if (kind === "master") {
    try {
      const paid = await orders.userOrders(user.id);
      const now = Date.now();
      const schedule = require("../schedule");
      const doc = await schedule.loadSchedule();
      const done = new Set();
      for (const o of paid) {
        const city = schedule.findCity(doc, o.city_id);
        for (const mid of orders.meetingsOf(o)) {
          const start = city ? schedule.meetingStart(city.meetings[mid], city.timezone) : null;
          if (start !== null && start < now) done.add(mid);
        }
      }
      passed = done.size;
    } catch { passed = null; }
  }

  const application = {
    kind, name, contact,
    city: clean(body.city, 60) || null,
    project: clean(body.project, 300) || null,
    user_id: user.id, username: user.username || null,
    meetings_passed: passed,
    created_at: new Date().toISOString()
  };
  try { await store.command("LPUSH", "applications", JSON.stringify(application)); } catch { /* the alert below still goes out */ }
  await crm.safeTouch(user, { type: "application", interest: kind, city: application.city, contact, text: `Заявка: ${KINDS[kind]}${application.project ? ` · ${application.project}` : ""}${passed !== null ? ` · пройдено встреч: ${passed} из 6` : ""}` });
  const tg = user.username ? `@${user.username}` : `id ${user.id}`;
  const lines = [`🌟 Заявка: ${KINDS[kind]}`, `${name} (${tg})`, `Контакт: ${contact}`];
  if (application.city) lines.push(`Город: ${application.city}`);
  if (application.project) lines.push(`Проект: ${application.project}`);
  if (passed !== null) lines.push(`Пройдено встреч: ${passed} из 6`);
  await notifyAdmins({ text: lines.join("\n") });
  return send(res, 200, { ok: true });
};
