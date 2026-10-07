// Masters' money: referral links and earnings from offline meetings.
// Rule (set by Varvara): for every paid participant at every meeting of a cycle the Master leads
// she earns 3 500 ₽ when the woman came by her referral link, otherwise 2 500 ₽.
// Earned = the meeting has already taken place; expected = paid but not yet held. Club — no share.
const crypto = require("crypto");
const store = require("./store");
const cycles = require("./cycles");
const orders = require("./orders");
const masters = require("./masters");

const RATE_REFERRAL = 3500;
const RATE_SPACE = 2500;
const REF_PREFIX = "m_";
const codeKey = (code) => `ref:code:${code}`;
const startsKey = (masterId) => `ref:starts:${masterId}`;
const payoutsKey = (masterId) => `payouts:${masterId}`;

// Personal link code, created once per Master.
async function ensureCode(person) {
  if (person.ref_code) return person.ref_code;
  const code = crypto.randomBytes(4).toString("hex");
  await store.command("SET", codeKey(code), String(person.id));
  person.ref_code = code;
  await masters.savePerson(person);
  return code;
}

function refLink(code) {
  const bot = String(process.env.TELEGRAM_BOT_USERNAME || "K_zhenshcine_bot").replace(/^@/, "");
  return `https://t.me/${bot}?start=${REF_PREFIX}${code}`;
}

// /start m_<code>: the woman is attached to that Master (first link wins, never herself).
async function attach(userId, param) {
  if (!String(param || "").startsWith(REF_PREFIX)) return null;
  const masterId = await store.command("GET", codeKey(String(param).slice(REF_PREFIX.length)));
  if (!masterId || String(masterId) === String(userId)) return null;
  const master = await masters.getPerson(masterId);
  if (!master || master.status !== "master") return null;
  await store.command("SADD", startsKey(masterId), String(userId));
  const first = Number(await store.command("HSETNX", `user:${userId}`, "ref_master", String(masterId))) === 1;
  return { master, first };
}

const referrerOf = (userId) => store.command("HGET", `user:${userId}`, "ref_master");

// Every accrual line of one Master (or of all Masters when masterId is null).
async function accruals(masterId = null, now = Date.now()) {
  const [view, paid] = await Promise.all([cycles.overview(true), cycles.paidOrders()]);
  const led = view.cycles.filter((c) => c.master_id && (!masterId || c.master_id === String(masterId)));
  const byCycle = new Map(led.map((c) => [c.id, c]));
  const refCache = new Map();
  const lines = [];
  for (const o of paid) {
    const c = byCycle.get(o.cycle_id);
    if (!c) continue;
    const uid = String(o.user_id);
    if (!refCache.has(uid)) refCache.set(uid, await referrerOf(uid));
    const referral = refCache.get(uid) === c.master_id;
    for (const mid of orders.meetingsOf(o)) {
      const startIso = c.starts_at[Number(mid) - 1];
      const start = startIso ? new Date(startIso).getTime() : null;
      lines.push({
        master_id: c.master_id, cycle_id: c.id, cycle: `${c.city_name}${c.title ? ` · ${c.title}` : ""}`, meeting: mid,
        date: startIso, participant: o.name || (o.username ? `@${o.username}` : "Участница"),
        referral, amount: referral ? RATE_REFERRAL : RATE_SPACE,
        state: start !== null && start < now ? "earned" : "expected"
      });
    }
  }
  lines.sort((a, b) => String(b.date || "9").localeCompare(String(a.date || "9")));
  return lines;
}

async function loadPayouts(masterId) {
  const raw = await store.command("GET", payoutsKey(masterId));
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

async function addPayout(masterId, amount, note, by) {
  const sum = Math.round(Number(amount));
  if (!(sum > 0)) return { status: 400, errors: ["Укажите сумму выплаты"] };
  const list = await loadPayouts(masterId);
  list.push({ id: crypto.randomBytes(4).toString("hex"), amount: sum, note: String(note || "").trim().slice(0, 200), by, at: new Date().toISOString() });
  await store.command("SET", payoutsKey(masterId), JSON.stringify(list));
  return { status: 200 };
}

function summarize(lines, payouts) {
  const earned = lines.filter((l) => l.state === "earned").reduce((a, l) => a + l.amount, 0);
  const expected = lines.filter((l) => l.state === "expected").reduce((a, l) => a + l.amount, 0);
  const paid = payouts.reduce((a, p) => a + p.amount, 0);
  return { earned, expected, paid, due: Math.max(0, earned - paid) };
}

// Finance tab of one Master's cabinet.
async function forMaster(person, now = Date.now()) {
  const code = await ensureCode(person);
  const [lines, payouts, starts] = await Promise.all([accruals(person.id, now), loadPayouts(person.id), store.command("SCARD", startsKey(person.id))]);
  const referredBuyers = new Set(lines.filter((l) => l.referral).map((l) => l.participant)).size;
  return {
    rates: { referral: RATE_REFERRAL, space: RATE_SPACE },
    link: refLink(code),
    stats: { came: Number(starts) || 0, bought: referredBuyers },
    ...summarize(lines, payouts),
    lines: lines.slice(0, 200), payouts: payouts.slice().reverse(),
    payout_details: person.payout_details || ""
  };
}

// Dashboard: every Master with a balance.
async function overview(now = Date.now()) {
  const [people, lines] = await Promise.all([masters.listPeople(), accruals(null, now)]);
  const result = [];
  for (const p of people.filter((x) => x.status === "master")) {
    const own = lines.filter((l) => l.master_id === p.id);
    const payouts = await loadPayouts(p.id);
    result.push({ id: p.id, name: p.name, payout_details: p.payout_details || "", ...summarize(own, payouts), referral_lines: own.filter((l) => l.referral).length, lines: own.length, payouts: payouts.slice().reverse() });
  }
  return result.sort((a, b) => b.due - a.due || a.name.localeCompare(b.name, "ru"));
}

module.exports = { RATE_REFERRAL, RATE_SPACE, REF_PREFIX, ensureCode, refLink, attach, accruals, forMaster, overview, addPayout, loadPayouts };
