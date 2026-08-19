import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// @3kaiu/dsh-harness-updater —— 极简版:只做两件事
//   1. 定时检查 npm registry 的 @deepseek-ai/dsh 最新版本
//   2. 有新版本时弹 macOS 原生通知(Notification Center)
// 不做:状态持久化给 Console 提示、settings 注册、history 记录。
// 唯一持久化:lastNotified(通知过的版本,幂等防重复弹窗)。

const REGISTRY_URL = "https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest";
const FETCH_TIMEOUT_MS = 10000;
// 检查间隔:默认 24h,env 可覆盖(ms)
const CHECK_INTERVAL_MS = Number(process.env.DSH_UPDATER_CHECK_INTERVAL_MS) || 24 * 60 * 60 * 1000;

const dshHome = () => (process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh"));
const stateFile = () => join(dshHome(), "state", "dsh-update.json");

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

// 原子写: 先写 tmp 再 rename,崩溃/多实例并发不会留下半写 JSON
function writeState(state) {
  try {
    mkdirSync(join(dshHome(), "state"), { recursive: true });
    const file = stateFile();
    writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(`${file}.${process.pid}.tmp`, file);
  } catch {}
}

/**
 * macOS 原生通知(Notification Center):osascript display notification,
 * 系统自带无需额外安装。非 darwin 平台无操作。
 * @param {string} title
 * @param {string} message
 * @param {{ execFile?: typeof execFile }} [deps] 测试注入点
 */
function notifyMacOS(title, message, deps = {}) {
  const run = deps.execFile ?? execFile;
  // 双引号/反斜杠转义,防 osascript 脚本注入(版本号来自 registry,不可信)
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
  const script = `display notification "${esc(message)}" with title "${esc(title)}"`;
  run("osascript", ["-e", script], (err) => {
    if (err) console.warn(`[dsh-updater] macOS 通知失败: ${String(err?.message ?? err)}`);
  });
}

/**
 * 检查 registry 最新版本;有新版且 macOS 时弹原生通知(每版本只弹一次)。
 * @param {object} ctx 插件上下文({ logger: { info, warn } })
 * @param {{ fetch?: typeof fetch, execFile?: typeof execFile,
 *           platform?: string }} [deps] 测试注入点
 */
async function checkLatest(ctx, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  let latest;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await doFetch(REGISTRY_URL, { signal: controller.signal });
      if (!response.ok) throw new Error(`registry responded ${response.status}`);
      const body = await response.json();
      latest = body.version;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    ctx.logger.warn(`[dsh-updater] version check failed: ${String(error?.message ?? error)}`);
    return;
  }
  if (typeof latest !== "string" || latest.length === 0) return;

  const state = readState();
  const changed = state.lastNotified !== latest;
  if (changed && (deps.platform ?? process.platform) === "darwin") {
    notifyMacOS("DeepSeek Harness 有新版", `发现 v${latest} 可用,可重跑 install.sh 升级`, deps);
    state.lastNotified = latest;
    writeState(state);
    ctx.logger.info(`[dsh-updater] new dsh version ${latest} found; macOS notification sent`);
  } else {
    ctx.logger.info(`[dsh-updater] dsh is current: ${latest}`);
  }
}

const name = "dsh-harness-updater";

function apply(ctx) {
  const state = readState();
  ctx.logger.info(`[dsh-updater] last notified version: ${state.lastNotified ?? "never"}`);
  void checkLatest(ctx);
  const interval = setInterval(() => void checkLatest(ctx), CHECK_INTERVAL_MS);
  interval.unref();
  // Cordis 语义:ctx.effect(fn) 的 fn 立即执行,返回值才是卸载清理;
  // 直接写 clearInterval 会让定时器刚创建就被清掉(实测从未定时检查)。
  ctx.effect(() => () => clearInterval(interval));
}

export { apply, checkLatest, name, notifyMacOS };