// Texts the bot sends about meetings. Plain text: admin-entered fields may contain any characters.
const schedule = require("./schedule");

const rub = (amount) => `${Number(amount).toLocaleString("ru-RU").replace(/ /g, " ")} ₽`;

function appUrl(path = "") {
  return `${String(process.env.APP_BASE_URL || "").replace(/\/$/, "")}/${path}`;
}

function meetingsButton(text = "Открыть встречи") {
  return { inline_keyboard: [[{ text, web_app: { url: appUrl("meetings.html") } }]] };
}

function place(m) {
  return [m.venue, m.address].filter(Boolean).join(", ");
}

function organizerLine(city) {
  const o = city.organizer || {};
  if (!o.name && !o.contact) return null;
  return `Организатор: ${[o.name, o.contact].filter(Boolean).join(" — ")}`;
}

function meetingBlock(city, mid, { withDetails }) {
  const m = city.meetings[mid];
  const lines = [`«${schedule.MEETINGS[mid].title}» — ${city.name}`, `📅 ${schedule.formatMeetingDate(m, city.timezone)}`];
  if (place(m)) lines.push(`📍 ${place(m)}`);
  if (withDetails) {
    lines.push("", "Что будет:", m.details || schedule.MEETINGS[mid].about);
    if (m.bring) lines.push("", "Что взять с собой:", m.bring);
  }
  return lines.join("\n");
}

function ticketMessage(order, city) {
  const parts = [];
  if (order.kind === "package") {
    parts.push("Оплата получена — ты с нами на полном пути из 6 встреч 🤍", "");
    for (const mid of schedule.MEETING_IDS) {
      const m = city.meetings[mid];
      const where = place(m) ? ` · ${place(m)}` : "";
      parts.push(`${mid}. ${schedule.MEETINGS[mid].title} — ${schedule.formatMeetingDate(m, city.timezone)}${where}`);
    }
    parts.push("", `Город: ${city.name}`, "За день до каждой встречи пришлём напоминание: что будет и что взять с собой.");
  } else {
    parts.push("Оплата получена — ты записана на встречу 🤍", "", meetingBlock(city, order.meeting, { withDetails: true }), "",
      "За день до встречи пришлём напоминание.");
  }
  const org = organizerLine(city);
  if (org) parts.push("", org);
  parts.push("", `Сумма: ${rub(order.amount)}`);
  return { text: parts.join("\n"), reply_markup: meetingsButton() };
}

function reminderMessage(city, mid) {
  const parts = ["Напоминаем: завтра встреча 🤍", "", meetingBlock(city, mid, { withDetails: true })];
  const org = organizerLine(city);
  if (org) parts.push("", org);
  return { text: parts.join("\n") };
}

function dateAnnouncedMessage(city, target) {
  if (target === "package") {
    return {
      text: `Открылась запись на полный путь из 6 встреч в городе ${city.name} 🤍\nПервая встреча — ${schedule.formatMeetingDate(city.meetings["1"], city.timezone)}.`,
      reply_markup: meetingsButton("Занять место")
    };
  }
  return {
    text: `Появилась дата встречи «${schedule.MEETINGS[target].title}» — ${city.name} 🤍\n📅 ${schedule.formatMeetingDate(city.meetings[target], city.timezone)}\nМеста уже можно занять.`,
    reply_markup: meetingsButton("Занять место")
  };
}

function adminPurchaseMessage(order) {
  const who = [order.name, order.username ? `@${order.username}` : null].filter(Boolean).join(" ") || `id ${order.user_id}`;
  const what = order.kind === "package" ? "пакет 6 встреч" : `встреча «${schedule.MEETINGS[order.meeting].title}»`;
  const contacts = [order.phone, order.email].filter(Boolean).join(", ");
  return { text: `💳 Новая оплата: ${who}\n${order.city_name}, ${what}\n${rub(order.amount)}${contacts ? `\nКонтакты: ${contacts}` : ""}` };
}

module.exports = { rub, ticketMessage, reminderMessage, dateAnnouncedMessage, adminPurchaseMessage, meetingsButton, appUrl };
