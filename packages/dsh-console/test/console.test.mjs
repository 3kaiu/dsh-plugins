// @3kaiu/dsh-console 服务端测试:静态托管/防穿越/REST 回放/WS 推送(真实起服,零浏览器)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

// 模块级常量在 import 时读取 env → 必须动态 import(先设 env)
const home = mkdtempSync(join(tmpdir(), "dsh-console-test-"));
const eventsDir = join(home, "state", "events");
const distDir = join(home, "dist");
mkdirSync(eventsDir, { recursive: true });
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "index.html"), "<html><body>console-test</body></html>");
process.env.DSH_HOME = home;
process.env.DSH_CONSOLE_DIST = distDir;

const evt = (seq, family, type, at) => JSON.stringify({
  seq, schema: 1, eventId: "evt_test" + seq, family, type, at,
  source: "test", data: {},
});

const { createConsoleServer } = await import("../server.mjs");

function startServer() {
  const { server } = createConsoleServer({ port: 0, logger: () => {} });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("静态托管:GET / 返回 index.html,SPA 回退,未知路径不 404 穿透", async () => {
  const { server, port } = await startServer();
  try {
    const root = await fetch("http://127.0.0.1:" + port + "/");
    assert.equal(root.status, 200);
    assert.match(await root.text(), /console-test/);
    // SPA 回退:深层路径也返回 index.html
    const deep = await fetch("http://127.0.0.1:" + port + "/sessions/abc");
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /console-test/);
  } finally {
    server.close();
  }
});

test("目录穿越:../ 被拦截 403", async () => {
  const { server, port } = await startServer();
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/..%2f..%2fetc%2fpasswd");
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test("REST /api/events:回放 + since 过滤 + families 过滤", async () => {
  writeFileSync(join(eventsDir, "all.jsonl"), [evt(1, "session", "session.started", "2026-08-17T00:00:00Z"), evt(2, "test", "test.completed", "2026-08-17T00:00:01Z"), evt(3, "error", "error.raised", "2026-08-17T00:00:02Z")].join("\n") + "\n");
  writeFileSync(join(eventsDir, "seq"), "3");
  const { server, port } = await startServer();
  try {
    const all = await (await fetch("http://127.0.0.1:" + port + "/api/events")).json();
    assert.equal(all.seq, 3);
    assert.equal(all.events.length, 3);
    const since = await (await fetch("http://127.0.0.1:" + port + "/api/events?since=2")).json();
    assert.equal(since.events.length, 1);
    assert.equal(since.events[0].seq, 3);
    const fam = await (await fetch("http://127.0.0.1:" + port + "/api/events?families=test,session")).json();
    assert.deepEqual(fam.events.map((e) => e.family), ["session", "test"]);
    const bad = await (await fetch("http://127.0.0.1:" + port + "/api/nope")).json();
    assert.match(bad.error, /unknown api/);
  } finally {
    server.close();
  }
});

test("REST /api/health/summary:当日计数 + error 最新", async () => {
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(eventsDir, "all.jsonl"), [
    evt(1, "session", "session.started", today + "T01:00:00.000Z"),
    evt(2, "session", "session.completed", today + "T02:00:00.000Z"),
    evt(3, "error", "error.raised", today + "T03:00:00.000Z"),
    evt(4, "error", "error.raised", today + "T04:00:00.000Z"),
  ].join("\n") + "\n");
  writeFileSync(join(eventsDir, "seq"), "4");
  const { server, port } = await startServer();
  try {
    const s = await (await fetch("http://127.0.0.1:" + port + "/api/health/summary")).json();
    assert.equal(s.total, 4);
    assert.equal(s.counts.session, 2);
    assert.equal(s.counts.error, 2);
    assert.equal(s.errors, 2);
    assert.equal(s.errorLatest.seq, 4);
  } finally {
    server.close();
  }
});

test("WS:hello → subscribe backfill → 新事件推送(增量轮询)", async () => {
  writeFileSync(join(eventsDir, "all.jsonl"), [evt(1, "session", "session.started", "2026-08-17T00:00:00Z")].join("\n") + "\n");
  writeFileSync(join(eventsDir, "seq"), "1");
  const { server, port } = await startServer();
  try {
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/api/ws");
    const got = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.op === "hello") {
          assert.equal(msg.tokenRequired, false);
          ws.send(JSON.stringify({ op: "subscribe", families: ["session", "test"] }));
        } else if (msg.op === "event") {
          got.push(msg.event);
          if (got.length === 1) {
            // backfill 收到后,追加新事件 → 应推送
            appendFileSync(join(eventsDir, "all.jsonl"), evt(2, "test", "test.completed", "2026-08-17T01:00:00Z") + "\n");
            writeFileSync(join(eventsDir, "seq"), "2");
          } else if (got.length === 2) {
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        }
      });
      ws.on("error", reject);
    });
    assert.equal(got[0].seq, 1);
    assert.equal(got[0].family, "session");
    assert.equal(got[1].seq, 2);
    assert.equal(got[1].type, "test.completed");
  } finally {
    server.close();
  }
});

test("WS:subscribe 空 families → 全家族;ack 推进 since 不再重推", async () => {
  writeFileSync(join(eventsDir, "all.jsonl"), [evt(1, "session", "session.started", "2026-08-17T00:00:00Z")].join("\n") + "\n");
  writeFileSync(join(eventsDir, "seq"), "1");
  const { server, port } = await startServer();
  try {
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/api/ws");
    let events = 0;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.op === "hello") {
          ws.send(JSON.stringify({ op: "subscribe", families: [] })); // 空 → 全部
        } else if (msg.op === "event") {
          events++;
          if (events === 1) {
            // backfill 已到 → ack 已消费到 seq 1,之后不应重推
            ws.send(JSON.stringify({ op: "ack", since: 1 }));
            setTimeout(() => ws.close(), 1200);
          }
        }
      });
      ws.on("close", () => { clearTimeout(timer); resolve(); });
      ws.on("error", reject);
      setTimeout(() => ws.close(), 1200); // 等 1.2s:ack 后无新事件 → 不应再推
    });
    assert.equal(events, 1, "backfill 收到 1 条;ack since=1 后不再重推");
  } finally {
    server.close();
  }
});
