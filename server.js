// Node server for Timeweb Cloud Apps: serves the static pages the way Vercel did
// (clean URLs, no trailing slash, cache headers), runs the functions in api/ with the
// same req/res shape, and starts the two daily jobs that were Vercel crons.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 10 * 1024 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".woff": "font/woff", ".woff2": "font/woff2"
};

// Server code and repository files are never served as static files.
const PRIVATE = /^\/(api|lib|tests|node_modules|scripts)(\/|$)|^\/\.|^\/(server\.js|package(-lock)?\.json|Dockerfile|vercel\.json)$|\.md$/i;

// ---- functions (api/) ----

function loadRoutes() {
  const routes = [];
  (function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, `${prefix}/${entry.name}`); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const base = entry.name.slice(0, -3);
      const dynamic = /^\[(\w+)\]$/.exec(base);
      routes.push({ prefix, name: dynamic ? null : base, param: dynamic ? dynamic[1] : null, file: full });
    }
  })(path.join(ROOT, "api"), "/api");
  // Exact names win over [param] files in the same folder, as on Vercel.
  return routes.sort((a, b) => Number(Boolean(a.param)) - Number(Boolean(b.param)));
}

const routes = loadRoutes();

function matchRoute(pathname) {
  const clean = pathname.replace(/\/$/, "");
  const cut = clean.lastIndexOf("/");
  const dir = clean.slice(0, cut);
  const last = decodeURIComponent(clean.slice(cut + 1));
  for (const route of routes) {
    if (route.prefix !== dir) continue;
    if (route.name === last) return { route, params: {} };
    if (route.param && last) return { route, params: { [route.param]: last } };
  }
  return null;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("Body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Same body parsing as Vercel's Node runtime: JSON → object, form → object, text → string.
function parseBody(raw, type) {
  if (!raw.length) return undefined;
  const text = raw.toString("utf8");
  if (/application\/json/i.test(type)) {
    try { return JSON.parse(text); } catch { return text; }
  }
  if (/application\/x-www-form-urlencoded/i.test(type)) return Object.fromEntries(new URLSearchParams(text));
  if (/^text\//i.test(type)) return text;
  return raw;
}

async function runFunction(match, req, res, url) {
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  Object.assign(query, match.params);
  req.query = query;
  if (!["GET", "HEAD"].includes(req.method)) req.body = parseBody(await readRaw(req), req.headers["content-type"] || "");
  const handler = require(match.route.file);
  await (handler.default || handler)(req, res);
}

// ---- static files ----

function setStaticHeaders(res, pathname) {
  if (pathname.startsWith("/img/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  else if (pathname.startsWith("/audio/")) res.setHeader("Cache-Control", "public, max-age=604800");
  else if (pathname.endsWith(".html")) res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  else res.setHeader("Cache-Control", "public, max-age=3600");
}

function fileAt(rel) {
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep)) return null;
  try { const stat = fs.statSync(full); return stat.isFile() ? { full, stat } : null; } catch { return null; }
}

function redirect(res, location) {
  res.statusCode = 308;
  res.setHeader("Location", location);
  res.end();
}

function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
  if (pathname.length > 1 && pathname.endsWith("/")) return redirect(res, pathname.replace(/\/+$/, "") + url.search);
  if (pathname.endsWith(".html")) return redirect(res, (pathname === "/index.html" ? "/" : pathname.slice(0, -5)) + url.search);
  if (PRIVATE.test(pathname)) return notFound(res);
  const found = pathname === "/" ? fileAt("index.html") : (path.extname(pathname) ? fileAt(pathname) : fileAt(`${pathname}.html`) || fileAt(pathname));
  if (!found) return notFound(res);
  const type = TYPES[path.extname(found.full).toLowerCase()] || "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Last-Modified", found.stat.mtime.toUTCString());
  setStaticHeaders(res, pathname);
  const size = found.stat.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start < 0) start = 0;
    if (start > end || start >= size) { res.statusCode = 416; res.setHeader("Content-Range", `bytes */${size}`); return res.end(); }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(found.full, { start, end }).pipe(res);
  }
  res.statusCode = 200;
  res.setHeader("Content-Length", size);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(found.full).pipe(res);
}

function notFound(res) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not found");
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// Can the server reach what it depends on? Only yes/no, nothing else is shown.
async function checkDeps() {
  const timed = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(false), 8000))]).catch(() => false);
  const store = require("./lib/store");
  const [storage, telegram, qstash, tribute] = await Promise.all([
    timed(store.command("PING").then((r) => r === "PONG")),
    timed(fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`).then((r) => r.ok)),
    timed(fetch(`${String(process.env.QSTASH_URL || "https://qstash.upstash.io").replace(/\/$/, "")}/v2/topics`, { headers: { Authorization: `Bearer ${process.env.QSTASH_TOKEN}` } }).then((r) => r.status < 500)),
    timed(fetch("https://tribute.tg/api/v1/products", { headers: { "Api-Key": String(process.env.TRIBUTE_API_KEY || "") } }).then((r) => r.status < 500))
  ]);
  return { storage, telegram, qstash, tribute };
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") { res.setHeader("Content-Type", "text/plain"); return res.end("ok"); }
  if (url.pathname === "/healthz/deps") return sendJson(res, 200, await checkDeps());
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    const match = matchRoute(url.pathname);
    if (!match) return notFound(res);
    try {
      await runFunction(match, req, res, url);
    } catch (error) {
      console.error(`Function ${url.pathname} failed`, error && error.message);
      if (!res.headersSent) {
        res.statusCode = error && error.status ? error.status : 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false }));
      } else if (!res.writableEnded) res.end();
    }
    return;
  }
  if (!["GET", "HEAD"].includes(req.method)) { res.statusCode = 405; return res.end(); }
  serveStatic(req, res, url);
}

if (require.main === module) {
  http.createServer((req, res) => { handle(req, res); }).listen(PORT, () => console.log(`Listening on ${PORT}`));
  require("./lib/scheduler").start();
}

module.exports = { handle, matchRoute };
