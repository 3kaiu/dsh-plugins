import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

const NS = settingsNamespace("harness-updater");
const HISTORY_LIMIT = 20;
const REGISTRY_URL = "https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest";
const FETCH_TIMEOUT_MS = 10000;

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
 * 检查 registry 最新版本并更新状态(供 Console 展示"可升级"提示)。
 * @param {object} ctx 插件上下文({ logger: { info, warn } })
 * @param {{ fetch?: typeof fetch }} [deps]
 *   测试注入点:mock fetch(单测不真正出网)。
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
    ctx.logger.info(`[dsh-updater] new dsh version ${latest} found; state written for console hint`);
  } else {
    ctx.logger.info(`[dsh-updater] dsh is current: ${latest}`);
  }
  state.latestPrev = latest;
  writeState(state);
}

const name = "dsh-harness-updater";

const Config = z.object({
  checkIntervalMs: z.number().min(60000).max(7 * 24 * 60 * 60 * 1000).default(24 * 60 * 60 * 1000),
});

function apply(ctx, config) {
  let lastGood;
  const current = () => {
    try {
      const next = Config(config ?? {});
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      ctx.logger?.error("[dsh-updater] keeping the last good configuration");
      ctx.logger?.error(error);
      return lastGood;
    }
  };
  const state = readState();
  ctx.logger.info(
    `[dsh-updater] last check: ${state.lastCheckAtIso ?? "never"}; latest known: ${state.latest ?? "unknown"}`,
  );
  void checkLatest(ctx);
  const interval = setInterval(() => void checkLatest(ctx), current().checkIntervalMs);
  interval.unref();
  // Cordis 语义:ctx.effect(fn) 的 fn 立即执行,返回值才是卸载清理;
  // 直接写 clearInterval 会让定时器刚创建就被清掉(实测从未定时检查)。
  ctx.effect(() => () => clearInterval(interval));

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { config = source; },
    onChange: () => {},
  });
}

export { Config, apply, checkLatest, name };
