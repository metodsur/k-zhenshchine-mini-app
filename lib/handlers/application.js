// Applications from the app pages: the development paths (Партнёр / Мастер) and the expert form
// for the broadcast day (expert.html).
const store = require("../store");
const orders = require("../orders");
const crm = require("../crm");
const { send, readBody, telegramUser } = require("../http");
const { notifyAdmins } = require("../payments");

const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const KINDS = { partner: "Путь Партнёра", master: "Путь Мастера", expert: "Эксперт Дня эфиров" };
const STAGES = ["Целостность", "Наполнение", "Раскрытие многомерности", "Проявление"];
// Broadcast day: five 30-minute broadcasts one after another, Tuesdays 16:00–18:30 Moscow.
const SLOTS = ["16:00", "16:30", "17:00", "17:30", "18:00"];
const cleanText = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

// The expert form: answers, chosen slots and how many women she has invited.
async function expertFields(body, user) {
  const f = {
    about: cleanText(body.about, 1000), serve: cleanText(body.serve, 1000), experience: cleanText(body.experience, 1000),
    cases: cleanText(body.cases, 1000), levels_url: clean(body.levels_url, 300), topic: clean(body.topic, 200),
    stage: STAGES.includes(body.stage) ? body.stage : "", takeaway: cleanText(body.takeaway, 1000),
    product: cleanText(body.product, 600),
    slots: (Array.isArray(body.slots) ? body.slots : []).filter((x) => SLOTS.includes(x))
  };
  const errors = [];
  if (!f.about || !f.serve || !f.topic || !f.takeaway) errors.push("Ответь, пожалуйста, на все вопросы со звёздочкой");
  if (!f.stage) errors.push("Выбери этап пути, с которым связана тема");
  if (!/^https?:\/\/\S+$/.test(f.levels_url)) errors.push("Добавь ссылку на свою упаковку на «Уровнях»");
  if (!f.slots.length) errors.push("Выбери хотя бы один слот");
  if (body.values_ok !== true) errors.push("Отметь ценности пространства");
  let invited = null;
  try { invited = Number(await store.command("SCARD", `ref:invited:${user.id}`)) || 0; } catch { invited = null; }
  return { errors, fields: { ...f, invited } };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const body = readBody(req);
  const user = telegramUser(body);
  if (!user) return send(res, 401, { ok: false, error: "Откройте приложение из Telegram" });
  const kind = KINDS[body.kind] ? body.kind : null;
  const name = clean(body.name, 80) || (kind === "expert" ? clean([user.first_name, user.last_name].filter(Boolean).join(" "), 80) : "");
  const contact = clean(body.contact, 120) || (kind === "expert" && user.username ? `@${user.username}` : "");
  if (!kind) return send(res, 400, { ok: false, error: "Неизвестная заявка" });
  if (!name || !contact) return send(res, 400, { ok: false, error: "Укажите имя и контакт" });

  let expert = null;
  if (kind === "expert") {
    const checked = await expertFields(body, user);
    if (checked.errors.length) return send(res, 400, { ok: false, error: checked.errors[0], errors: checked.errors });
    expert = checked.fields;
  }

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
    ...(expert ? { expert } : {}),
    created_at: new Date().toISOString()
  };
  try { await store.command("LPUSH", "applications", JSON.stringify(application)); } catch { /* the alert below still goes out */ }
  await crm.safeTouch(user, { type: "application", interest: kind, city: application.city, contact, text: `Заявка: ${KINDS[kind]}${expert ? ` · «${expert.topic}»` : ""}${application.project ? ` · ${application.project}` : ""}${passed !== null ? ` · пройдено встреч: ${passed} из 6` : ""}` });
  const tg = user.username ? `@${user.username}` : `id ${user.id}`;
  const lines = [`🌟 Заявка: ${KINDS[kind]}`, `${name} (${tg})`, `Контакт: ${contact}`];
  if (application.city) lines.push(`Город: ${application.city}`);
  if (application.project) lines.push(`Проект: ${application.project}`);
  if (passed !== null) lines.push(`Пройдено встреч: ${passed} из 6`);
  if (expert) {
    lines.push(`Пригласила: ${expert.invited === null ? "—" : expert.invited} из 20`, "",
      `Тема: «${expert.topic}» · этап «${expert.stage}»`, `Слоты: ${expert.slots.join(", ")}`, `Уровни: ${expert.levels_url}`, "",
      `Кто она: ${expert.about}`, `Чем может служить пространству: ${expert.serve}`, `Что унесёт женщина: ${expert.takeaway}`);
    if (expert.experience) lines.push(`Опыт выступлений: ${expert.experience}`);
    if (expert.cases) lines.push(`Яркий кейс: ${expert.cases}`);
    lines.push(`Продукт в конце: ${expert.product || "нет"}`);
  }
  await notifyAdmins({ text: lines.join("\n").slice(0, 4000) });
  return send(res, 200, { ok: true });
};
