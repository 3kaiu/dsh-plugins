// @3kaiu/dsh-harness-updater 单元测试:registry 检查/状态机/预热/容错(mock fetch)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLatest } from "../src/index.js";

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

test("新版本:info 提示 + 预热调用 + 状态写入(history/updatedCount)", async () => {
  const { dir, stateFile } = isoHome();
  process.env.DSH_HOME = dir;
  const c = mkCtx();
  let warmed = null;
  await checkLatest(c, {
    fetch: async () => jsonResponse({ version: "9.9.9" }),
    warm: (v) => { warmed = v; },
  });
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(warmed, "9.9.9");
  assert.equal(state.latest, "9.9.9");
  assert.equal(state.updatedCount, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].to, "9.9.9");
  assert.equal(state.history[0].from, null);
  assert.match(c.logs.info[0], /new dsh version 9\.9\.9/);
  rmSync(dir, { recursive: true, force: true });
});

test("当前版本:info current + 不预热 + updatedCount 不增,但 lastCheckAt 刷新", async () => {
  const { dir, stateFile } = isoHome();
  process.env.DSH_HOME = dir;
  writeFileSync(stateFile, JSON.stringify({ latest: "1.2.3", updatedCount: 5, latestPrev: "1.2.3", history: [] }));
  const c = mkCtx();
  let warmed = false;
  await checkLatest(c, {
    fetch: async () => jsonResponse({ version: "1.2.3" }),
    warm: () => { warmed = true; },
  });
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(warmed, false);
  assert.equal(state.latest, "1.2.3");
  assert.equal(state.updatedCount, 5);
  assert.equal(state.history.length, 0);
  assert.ok(state.lastCheckAt > 0);
  assert.match(c.logs.info[0], /dsh is current: 1\.2\.3/);
  rmSync(dir, { recursive: true, force: true });
});

test("registry 5xx:warn 且状态不写", async () => {
  const { dir, stateFile } = isoHome();
  process.env.DSH_HOME = dir;
  const c = mkCtx();
  await checkLatest(c, { fetch: async () => jsonResponse({}, 503) });
  assert.match(c.logs.warn[0], /registry responded 503/);
  assert.equal(existsSync(stateFile), false, "失败不写状态");
  rmSync(dir, { recursive: true, force: true });
});

test("网络异常:warn 且不崩", async () => {
  const { dir, stateFile } = isoHome();
  process.env.DSH_HOME = dir;
  const c = mkCtx();
  await checkLatest(c, { fetch: async () => { throw new Error("ETIMEDOUT"); } });
  assert.match(c.logs.warn[0], /version check failed: ETIMEDOUT/);
  assert.equal(existsSync(stateFile), false, "失败不写状态");
  rmSync(dir, { recursive: true, force: true });
});

test("无效版本(空字符串):静默跳过,不写状态", async () => {
  const { dir, stateFile } = isoHome();
  process.env.DSH_HOME = dir;
  const c = mkCtx();
  await checkLatest(c, { fetch: async () => jsonResponse({ version: "" }) });
  assert.equal(c.logs.warn.length, 0);
  assert.equal(c.logs.info.length, 0);
  assert.equal(existsSync(stateFile), false, "无效版本不写状态");
  rmSync(dir, { recursive: true, force: true });
});

test("状态文件损坏:readState 容错,检查照常完成并修复状态", async () => {
  const { dir, stateFile } = isoHome();
  process.env.DSH_HOME = dir;
  writeFileSync(stateFile, "{corrupted json!!");
  const c = mkCtx();
  await checkLatest(c, {
    fetch: async () => jsonResponse({ version: "2.0.0" }),
    warm: () => {},
  });
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(state.latest, "2.0.0");
  assert.equal(state.updatedCount, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("history 截断:HISTORY_LIMIT=20,超限只留最近 20 条", async () => {
  const { dir, stateFile } = isoHome();
  process.env.DSH_HOME = dir;
  const history = Array.from({ length: 25 }, (_, i) => ({ at: "t" + i, from: "v" + i, to: "v" + (i + 1) }));
  writeFileSync(stateFile, JSON.stringify({ latest: "old", history }));
  const c = mkCtx();
  await checkLatest(c, {
    fetch: async () => jsonResponse({ version: "new-ver" }),
    warm: () => {},
  });
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(state.history.length, 20);
  assert.equal(state.history[19].to, "new-ver");
  assert.equal(state.updatedCount, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("checkLatest 注入校验:fetch 收到 registry URL", async () => {
  const { dir } = isoHome();
  process.env.DSH_HOME = dir;
  const c = mkCtx();
  await checkLatest(c, {
    fetch: async (url) => { assert.equal(url, REGISTRY_URL); return jsonResponse({ version: "x" }); },
    warm: () => {},
  });
  rmSync(dir, { recursive: true, force: true });
});
