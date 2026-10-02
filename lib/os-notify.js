// Bot messages to team members when something is assigned to them in the dashboard.
const team = require("./team");
const { telegram } = require("./telegram");

async function notifyAssignee(ownerName, actor, text) {
  try {
    const member = await team.memberByName(ownerName);
    if (!member || !team.can(member, "os.access")) return false;
    if (actor && String(actor.id) === String(member.id)) return false;
    await telegram("sendMessage", { chat_id: member.id, text: `📌 ${text}\nНазначил(а): ${actor ? actor.name || actor.role_label : "система"}\nКабинет: /dashboard` });
    return true;
  } catch { return false; }
}

module.exports = { notifyAssignee };
