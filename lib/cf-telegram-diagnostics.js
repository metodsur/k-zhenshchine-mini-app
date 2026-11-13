// Opt-in Content Factory telemetry only. Constructed records never contain raw exception data.
const METHODS = new Set(['getMe', 'getFile', 'getWebhookInfo', 'sendMessage', 'sendVideo', 'sendDocument', 'answerCallbackQuery']);
const PHASES = new Set(['fetch', 'json', 'api', 'stream']);
const CLASSES = new Set(['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'AggregateError']);
const CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max ? n : null;
function record(method, route, meta, error) {
  const codes = new Set(), queue = error ? [error] : [];
  for (let i = 0; i < 12 && queue.length; i++) {
    const item = queue.shift();
    if (!item || typeof item !== 'object') continue;
    if (item.code !== undefined) codes.add(CODES.has(item.code) ? item.code : 'OTHER');
    if (item.cause && item.cause !== item) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors.slice(0, 4));
  }
  return {
    event: 'cf.telegram.failure', method: METHODS.has(method) ? method : 'OTHER',
    route: route === 'local' ? 'local' : 'cloud', phase: PHASES.has(meta?.phase) ? meta.phase : 'fetch',
    elapsedMs: integer(meta?.elapsedMs, 0, 3600000), upstreamStatus: integer(meta?.upstreamStatus, 100, 599),
    apiErrorCode: integer(meta?.apiErrorCode, 100, 599),
    exceptionClass: CLASSES.has(error?.name) ? error.name : 'OTHER', transportCodes: [...codes],
  };
}
function report(method, route, meta, error) { console.warn(JSON.stringify(record(method, route, meta, error))); }
module.exports = { record, report };
