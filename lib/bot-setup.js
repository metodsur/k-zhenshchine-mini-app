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
  const fixPinned = /^\/fixpinned(@\w+)?\s*$/.test(message.text);
  const fixButton = message.text.match(/^\/fixbutton(?:@\w+)?\s+(\S+)\s+(https:\/\/\S+)(?:\s+(.+))?$/s);
  const fixPost = message.text.match(/^\/fixpost(?:@\w+)?\s+(\S+)\s+(\d{1,2}:\d{2})(?:\s+(\d{4}-\d{2}-\d{2}))?\s*$/);
  const fixBare = message.text.match(/^\/fix(post|button)(?:@\w+)?(\s|$)/);
  const fixHint = !fixButton && !fixPost && fixBare ? fixBare[1] : null;
  const posts = message.text.match(/^\/posts(?:@\w+)?(?:\s+(\d{4}-\d{2}-\d{2}))?\s*$/);
  if (!isDelayTest && !posts && !fixPinned && !fixButton && !fixPost && !fixHint && !/^\/setup(@\w+)?(\s|$)/.test(message.text)) return false;
  const member = await require("./team").getMember(message.from && message.from.id);
  // /posts [ГГГГ-ММ-ДД]: owner and director see the channel posts of a day (tomorrow by default).
  if (posts) {
    if (!member || !require("./team").can(member, "tasks.review")) return false;
    const channel = require("./channel-posts");
    const date = posts[1] || channel.mskDate(Date.now() + 24 * 60 * 60 * 1000);
    await channel.preview(message.chat.id, date);
    return true;
  }
  if (!member || member.role !== "owner") return false;
  // /fixbutton <ссылка на пост канала> <куда ведёт кнопка> [текст кнопки]
  if (fixButton) {
    const id = Number((fixButton[1].match(/(\d+)\/?(?:\?.*)?$/) || [])[1]);
    let text;
    if (!id) text = "Не нашла номер поста в ссылке. Скопируйте ссылку на пост в канале («Копировать ссылку») 🤍";
    else {
      try {
        await require("./channel-posts").setButton(id, fixButton[2], fixButton[3] && fixButton[3].trim());
        text = `Готово ✅ Кнопка поста теперь ведёт на ${fixButton[2]}`;
      } catch (error) {
        text = `Не получилось поменять кнопку: ${String(error.message || "").slice(0, 200)}`;
      }
    }
    await telegram("sendMessage", { chat_id: message.chat.id, text, link_preview_options: { is_disabled: true } });
    return true;
  }
  // /fixpost or /fixbutton without what they need: show how to write it.
  if (fixHint) {
    const text = fixHint === "post"
      ? "Напишите одним сообщением: /fixpost, ссылку на пост и время его выхода 🤍\nНапример: /fixpost https://t.me/k_zhenshcine/12 10:00\n\nСсылка: нажмите на пост в канале → «Копировать ссылку»."
      : "Напишите одним сообщением: /fixbutton, ссылку на пост и куда должна вести кнопка 🤍\nНапример: /fixbutton https://t.me/k_zhenshcine/7 https://t.me/k_zhenshcine/9";
    await telegram("sendMessage", { chat_id: message.chat.id, text, link_preview_options: { is_disabled: true } });
    return true;
  }
  // /fixpost <ссылка на пост канала> <ЧЧ:ММ> [ГГГГ-ММ-ДД]: a post of the bot that went out with buttons is
  // rewritten with the links in the text (buttons hide the comments). The date is today by default.
  if (fixPost) {
    const id = Number((fixPost[1].match(/(\d+)\/?(?:\?.*)?$/) || [])[1]);
    const channel = require("./channel-posts");
    const slot = fixPost[2].padStart(5, "0");
    let text;
    if (!id) text = "Не нашла номер поста в ссылке. Скопируйте ссылку на пост в канале («Копировать ссылку») 🤍";
    else {
      try {
        const r = await channel.rewrite(id, fixPost[3] || channel.mskDate(Date.now()), slot);
        text = r.ok ? "Готово ✅ Кнопки теперь ссылками в тексте поста, комментарии снова видны 🤍" : `На ${fixPost[3] || "сегодня"} в ${slot} поста в плане нет 🤍`;
      } catch (error) {
        text = `Не получилось обновить пост: ${String(error.message || "").slice(0, 200)}`;
      }
    }
    await telegram("sendMessage", { chat_id: message.chat.id, text });
    return true;
  }
  // /fixpinned: the pinned ritual post in the channel gets the current buttons.
  if (fixPinned) {
    let text;
    try {
      const r = await require("./channel-posts").refreshPinned();
      const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
      text = !r.ok ? (r.reason === "no_pinned" ? "В канале нет закреплённого поста 🤍" : "Закреплён не пост с ритуалом видимости, его кнопки я не трогаю 🤍")
        : r.direct ? "Готово ✅ Кнопка закреплённого поста теперь сразу открывает ритуал в приложении ✨"
        : `Готово ✅ Кнопка обновлена и ведёт через бот к ритуалу.\n\nЧтобы кнопки сразу открывали приложение, без лишнего шага: @BotFather → ваш бот → Bot Settings → Configure Mini App → Enable Mini App, адрес ${base}/ . Потом снова отправьте /fixpinned 🤍`;
    } catch (error) {
      text = `Не получилось обновить кнопку: ${String(error.message || "").slice(0, 200)}`;
    }
    await telegram("sendMessage", { chat_id: message.chat.id, text });
    return true;
  }
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
