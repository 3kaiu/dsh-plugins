// @3kaiu/dsh-console —— 事件库服务端(协议见 docs/09 §1-2)
// REST 回放 + WS 订阅 + 静态托管 console dist(默认 3090)。
// 事件源:DSH_HOME/state/events/{all.jsonl + seq}(dsh-runtime-events 写入)。
// 零框架:node:http + ws。环境变量:
//   DSH_CONSOLE_PORT(默认 3090) DSH_HOME(默认 ~/.dsh)
//   DSH_CONSOLE_DIST(默认 packages/dsh-console/dist,相对本文件所在包)
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, extname, normalize, resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.DSH_CONSOLE_PORT ?? 3090);
const DSH_HOME = process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
const EVENTS_DIR = join(DSH_HOME, "state", "events");
const ALL_LOG = join(EVENTS_DIR, "all.jsonl");
const SEQ_FILE = join(EVENTS_DIR, "seq");
const DIST_DIR = resolve(process.env.DSH_CONSOLE_DIST ?? join(import.meta.dirname, "dist"));
const FAMILIES = new Set(["session", "tool", "error", "test", "completion"]);

//#region 事件库
function readSeq() {
  try { return Number(readFileSync(SEQ_FILE, "utf8")) || 0; } catch { return 0; }
}
/** 读取 all.jsonl 中 seq > since 的事件(上限 cap 条,按需过滤家族)。 */
function readEventsSince(since, families, cap = 2000) {
  try {
    if (!existsSync(ALL_LOG)) return [];
    const lines = readFileSync(ALL_LOG, "utf8").trim().split("\n").filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e.seq > since && (families === null || families.has(e.family))) out.unshift(e);
    }
    return out;
  } catch { return []; }
}
function healthSummary() {
  const seq = readSeq();
  let count = 0;
  try { if (existsSync(ALL_LOG)) count = readFileSync(ALL_LOG, "utf8").split("\n").filter(Boolean).length; } catch {}
  const families = {};
  for (const f of FAMILIES) {
    try {
      const p = join(EVENTS_DIR, f + ".jsonl");
      families[f] = existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0;
    } catch { families[f] = 0; }
  }
  return { seq, count, families, eventsDir: EVENTS_DIR, server: "dsh-console", at: new Date().toISOString() };
}
//#endregion

//#region 静态托管(simple,防目录穿越)
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2", ".map": "application/json",
};
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/") rel = "/index.html";
  const file = normalize(join(DIST_DIR, rel));
  if (!file.startsWith(DIST_DIR)) { res.writeHead(403); res.end("forbidden"); return; }
  const path = existsSync(file) && statSync(file).isFile() ? file : join(DIST_DIR, "index.html"); // SPA 回退
  try {
    const body = readFileSync(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
}
//#endregion

//#region HTTP 路由
const http = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/events") {
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    const familiesRaw = url.searchParams.get("families");
    const families = familiesRaw ? new Set(familiesRaw.split(",").filter((f) => FAMILIES.has(f))) : null;
    const events = readEventsSince(since, families);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ seq: readSeq(), events }));
    return;
  }
  if (url.pathname === "/api/health/summary") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(healthSummary()));
    return;
  }
  if (url.pathname.startsWith("/api/")) { res.writeHead(404); res.end(JSON.stringify({ error: "unknown api" })); return; }
  serveStatic(req, res, url.pathname);
});

//#region WS:协议 ops = hello/pong/event/ack
const wss = new WebSocketServer({ server: http, path: "/api/ws" });
const clients = new Set(); // { ws, since, families, lastAckAt, timer }

function pushLine(client, line) {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.seq <= client.since) return;
  if (client.families !== null && !client.families.has(e.family)) return;
  client.since = e.seq;
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ op: "event", event: e }));
}

wss.on("connection", (ws) => {
  const client = { ws, since: 0, families: new Set(FAMILIES), timer: null, lastAckAt: Date.now() };
  clients.add(client);
  ws.send(JSON.stringify({ op: "hello", tokenRequired: false, seq: readSeq(), eventsDir: EVENTS_DIR }));
  // 心跳:30s ping
  const hb = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30000);
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.op === "subscribe") {
      client.families = Array.isArray(msg.families) && msg.families.length > 0
        ? new Set(msg.families.filter((f) => FAMILIES.has(f)))
        : new Set(FAMILIES);
      // 订阅时先把已落后的事件补推(回放窗口 1024)
      const backfill = readEventsSince(client.since, client.families, 1024);
      for (const e of backfill) if (e.seq > client.since) { client.since = e.seq; ws.send(JSON.stringify({ op: "event", event: e })); }
    } else if (msg.op === "pong") {
      client.lastAckAt = Date.now();
    } else if (msg.op === "ack") {
      client.lastAckAt = Date.now();
      if (typeof msg.since === "number") client.since = msg.since;
    }
  });
  // 增量轮询:all.jsonl 追加即推(300ms 粒度足够本地场景)
  client.timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      if (!existsSync(ALL_LOG)) return;
      const lines = readFileSync(ALL_LOG, "utf8").trim().split("\n").filter(Boolean);
      for (const line of lines) pushLine(client, line);
    } catch {}
  }, 300);
  ws.on("close", () => { clearInterval(hb); if (client.timer) clearInterval(client.timer); clients.delete(client); });
  ws.on("error", () => {});
});
//#endregion

http.listen(PORT, "127.0.0.1", () => {
  console.log("[dsh-console] http://127.0.0.1:" + PORT);
  console.log("[dsh-console] events:", EVENTS_DIR, "| dist:", DIST_DIR);
});
