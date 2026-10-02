// Admin team and roles. Owners come from ADMIN_TELEGRAM_IDS (cannot be removed from the app);
// the owner adds everyone else on the admin page.
const store = require("./store");
const { adminIds } = require("./http");

const TEAM_KEY = "team:v1";

const PERMISSIONS = {
  "schedule.edit": "Расписание встреч",
  "participants.view": "Кто записался и контакты",
  "analytics.view": "Аналитика",
  "events.edit": "События клуба",
  "prices.edit": "Цены",
  "cities.remove": "Удаление городов",
  "team.manage": "Команда и доступы",
  "settings.edit": "Ссылки в приложении",
  "alerts": "Уведомления об оплатах и заявках",
  "os.access": "Кабинет управления (на компьютере)",
  "crm.view": "CRM: просмотр",
  "crm.edit": "CRM: ведение карточек",
  "cycles.edit": "Циклы и календарь",
  "tasks.edit": "Задачи и блокеры",
  "content.edit": "Контент-производство",
  "media.edit": "Медийность",
  "library.edit": "Площадки и библиотека материалов",
  "os.workspace": "Кабинет: все разделы",
  "crm.broadcast": "Рассылки по базе",
  "attendance.mark": "Отметка присутствующих на встречах"
};

const ROLES = {
  owner: { label: "Владелец", perms: Object.keys(PERMISSIONS) },
  director: { label: "Операционный директор", perms: Object.keys(PERMISSIONS).filter((p) => p !== "team.manage") },
  analyst: { label: "Аналитика и расписание", perms: ["schedule.edit", "analytics.view"] },
  content: { label: "Контент-ассистент", perms: ["os.access", "os.workspace", "content.edit", "library.edit", "tasks.edit"] },
  master: { label: "Мастер", perms: ["os.access", "attendance.mark"] },
  manager: { label: "Менеджер встреч", perms: ["schedule.edit", "participants.view", "events.edit", "alerts", "os.access", "os.workspace", "crm.view", "crm.edit", "tasks.edit"] }
};
const ASSIGNABLE_ROLES = ["director", "analyst", "manager", "content", "master"];

async function loadTeam() {
  const raw = await store.command("GET", TEAM_KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

async function saveTeam(members) {
  await store.command("SET", TEAM_KEY, JSON.stringify(members));
  return members;
}

function withRole(member) {
  const role = ROLES[member.role];
  return role ? { ...member, role_label: role.label, perms: role.perms } : null;
}

// The team member behind a Telegram user id, with role and permissions, or null.
async function getMember(userId) {
  const id = String(userId);
  if (adminIds().includes(id)) return withRole({ id, name: ownerName(), role: "owner", fixed: true });
  let team = [];
  try { team = await loadTeam(); } catch { team = []; }
  const found = team.find((m) => String(m.id) === id);
  return found ? withRole(found) : null;
}

const ownerName = () => String(process.env.OWNER_NAME || "Варвара").trim();

// Team member by display name (used for "Ответственный" fields), case-insensitive.
async function memberByName(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  return (await listMembers()).find((m) => String(m.name || "").trim().toLowerCase() === n) || null;
}

const can = (member, perm) => Boolean(member && member.perms.includes(perm));

async function listMembers() {
  const owners = adminIds().map((id) => withRole({ id, name: ownerName(), role: "owner", fixed: true }));
  const team = (await loadTeam()).map(withRole).filter(Boolean);
  return [...owners, ...team.filter((m) => !adminIds().includes(String(m.id)))];
}

function normalizeTeam(input) {
  const errors = [];
  const seen = new Set(adminIds());
  const members = (Array.isArray(input) ? input : []).filter((m) => m && !m.fixed).map((m, i) => {
    const id = String(m.id == null ? "" : m.id).trim();
    const name = String(m.name == null ? "" : m.name).trim().slice(0, 80);
    const role = String(m.role || "");
    if (!/^\d{3,15}$/.test(id)) errors.push(`Строка ${i + 1}: Telegram ID — только цифры (его показывает бот по команде /admin)`);
    else if (seen.has(id)) errors.push(`Telegram ID ${id} указан дважды`);
    seen.add(id);
    if (!ASSIGNABLE_ROLES.includes(role)) errors.push(`Строка ${i + 1}: выберите роль`);
    return { id, name, role, added_at: m.added_at || new Date().toISOString() };
  });
  return { errors, members };
}

// Who gets bot alerts about payments and requests.
async function alertRecipients() {
  return (await listMembers()).filter((m) => can(m, "alerts")).map((m) => String(m.id));
}

module.exports = { memberByName, ownerName, PERMISSIONS, ROLES, ASSIGNABLE_ROLES, getMember, can, listMembers, loadTeam, saveTeam, normalizeTeam, alertRecipients };
