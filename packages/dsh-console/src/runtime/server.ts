// @3kaiu/dsh-console —— 事件库服务端(协议见 docs/09 §1-2)
// REST 回放 + WS 订阅 + 静态托管 console dist(默认 3090)。
// 事件源:DSH_HOME/state/events/{all.jsonl + seq}(dsh-runtime-events 写入)。
// 零框架:node:http + ws。两种运行形态:
//   - 插件形态:dsh web 进程内由 plugin.mjs(Cordis apply)加载
//   - 独立形态:bin dsh-console / node server.mjs(直接运行)
// 环境变量:
//   DSH_CONSOLE_PORT(默认 3090) DSH_HOME(默认 ~/.dsh)
//   DSH_CONSOLE_DIST(默认 packages/dsh-console/dist,相对本文件所在包)
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, extname, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.DSH_CONSOLE_PORT ?? 3090);
const DSH_HOME = process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
const MAINT_REPO = process.env.DSH_MAINT_REPO?.length > 0 ? process.env.DSH_MAINT_REPO : null;
const EVENTS_DIR = join(DSH_HOME, "state", "events");
const ALL_LOG = join(EVENTS_DIR, "all.jsonl");
const SEQ_FILE = join(EVENTS_DIR, "seq");
// 构建产物随包分发(dist/server.mjs)时,前端产物与 server 同目录;
// workbench 形态(dist 被 cp 到发行包根)时,前端产物在 ../dist。
const DEFAULT_DIST = existsSync(join(import.meta.dirname, "dist"))
  ? join(import.meta.dirname, "dist")
  : import.meta.dirname;
const DIST_DIR = resolve(process.env.DSH_CONSOLE_DIST ?? DEFAULT_DIST);
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
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (typeof e.seq !== "number") continue;
      if (e.seq <= since) continue;
      if (families !== null && !families.has(e.family)) continue;
      out.push(e);
      if (out.length >= cap) break;
    }
    return out;
  } catch { return []; }
}
/** 维护早报摘要(05 §6):当日各家族事件计数 + 最近 error 族。 */
function healthSummary() {
  const day = new Date().toISOString().slice(0, 10);
  const counts = {};
  let errors = 0;
  let errorLatest = null;
  try {
    if (existsSync(ALL_LOG)) {
      for (const line of readFileSync(ALL_LOG, "utf8").trim().split("\n").filter(Boolean)) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (String(e.at ?? e.ts ?? "").slice(0, 10) !== day) continue;
        counts[e.family] = (counts[e.family] ?? 0) + 1;
        if (e.family === "error") { errors++; errorLatest = e; }
      }
    }
  } catch {}
  return {
    date: day, counts, total: Object.values(counts).reduce((a, b) => a + b, 0),
    errors, errorLatest: errorLatest ? { seq: errorLatest.seq, message: errorLatest.message ?? errorLatest.detail ?? "" } : null,
    eventsDir: EVENTS_DIR, seq: readSeq(),
  };
}
//#endregion

//#region settings 代理:仅暴露插件配置面板的 4 个命名空间,防本地进程枚举/篡改官方配置
const UI_NS = new Set(["github-sync", "runtime-events", "dsh-console"]);
//#region 静态托管(simple,防目录穿越)
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2", ".map": "application/json",
};
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function serveStatic(req, res, urlPath) {
  // 畸形 % 编码会让 decodeURIComponent 抛 URIError;HTTP request listener 抛异常
  // = uncaughtException,会崩掉整个 console 进程(本地 DoS:任意能访问
  // 127.0.0.1:PORT 的进程发一个 /%zz 即可打死服务)。
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch {
    res.writeHead(400); res.end("bad request"); return;
  }
  if (rel === "/") rel = "/index.html";
  const file = normalize(join(DIST_DIR, rel));
  if (!file.startsWith(DIST_DIR)) { res.writeHead(403); res.end("forbidden"); return; }
  const path = existsSync(file) && statSync(file).isFile() ? file : join(DIST_DIR, "index.html"); // SPA 回退
  try {
    const st = statSync(path);
    const hit = staticCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(hit.body);
      return;
    }
    const body = readFileSync(path);
    staticCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, body });
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
}
const staticCache = new Map(); // file -> { mtimeMs, size, body }(dist 产物数量有限,无需淘汰)
//#endregion

/**
 * 创建 Console 服务(http + ws + 静态托管),返回 { server, port }。
 * 不自动 listen——由调用方决定(插件 apply 或独立 bin)。
 * @param {{ logger?: (msg: string) => void; port?: number; settings?: SettingsFace | null }} [opts]
 *   settings:插件形态传入 dsh-settings 服务(ctx.settings),供「插件配置」面板读写
 *  (settings.describe / settings.mutate,契约见 @deepseek-ai/dsh-settings)。
 */
export function createConsoleServer(opts = {}) {
  const logger = opts.logger ?? ((m) => console.log(m));
  const port = opts.port ?? PORT;
  const settings = opts.settings ?? null;

  //#region HTTP 路由
  const http = createServer(async (req, res) => {
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
    if (url.pathname === "/api/morning-report") {
      if (!MAINT_REPO) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "DSH_MAINT_REPO 未配置" })); return; }
      const p = join(MAINT_REPO, ".dsh", "state", "morning-report.md");
      if (!existsSync(p)) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "早报未生成:先跑 scripts/morning-report.mjs" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, markdown: readFileSync(p, "utf8"), generatedAt: statSync(p).mtime.toISOString() }));
      return;
    }
    if (url.pathname === "/api/settings/sections") {
      if (!settings) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "独立形态无 settings 服务" })); return; }
      const want = new Set((url.searchParams.get("ns") ?? "").split(",").filter(Boolean));
      try {
        const sections = settings.describe({ redactSecrets: true })
          .filter((d) => (want.size === 0 ? UI_NS.has(d.ns) : [...want].every((n) => UI_NS.has(n)) && want.has(d.ns)))
          .map((d) => ({ ns: d.ns, schema: d.schema, value: d.value, base: d.base, user: d.user, applies: d.applies, revision: d.revision }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sections }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: String((e as Error)?.message ?? e) }));
      }
      return;
    }
    if (url.pathname === "/api/settings/update" && req.method === "POST") {
      if (!settings) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "独立形态无 settings 服务" })); return; }
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "content-type 必须为 application/json" })); return;
      }
      let body;
      try { body = JSON.parse(String(req.headers["content-length"] ? await readBody(req) : "")); } catch { body = null; }
      const ns = typeof body?.ns === "string" && UI_NS.has(body.ns) ? body.ns : null;
      const ops = Array.isArray(body?.ops) ? body.ops : null;
      if (!ns || !ops) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "body 需 {ns, ops},且 ns 必须在插件配置白名单内" })); return; }
      try {
        await settings.mutate(ns, ops);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: String((e as Error)?.message ?? e) }));
      }
      return;
    }
    if (url.pathname.startsWith("/api/")) { res.writeHead(404); res.end(JSON.stringify({ error: "unknown api" })); return; }
    serveStatic(req, res, url.pathname);
  });
  //#endregion

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

  return { server: http, port };
}

//#region 独立运行形态(bin dsh-console / node server.mjs)
// 注意: import.meta.url 与 process.argv[1] 的符号链接规范化不一致
// (macOS 的 /tmp → /private/tmp 等),直接字符串比较会静默不启动;
// 两边都 realpath 后再比。
import { realpathSync } from "node:fs";
const isDirect =
  typeof process.argv[1] === "string" &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isDirect) {
  const { server, port } = createConsoleServer();
  server.listen(port, "127.0.0.1", () => {
    console.log("[dsh-console] http://127.0.0.1:" + port);
    console.log("[dsh-console] events:", EVENTS_DIR, "| dist:", DIST_DIR);
  });
}
//#endregion
