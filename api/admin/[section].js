const team = require("../../lib/team");
const events = require("../../lib/events");
const settings = require("../../lib/settings");
const { buildAnalytics } = require("../../lib/analytics");
const adminSchedule = require("../../lib/handlers/admin-schedule");
const { send, readBody, telegramUser } = require("../../lib/http");

const deny = (what) => ({ status: 403, body: { ok: false, error: `Нет доступа: ${what}` } });

const sections = {
  // Who am I and which tabs may I see.
  async me(member) {
    return { status: 200, body: { ok: true, id: member.id, role: member.role, role_label: member.role_label, perms: member.perms } };
  },
  schedule: (member, body) => adminSchedule.handle(member, body),
  async analytics(member) {
    if (!team.can(member, "analytics.view")) return deny("аналитика");
    return { status: 200, body: { ok: true, ...(await buildAnalytics()) } };
  },
  async events(member, body) {
    if (!team.can(member, "events.edit")) return deny("события клуба");
    if (body.action !== "save") return { status: 200, body: { ok: true, events: await events.loadEvents() } };
    const { errors, events: list } = events.normalizeEvents(body.events);
    if (errors.length) return { status: 400, body: { ok: false, errors } };
    return { status: 200, body: { ok: true, events: await events.saveEvents(list) } };
  },
  async settings(member, body) {
    if (!team.can(member, "settings.edit")) return deny("ссылки");
    if (body.action !== "save") return { status: 200, body: { ok: true, settings: await settings.loadSettings(), fields: settings.FIELDS, text_fields: settings.TEXT_FIELDS } };
    const { errors, settings: next } = settings.normalizeSettings(body.settings);
    if (errors.length) return { status: 400, body: { ok: false, errors } };
    return { status: 200, body: { ok: true, settings: await settings.saveSettings(next), fields: settings.FIELDS, text_fields: settings.TEXT_FIELDS } };
  },
  async team(member, body) {
    if (!team.can(member, "team.manage")) return deny("команда");
    const payload = async () => ({ ok: true, members: await team.listMembers(), roles: Object.fromEntries(team.ASSIGNABLE_ROLES.map((r) => [r, { label: team.ROLES[r].label, perms: team.ROLES[r].perms.map((p) => team.PERMISSIONS[p]) }])) });
    if (body.action !== "save") return { status: 200, body: await payload() };
    const { errors, members } = team.normalizeTeam(body.members);
    if (errors.length) return { status: 400, body: { ok: false, errors } };
    await team.saveTeam(members);
    return { status: 200, body: await payload() };
  }
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const section = sections[String((req.query && req.query.section) || "")];
  if (!section) return send(res, 404, { ok: false });
  const body = readBody(req);
  const user = telegramUser(body);
  if (!user) return send(res, 401, { ok: false, error: "Откройте страницу из Telegram" });
  const member = await team.getMember(user.id);
  if (!member) return send(res, 403, { ok: false, error: "Нет доступа", your_id: user.id });
  try {
    const result = await section(member, body);
    return send(res, result.status, result.body);
  } catch (error) {
    console.error("Admin section failed", error.message);
    return send(res, 500, { ok: false, error: "Не получилось. Попробуйте ещё раз." });
  }
};
