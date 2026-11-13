const bridge = require("../../lib/content-factory");
const { send, readBody } = require("../../lib/http");

module.exports = async function handler(req, res) {
  // No endpoint (including diagnostics/downloads) is usable before explicit opt-in.
  if (!bridge.enabled()) return send(res, 404, { ok: false, error: "BRIDGE_DISABLED" });
  if (!bridge.authenticated(req)) return send(res, 403, { ok: false, error: "FORBIDDEN" });
  if (!["POST", "GET"].includes(req.method)) {
    res.setHeader("Allow", "POST, GET");
    return send(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }
  try {
    if (req.method === "GET") return await bridge.download(req, res);
    const body = readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some((key) => !["method", "payload"].includes(key))) {
      return send(res, 400, { ok: false, error: "INVALID_OPERATION" });
    }
    const result = await bridge.gateway(body.method, body.payload);
    return send(res, 200, { ok: true, result });
  } catch (error) {
    // Telegram errors / fetch causes may contain the token-bearing URL: never serialize or log them.
    if (res.headersSent || res.destroyed) { if (!res.writableEnded && !res.destroyed) res.end(); return; }
    return send(res, error.status || 502, {
      ok: false, error: error.code || "TELEGRAM_GATEWAY_FAILED",
      ...(error.code === "LARGE_FILE" || error.code === "TELEGRAM_FILE_UNAVAILABLE" ? { message: error.message } : {})
    });
  }
};
