// Mini App API for the Masters cabinet (master-cabinet.html), the «Зеркало» booking page
// (mirror.html) and Master photos. Auth: Telegram initData.
const masters = require("../masters");
const collections = require("../os-collections");
const cycles = require("../cycles");
const crm = require("../crm");
const { telegram, isClubMember } = require("../telegram");
const { send, readBody, telegramUser } = require("../http");

const appUrl = (path) => `${String(process.env.APP_BASE_URL || "").replace(/\/$/, "")}/${path}`;
const cabinetButton = (text = "Открыть кабинет Мастера") => ({ inline_keyboard: [[{ text, web_app: { url: appUrl("master-cabinet.html") } }]] });

async function materialsFor(person) {
  const all = await collections.load("training");
  const allowed = person.status === "master" ? ["student", "master", "all", ""] : ["student", "all", ""];
  return all.filter((m) => allowed.includes(m.audience || "")).sort((a, b) => (a.module || "").localeCompare(b.module || "") || (Number(a.order) || 0) - (Number(b.order) || 0));
}

async function cabinet(user) {
  const person = await masters.getPerson(user.id);
  const trainings = await masters.loadTrainings();
  const onSale = trainings.filter((t) => t.sell && ["selling", "planned"].includes(t.status)).map((t) => ({ id: t.id, title: t.title, city: t.city, price: t.price, meetings: masters.MEETING_IDS.map((m) => masters.meetingLabel(t.meetings[m])) }));
  if (!person) return { ok: true, person: null, on_sale: onSale };
  const training = person.training_id ? trainings.find((t) => t.id === person.training_id) || null : null;
  const materials = await materialsFor(person);
  const view = { ok: true, on_sale: onSale, specialties: masters.SPECIALTIES, mirror_statuses: masters.MIRROR_STATUSES };
  view.person = { id: person.id, name: person.name, status: person.status, certified_at: person.certified_at, enrolled_at: person.enrolled_at, profile: person.profile, attendance: person.attendance || [], tasks: person.tasks || {} };
  view.training = training && {
    id: training.id, title: training.title, city: training.city, format: training.format, venue: training.venue, address: training.address,
    chat_url: training.chat_url, curator: training.curator, about: training.about,
    meetings: masters.MEETING_IDS.map((m) => ({ id: m, label: masters.meetingLabel(training.meetings[m]), date: training.meetings[m].date || null, attended: (person.attendance || []).includes(m) }))
  };
  view.materials = materials.map((m) => ({ id: m.id, title: m.title, audience: m.audience, module: m.module, kind: m.kind, url: m.url, text: m.text }));
  view.path = masters.pathOf(person, training, await collections.load("training"));
  if (person.status === "master") {
    view.mirror = await masters.listMirror(person.id);
    const groups = await cycles.overview(true, person.id);
    view.cycles = groups.cycles.map((c) => ({
      id: c.id, city_name: c.city_name, title: c.title, status: c.status, venue: c.venue, capacity: c.capacity,
      meetings: c.meetings, seats_by_meeting: c.seats_by_meeting,
      participants: c.participants.map((p) => ({ user_id: p.user_id, name: p.name, username: p.username, phone: p.phone, meetings: p.meetings, attended: p.attended }))
    }));
    view.card = masters.publicCard(person);
    view.finance = await require("../master-finance").forMaster(person);
  }
  return view;
}

async function masterAction(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const body = readBody(req);
  const user = telegramUser(body);
  if (!user) return send(res, 401, { ok: false, error: "Откройте кабинет из Telegram" });
  const action = body.action || "get";
  try {
    if (action === "get") return send(res, 200, await cabinet(user));
    const person = await masters.getPerson(user.id);
    if (!person) return send(res, 403, { ok: false, error: "Кабинет откроется после покупки обучения" });
    if (action === "task") {
      const ids = new Set((await collections.load("training")).map((m) => m.id));
      if (!ids.has(String(body.material_id))) return send(res, 400, { ok: false, error: "Задание не найдено" });
      await masters.markTask(user.id, String(body.material_id), Boolean(body.done), body.answer);
      return send(res, 200, await cabinet(user));
    }
    if (action === "profile") {
      await masters.saveProfile(user.id, body.profile);
      return send(res, 200, await cabinet(user));
    }
    if (person.status !== "master") return send(res, 403, { ok: false, error: "Доступно после получения статуса Мастера" });
    if (action === "payout_info") {
      const r = await require("../master-finance").savePayoutInfo(await masters.getPerson(user.id), body.payout);
      if (r.status !== 200) return send(res, r.status, { ok: false, error: r.errors.join(". ") });
      return send(res, 200, await cabinet(user));
    }
    if (action === "mirror_status") {
      const r = await masters.setMirrorStatus(String(body.id || ""), String(body.status || ""), user.id, body.note);
      if (r.status !== 200) return send(res, r.status, { ok: false, error: r.errors[0] });
      await tellClient(r.booking, person);
      return send(res, 200, await cabinet(user));
    }
    if (action === "attendance") {
      const own = (await cycles.loadCycles()).some((c) => c.id === body.cycle_id && c.master_id === String(user.id));
      if (!own) return send(res, 403, { ok: false, error: "Это не ваша группа" });
      const r = await cycles.markAttendance(String(body.cycle_id), String(body.meeting || ""), body.present);
      if (r.status !== 200) return send(res, r.status, { ok: false, error: r.errors[0] });
      return send(res, 200, await cabinet(user));
    }
    return send(res, 400, { ok: false, error: "Неизвестное действие" });
  } catch (error) {
    console.error("Master cabinet failed", error.message);
    return send(res, 500, { ok: false, error: "Не получилось. Попробуйте ещё раз." });
  }
}

async function tellClient(b, master) {
  const texts = {
    confirmed: `Мастер ${master.name} подтвердила твою запись на практику «Зеркало» 🤍${b.master_note ? `\n${b.master_note}` : ""}${master.profile.contact ? `\nКонтакт Мастера: ${master.profile.contact}` : ""}`,
    cancelled: `Мастер ${master.name}, к сожалению, не сможет провести «Зеркало» в этот раз.${b.master_note ? `\n${b.master_note}` : ""}\nВыбери, пожалуйста, другую Мастерицу — мы будем рады тебе 🤍`,
    done: `Спасибо, что прошла «Зеркало» с Мастером ${master.name} 🤍 Пусть увиденное раскрывается в тебе дальше.`
  };
  if (!texts[b.status]) return;
  const markup = b.status === "cancelled" ? { reply_markup: { inline_keyboard: [[{ text: "Выбрать Мастера", web_app: { url: appUrl("mirror.html") } }]] } } : {};
  try { await telegram("sendMessage", { chat_id: b.client_id, text: texts[b.status], ...markup }); } catch { /* she never started the bot */ }
  await crm.safeTouch({ id: b.client_id }, { type: "mirror", text: `«Зеркало» с ${master.name}: ${masters.MIRROR_STATUSES[b.status].toLowerCase()}` });
}

// Club side: list Masters, book «Зеркало» (club members only).
async function mirrorAction(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const body = readBody(req);
  const user = telegramUser(body);
  if (!user) return send(res, 401, { ok: false, error: "Откройте приложение из Telegram" });
  try {
    let member = false;
    try { member = await isClubMember(user.id); } catch { member = false; }
    if (!member) { try { member = Boolean(await require("../team").getMember(user.id)); } catch { /* not team */ } }
    if (body.action !== "book") {
      const mine = (await masters.listMirror()).filter((b) => b.client_id === String(user.id)).slice(0, 5)
        .map((b) => ({ id: b.id, master_name: b.master_name, status: b.status, status_label: masters.MIRROR_STATUSES[b.status], created_at: b.created_at }));
      return send(res, 200, { ok: true, club_member: member, masters: await masters.publicMasters(), bookings: mine });
    }
    if (!member) return send(res, 403, { ok: false, error: "Запись на «Зеркало» — для участниц клуба" });
    const r = await masters.createMirror({ client: user, masterId: String(body.master_id || ""), wish: body.wish, format: body.format, contact: body.contact, comment: body.comment });
    if (r.status !== 200) return send(res, r.status, { ok: false, error: r.errors[0] });
    const b = r.booking;
    const tg = b.username ? ` (@${b.username})` : "";
    try {
      await telegram("sendMessage", {
        chat_id: b.master_id,
        text: [`🪞 Новая запись на «Зеркало»`, `${b.client_name || "Участница клуба"}${tg}`, b.wish ? `Когда удобно: ${b.wish}` : null, `Формат: ${b.format === "offline" ? "офлайн" : "онлайн"}`, `Контакт: ${b.contact}`, b.comment ? `Комментарий: ${b.comment}` : null].filter(Boolean).join("\n"),
        reply_markup: cabinetButton("Открыть записи")
      });
    } catch { /* the Master never started the bot */ }
    await crm.safeTouch(user, { type: "mirror", interest: "club", contact: b.contact, text: `Записалась на «Зеркало» к Мастеру ${b.master_name}` });
    return send(res, 200, { ok: true, booking: { id: b.id, master_name: b.master_name, status: b.status } });
  } catch (error) {
    console.error("Mirror booking failed", error.message);
    return send(res, 500, { ok: false, error: "Не получилось записаться. Попробуйте ещё раз." });
  }
}

// Photo of a certified Master (sent to the bot), proxied so the bot token never reaches the browser.
async function photoAction(req, res) {
  const id = String((req.query && req.query.id) || "");
  const person = await masters.getPerson(id).catch(() => null);
  if (!person || person.status !== "master" || !person.profile.photo_file_id) { res.statusCode = 404; return res.end(); }
  try {
    const file = await telegram("getFile", { file_id: person.profile.photo_file_id });
    const response = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    if (!response.ok) throw new Error("photo");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
    return res.end(buffer);
  } catch { res.statusCode = 404; return res.end(); }
}

// Bot: /master opens the cabinet; a photo sent by a student or Master becomes her card photo.
async function handleBot(message) {
  if (!message || !message.chat || message.chat.type !== "private" || !message.from) return false;
  if (typeof message.text === "string" && /^\/master(@\w+)?(\s|$)/.test(message.text)) {
    const person = await masters.getPerson(message.from.id);
    if (person) {
      await telegram("sendMessage", { chat_id: message.chat.id, text: person.status === "master" ? "Кабинет Мастера многомерности 🤍 Записи на «Зеркало», твои группы и карточка — внутри." : "Твой кабинет ученицы обучения Мастеров 🤍 Расписание, материалы, задания и путь к статусу Мастера — внутри.", reply_markup: cabinetButton() });
    } else {
      await telegram("sendMessage", { chat_id: message.chat.id, text: "Кабинет Мастера доступен тем, кто оплатил обучение Мастеров многомерности 🤍\nУзнать о пути Мастера и записаться на обучение можно в приложении: раздел «Встречи» → «Стать Мастером».", reply_markup: { inline_keyboard: [[{ text: "Открыть «Встречи»", web_app: { url: appUrl("meetings.html#become-master") } }]] } });
    }
    return true;
  }
  if (Array.isArray(message.photo) && message.photo.length) {
    const person = await masters.getPerson(message.from.id);
    if (!person) return false;
    const best = message.photo[message.photo.length - 1];
    await masters.setPhoto(message.from.id, best.file_id);
    await telegram("sendMessage", { chat_id: message.chat.id, text: "Фото для карточки Мастера обновлено ✨ Посмотреть карточку — в кабинете.", reply_markup: cabinetButton() });
    return true;
  }
  return false;
}

// Morning: students get a reminder the day before a training meeting.
async function runTrainingReminders(now = Date.now()) {
  const store = require("../store");
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now + 864e5));
  const [trainings, people] = await Promise.all([masters.loadTrainings(), masters.listPeople()]);
  let sent = 0;
  for (const t of trainings) {
    for (const mid of masters.MEETING_IDS) {
      if (t.meetings[mid].date !== tomorrow) continue;
      for (const p of people.filter((x) => x.training_id === t.id)) {
        if (!(await store.claimOnce(`training-remind:${p.id}:${t.id}:${mid}`, 7 * 86400))) continue;
        try {
          await telegram("sendMessage", { chat_id: p.id, text: [`Завтра — встреча ${mid} из 3 обучения Мастеров 🤍`, masters.meetingLabel(t.meetings[mid]), [t.venue, t.address].filter(Boolean).join(", ") || null].filter(Boolean).join("\n"), reply_markup: cabinetButton() });
          sent += 1;
        } catch { /* never started the bot */ }
      }
    }
  }
  return { sent };
}

module.exports = { masterAction, mirrorAction, photoAction, handleBot, runTrainingReminders, cabinet };
