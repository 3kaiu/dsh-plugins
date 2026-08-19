// @3kaiu/dsh-harness-updater 单元测试:registry 版本检测 + macOS 原生通知(mock fetch/execFile/platform)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLatest } from "../dist/index.js";

const REGISTRY_URL = "https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function mkCtx() {
  const logs = { info: [], warn: [] };
  return { logger: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) }, logs };
}

/** 隔离 DSH_HOME,返回 { dir, stateFile } */
function isoHome() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-updater-test-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  return { dir, stateFile: join(dir, "state", "dsh-update.json") };
}

test("新版本 + darwin → 弹 macOS 通知并记录 lastNotified", async () => {
  const { dir, stateFile } = isoHome();
  process.env.DSH_HOME = dir;
  let notified = null;
  const c = mkCtx();
  await checkLatest(c, {
    platform: "darwin",
    fetch: async () => jsonResponse({ version: "9.9.9" }),
    execFile: (cmd, args, cb) => { notified = { cmd, args }; cb(null); },
  });
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(notified?.cmd, "osascript");
  assert.ok(notified.args[1].includes('display notification "发现 v9.9.9'));
  assert.equal(state.lastNotified, "9.9.9");
  assert.ok(c.logs.info.some((m) => m.includes("notification sent")));
  rmSync(dir, { recursive: true, force: true });
});

test("已通知过的版本 → 不重复弹窗(幂等)", async () => {
  const { dir, stateFile } = isoHome();
  process.env.DSH_HOME = dir;
  writeFileSync(stateFile, JSON.stringify({ lastNotified: "9.9.9" }));
  let calls = 0;
  const c = mkCtx();
  await checkLatest(c, {
    platform: "darwin",
    fetch: async () => jsonResponse({ version: "9.9.9" }),
    execFile: (cmd, args, cb) => { calls += 1; cb(null); },
  });
  assert.equal(calls, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("非 macOS 平台 → 不弹通知", async () => {
  const { dir } = isoHome();
  process.env.DSH_HOME = dir;
  let calls = 0;
  const c = mkCtx();
  await checkLatest(c, {
    platform: "linux",
    fetch: async () => jsonResponse({ version: "9.9.8" }),
    execFile: (cmd, args, cb) => { calls += 1; cb(null); },
  });
  assert.equal(calls, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("osascript 参数转义:版本号含引号/反斜杠不破坏脚本", async () => {
  const { dir } = isoHome();
  process.env.DSH_HOME = dir;
  let script = null;
  const c = mkCtx();
  await checkLatest(c, {
    platform: "darwin",
    fetch: async () => jsonResponse({ version: '1.0"\\evil' }),
    execFile: (cmd, args, cb) => { script = args[1]; cb(null); },
  });
  assert.ok(script.includes('\\"') && script.includes("\\\\"));
  rmSync(dir, { recursive: true, force: true });
});

test("registry 失败(503)→ warn 且不弹通知、不写状态", async () => {
  const { dir, stateFile } = isoHome();
  process.env.DSH_HOME = dir;
  let calls = 0;
  const c = mkCtx();
  await checkLatest(c, {
    platform: "darwin",
    fetch: async () => jsonResponse({ error: "boom" }, 503),
    execFile: (cmd, args, cb) => { calls += 1; cb(null); },
  });
  assert.equal(calls, 0);
  assert.ok(c.logs.warn.length > 0);
  assert.throws(() => readFileSync(stateFile, "utf8"), /ENOENT/);
  rmSync(dir, { recursive: true, force: true });
});

test("fetch 注入校验:收到 registry URL", async () => {
  const { dir } = isoHome();
  process.env.DSH_HOME = dir;
  const c = mkCtx();
  await checkLatest(c, {
    fetch: async (url) => { assert.equal(url, REGISTRY_URL); return jsonResponse({ version: "x" }); },
  });
  rmSync(dir, { recursive: true, force: true });
});