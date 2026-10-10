// Bot settings in Telegram: which updates reach the webhook, the command list and the menu button.
// Applied by /api/telegram/setup, by the owner's /setup command in the bot, and every morning,
// so new buttons and commands start working without anyone opening the setup page.
const { telegram } = require("./telegram");

const ALLOWED_UPDATES = ["message", "chat_member", "pre_checkout_query", "callback_query"];
const COMMANDS = [
  { command: "space", description: "Открыть пространство" },
  { command: "master", description: "Кабинет Мастера" },
  { command: "tasks", description: "Задачи команды" },
  { command: "task", description: "Новая задача (для команды)" },
  { command: "start", description: "Начать сначала" }
];

async function apply() {
  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!baseUrl || !secret || !process.env.TELEGRAM_BOT_TOKEN) return { ok: false, description: "Server configuration error" };
  const safe = (p) => p.then(() => ({ ok: true }), (error) => ({ ok: false, description: error.message }));
  const hook = await safe(telegram("setWebhook", { url: `${baseUrl}/api/telegram/webhook`, secret_token: secret, allowed_updates: ALLOWED_UPDATES }));
  const commands = await safe(telegram("setMyCommands", { commands: COMMANDS }));
  // The button opens the app root, which sends returning members straight to "Пространство".
  const menu = await safe(telegram("setChatMenuButton", { menu_button: { type: "web_app", text: "Пространство", web_app: { url: `${baseUrl}/` } } }));
  return { ok: Boolean(hook && hook.ok), description: (hook && hook.description) || null, commands: Boolean(commands && commands.ok), menu_button: Boolean(menu && menu.ok) };
}

// Owner-only "/setup" in a private chat with the bot.
async function handleCommand(message) {
  if (!message || message.chat?.type !== "private" || typeof message.text !== "string") return false;
  const isDelayTest = /^\/delaytest(@\w+)?(\s|$)/.test(message.text);
  if (!isDelayTest && !/^\/setup(@\w+)?(\s|$)/.test(message.text)) return false;
  const member = await require("./team").getMember(message.from && message.from.id);
  if (!member || member.role !== "owner") return false;
  // Owner check of delayed messages (QStash): a message should arrive in about a minute.
  if (isDelayTest) {
    let text;
    try {
      await require("./qstash").scheduleCall("/api/telegram/reminder", { kind: "ping", chatId: message.chat.id }, "60s");
      text = "Проверка отложенных сообщений запущена ⏳ Через минуту должно прийти «✅ Отложенные сообщения работают». Если не придёт — напишите об этом.";
    } catch (error) {
      text = `❌ Отложенные сообщения не настроены или не работают.\n${String(error.message || "").slice(0, 300)}`;
    }
    await telegram("sendMessage", { chat_id: message.chat.id, text });
    return true;
  }
  const result = await apply();
  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: result.ok
      ? "Готово ✅ Настройки бота обновлены: кнопки у задач и команда /tasks работают."
      : `Не получилось обновить настройки бота${result.description ? `: ${result.description}` : ""}. Попробуйте ещё раз через минуту.`
  });
  return true;
}

module.exports = { apply, handleCommand, ALLOWED_UPDATES, COMMANDS };
