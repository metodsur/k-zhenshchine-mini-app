const { send, readBody, telegramUser } = require("../http");
const { notifyAdmins } = require("../payments");
const crm = require("../crm");

const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const body = readBody(req);
  const user = telegramUser(body);
  if (!user) return send(res, 401, { ok: false, error: "Откройте приложение из Telegram" });
  const name = clean(body.name, 80);
  const contact = clean(body.contact, 120);
  if (!name || !contact) return send(res, 400, { ok: false, error: "Укажите имя и контакт" });
  await crm.safeTouch(user, { type: "circle", interest: "circle", city: clean(body.city, 60), contact, text: `Заявка в женский круг · ${clean(body.city, 60)} · ${clean(body.meeting, 80)}` });
  const tg = user.username ? `@${user.username}` : `id ${user.id}`;
  await notifyAdmins({ text: `🌸 Заявка в женский круг\n${name} (${tg})\nКонтакт: ${contact}\nГород: ${clean(body.city, 60)}\nВстреча: ${clean(body.meeting, 80)}` });
  return send(res, 200, { ok: true });
};
