// One-off message on the launch day, 27.10.2026 at 10:05 Moscow (right after the 10:00 channel post) (text approved by the owner):
// to every woman with a CRM card from the bot who did not send /stop. The 9:00 morning cron
// schedules it through QStash; the 18:00 evening cron sends it if that call never came.
// Each woman gets it once, even if the run is repeated.
const { telegram } = require("./telegram");
const store = require("./store");

const DATE = "2026-10-27";
const SLOT = "10:05"; // five minutes after the pinned channel post with the visibility ritual
const BATCH = 25;
const K = { sent: "launch_dm:sent" };

const TEXT = "Мы начинаем историю «к Женщине» 🎉🤍\n\n"
  + "{имя}, мы так рады, что ты уже часть многомерного пространства ✨🌸\n\n"
  + "Сегодня открывается наш канал. Скорее заходи и пройди ритуал видимости: с него начинается твой путь 🫶💫\n\n"
  + "🏡 Женщина женщине — дом.";

const mskNow = (now) => new Date(now + 3 * 60 * 60 * 1000);
const appUrl = () => (process.env.APP_BASE_URL || "").replace(/\/$/, "");

function keyboard() {
  const rows = [];
  const channel = String(process.env.TELEGRAM_CHANNEL_URL || "").trim();
  if (channel) rows.push([{ text: "Перейти в канал 🌸", url: channel }]);
  rows.push([{ text: "Пройти ритуал видимости ✨", web_app: { url: `${appUrl()}/rituals.html` } }]);
  return { inline_keyboard: rows };
}

// Morning cron: on the launch day, a delayed call for 10:00 Moscow.
async function schedule(now = Date.now()) {
  if (mskNow(now).toISOString().slice(0, 10) !== DATE) return null;
  const at = Date.parse(`${DATE}T${SLOT}:00+03:00`);
  const seconds = Math.max(60, Math.ceil((at - now) / 1000));
  await require("./qstash").scheduleCall("/api/telegram/reminder", { kind: "launch_dm" }, `${seconds}s`);
  return { scheduled_in_s: seconds };
}

async function run(now = Date.now()) {
  const msk = mskNow(now).toISOString();
  if (msk.slice(0, 10) !== DATE) return { skipped: "not_launch_day" };
  if (msk.slice(11, 16) < SLOT) return { skipped: "early" };
  const crm = require("./crm");
  const audience = (await crm.listCards()).filter((c) => c.tg_id && !c.opt_out);
  const result = { recipients: audience.length, sent: 0, failed: 0 };
  const reply_markup = keyboard();
  for (let i = 0; i < audience.length; i += BATCH) {
    await Promise.all(audience.slice(i, i + BATCH).map(async (card) => {
      if (Number(await store.command("SADD", K.sent, String(card.tg_id))) !== 1) return;
      try {
        await telegram("sendMessage", { chat_id: card.tg_id, text: crm.fill(TEXT, card), reply_markup });
        result.sent += 1;
      } catch { result.failed += 1; }
    }));
    if (i + BATCH < audience.length) await new Promise((r) => setTimeout(r, 1000));
  }
  return result;
}

module.exports = { schedule, run, TEXT };
