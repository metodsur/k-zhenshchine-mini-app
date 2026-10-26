// VK community wall: the channel posts are repeated there.
// VK_GROUP_ID — the community id (digits; "club123" or "-123" also accepted),
// VK_GROUP_TOKEN — the community access key with the «wall» right. Without both, VK is off.
const API = "https://api.vk.com/method/";
const VERSION = "5.199";

const groupId = () => String(process.env.VK_GROUP_ID || "").replace(/^(-|club|public)/, "").trim();
const isConfigured = () => Boolean(groupId() && process.env.VK_GROUP_TOKEN);

async function vk(method, params) {
  const body = new URLSearchParams({ ...params, access_token: process.env.VK_GROUP_TOKEN, v: VERSION });
  const response = await fetch(`${API}${method}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const data = await response.json();
  if (data.error) throw new Error(`VK ${method}: ${data.error.error_msg || data.error.error_code}`);
  return data.response;
}

async function wallPost(message) {
  return vk("wall.post", { owner_id: `-${groupId()}`, from_group: "1", message });
}

module.exports = { isConfigured, wallPost };
