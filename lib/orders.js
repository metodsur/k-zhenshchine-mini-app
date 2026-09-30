// Meeting orders and the waitlist, stored in Redis.
const crypto = require("crypto");
const store = require("./store");
const schedule = require("./schedule");

const orderKey = (id) => `order:${id}`;
const userOrdersKey = (userId) => `user_orders:${userId}`;
const waitlistKey = (cityId, target) => `waitlist:${cityId}:${target}`;
const PENDING_TTL_SECONDS = 2 * 24 * 60 * 60;

function meetingsOf(order) {
  return order.kind === "package" ? schedule.MEETING_IDS.slice() : [order.meeting];
}

async function createPendingOrder({ user, city, kind, meeting, amount }) {
  const order = {
    id: crypto.randomBytes(9).toString("hex"),
    status: "pending",
    kind, meeting: kind === "package" ? null : meeting,
    city_id: city.id, city_name: city.name,
    amount,
    user_id: user.id,
    name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
    username: user.username || null,
    created_at: new Date().toISOString()
  };
  await store.command("SET", orderKey(order.id), JSON.stringify(order), "EX", PENDING_TTL_SECONDS);
  return order;
}

async function getOrder(id) {
  if (!/^[a-f0-9]{18}$/.test(String(id))) return null;
  const raw = await store.command("GET", orderKey(id));
  return raw ? JSON.parse(raw) : null;
}

// Returns { order, firstTime } — Telegram may deliver the same payment update twice.
async function markPaid(id, payment) {
  const order = await getOrder(id);
  if (!order) return { order: null, firstTime: false };
  if (order.status === "paid") return { order, firstTime: false };
  const paid = {
    ...order, status: "paid", paid_at: new Date().toISOString(),
    telegram_charge_id: payment.telegram_payment_charge_id || null,
    provider_charge_id: payment.provider_payment_charge_id || null,
    email: (payment.order_info && payment.order_info.email) || null,
    phone: (payment.order_info && payment.order_info.phone_number) || null
  };
  await store.command("SET", orderKey(id), JSON.stringify(paid));
  await Promise.all(meetingsOf(paid).map((mid) => store.command("SADD", schedule.ticketsKey(paid.city_id, mid), paid.id)));
  await store.command("SADD", userOrdersKey(paid.user_id), paid.id);
  return { order: paid, firstTime: true };
}

async function ordersFor(cityId, meetingId) {
  const ids = (await store.command("SMEMBERS", schedule.ticketsKey(cityId, meetingId))) || [];
  if (!ids.length) return [];
  const raws = await store.command("MGET", ...ids.map(orderKey));
  return (raws || []).filter(Boolean).map((raw) => JSON.parse(raw));
}

async function userOrders(userId) {
  const ids = (await store.command("SMEMBERS", userOrdersKey(userId))) || [];
  if (!ids.length) return [];
  const raws = await store.command("MGET", ...ids.map(orderKey));
  return (raws || []).filter(Boolean).map((raw) => JSON.parse(raw)).filter((o) => o.status === "paid");
}

// ---------- waitlist ("tell me when the date appears") ----------

async function joinWaitlist(cityId, target, userId) {
  return store.command("SADD", waitlistKey(cityId, target), userId);
}

async function waitlistSize(cityId, target) {
  return Number(await store.command("SCARD", waitlistKey(cityId, target))) || 0;
}

async function takeWaitlist(cityId, target) {
  const ids = (await store.command("SMEMBERS", waitlistKey(cityId, target))) || [];
  if (ids.length) await store.command("DEL", waitlistKey(cityId, target));
  return ids;
}

module.exports = {
  createPendingOrder, getOrder, markPaid, ordersFor, userOrders, meetingsOf,
  joinWaitlist, waitlistSize, takeWaitlist
};
