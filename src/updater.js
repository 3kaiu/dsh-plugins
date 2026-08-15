import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE = "@deepseek-ai/dsh";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 20;
const REGISTRY_URL = "https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest";

const dshHome = () => (process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh"));
const stateFile = () => join(dshHome(), "state", "dsh-update.json");

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    mkdirSync(join(dshHome(), "state"), { recursive: true });
    writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
  } catch {}
}

function warmNpxCache(version) {
  try {
    const child = spawn("npx", ["--yes", `${PACKAGE}@${version}`, "--version"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {}
}

async function checkLatest(ctx) {
  let latest;
  try {
    const response = await fetch(REGISTRY_URL);
    if (!response.ok) throw new Error(`registry responded ${response.status}`);
    const body = await response.json();
    latest = body.version;
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
    warmNpxCache(latest);
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
  ctx.effect(() => clearInterval(interval));
}

export { apply, name };
