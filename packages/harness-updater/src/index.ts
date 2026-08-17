import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE = "@deepseek-ai/dsh";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 20;
const REGISTRY_URL = "https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest";
const FETCH_TIMEOUT_MS = 10000;
const WARM_NPX_TIMEOUT_MS = 120000;

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

function warmNpxCache(version) {
  const child = spawn("npx", ["--yes", `${PACKAGE}@${version}`, "--version"], {
    stdio: "ignore",
    detached: true,
  });
  // spawn 失败（npx 不在 PATH 等）会在子进程上触发异步 'error' 事件，
  // try/catch 捕获不到，必须显式监听，否则会崩溃整个 dsh 进程。
  child.on("error", () => {});
  child.unref();
  const kill = setTimeout(() => child.kill(), WARM_NPX_TIMEOUT_MS);
  child.on("exit", () => clearTimeout(kill));
}

/**
 * 检查 registry 最新版本并更新状态。
 * @param {object} ctx 插件上下文({ logger: { info, warn } })
 * @param {{ fetch?: typeof fetch; warm?: (version: string) => void }} [deps]
 *   测试注入点:mock fetch / 替换 npx 预热(单测不真正 spawn)。
 */
async function checkLatest(ctx, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const doWarm = deps.warm ?? warmNpxCache;
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
    ctx.logger.warn(`[dsh-updater] version check failed: ${error.message}`);
    return;
  }
  if (typeof latest !== "string" || latest.length === 0) return;

  const state = readState();
  const changed = state.latest !== latest;
  const now = Date.now();
  state.latest = latest;
  state.lastCheckAt = now;
  state.lastCheckAtIso = new Date(now).toISOString();
  if (changed) {
    const history = state.history ?? [];
    history.push({ at: state.lastCheckAtIso, from: state.latestPrev ?? null, to: latest });
    state.history = history.slice(-HISTORY_LIMIT);
    state.updatedCount = (state.updatedCount ?? 0) + 1;
    doWarm(latest);
    ctx.logger.info(`[dsh-updater] new dsh version ${latest} found; npx cache warming for next launch`);
  } else {
    ctx.logger.info(`[dsh-updater] dsh is current: ${latest}`);
  }
  state.latestPrev = latest;
  writeState(state);
}

const name = "dsh-harness-updater";

function apply(ctx) {
  const state = readState();
  ctx.logger.info(
    `[dsh-updater] last check: ${state.lastCheckAtIso ?? "never"}; latest known: ${state.latest ?? "unknown"}`,
  );
  void checkLatest(ctx);
  const interval = setInterval(() => void checkLatest(ctx), CHECK_INTERVAL_MS);
  interval.unref();
  // Cordis 语义:ctx.effect(fn) 的 fn 立即执行,返回值才是卸载清理;
  // 直接写 clearInterval 会让定时器刚创建就被清掉(实测从未定时检查)。
  ctx.effect(() => () => clearInterval(interval));
}

export { apply, checkLatest, name };
