// @3kaiu/dsh-github-sync —— GitHub sync(读侧)v0.1.0
// 把 GitHub 侧状态(CI workflow runs + PRs)拉进本地事件库,填充 09 篇协议
// 的 test/completion 两族(source=github):test.started/completed 来自 Actions
// runs,completion.proposed/verdict 来自 PR 开/合/关。幂等增量轮询(按已知
// 状态做差分),匿名或 GITHUB_TOKEN 均可用(匿名限速 60 req/h,默认轮询
// 5 分钟 × 2 端点 = 24 req/h,在预算内;建议配 token 提额)。
// 事件库格式与 @3kaiu/dsh-runtime-events 同构(09 篇包络 schema=1),
// 消费侧(Console/维护工具)无感知。
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

const DSH_HOME = process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
const NS = settingsNamespace("github-sync");

//#region 配置
const Config = z.object({
  enabled: z.boolean().default(true),
  repo: z.string().default("3kaiu/dsh-plugins"),
  tokenEnv: z.string().default("GITHUB_TOKEN"),
  pollMs: z.number().min(30000).max(3600000).default(300000),
  eventsDir: z.string().default(join(DSH_HOME, "state", "events")),
  stateFile: z.string().default(join(DSH_HOME, "state", "github-sync.json")),
  ghApiBase: z.string().default("https://api.github.com"),
  apiTimeoutMs: z.number().min(1000).max(120000).default(30000),
  maxRunsPerPoll: z.number().min(1).max(100).default(20),
  maxPrsPerPoll: z.number().min(1).max(100).default(10),
});
//#endregion

//#region ulid(与 runtime-events 同构:10 字符时间前缀 + 16 字符随机,Crockford base32)
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid() {
  let t = BigInt(Date.now());
  const timePart = [];
  for (let i = 0; i < 10; i++) {
    timePart.unshift(CROCKFORD[Number(t & 31n)]);
    t >>= 5n;
  }
  const rand = randomBytes(16);
  let randPart = "";
  for (let i = 0; i < 16; i++) randPart += CROCKFORD[rand[i] & 31];
  return timePart.join("") + randPart;
}
//#endregion

//#region 追加式事件库 sink(与 runtime-events 同构:seq 单调,all.jsonl + 家族文件)
function createSink(eventsDir, seqFile) {
  let seq = existsSync(seqFile) ? Number(readFileSync(seqFile, "utf8")) || 0 : 0;
  return {
    get seq() { return seq; },
    push(envelope) {
      seq += 1;
      const line = JSON.stringify({ seq, ...envelope }) + "\n";
      appendFileSync(join(eventsDir, "all.jsonl"), line, "utf8");
      appendFileSync(join(eventsDir, envelope.family + ".jsonl"), line, "utf8");
    },
    flush() { writeFileSync(seqFile, String(seq), "utf8"); },
  };
}
//#endregion

//#region GitHub API 客户端(可注入 fetch 便于测试)
/** GET /repos/{owner}/{repo}{path}。token 来自 opts.tokenEnv 环境变量,缺省匿名。 */
async function ghApi(opts, path, fetchImpl = fetch) {
  const [owner, name] = opts.repo.split("/");
  const token = process.env[opts.tokenEnv];
  const url = opts.ghApiBase + "/repos/" + owner + "/" + name + path;
  const res = await fetchImpl(url, {
    // 超时保护:GitHub API 挂起时不能让 ticking 永久卡死轮询
    signal: AbortSignal.timeout(opts.apiTimeoutMs ?? 30000),
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dsh-github-sync",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error("gh api " + res.status + " " + url + (msg ? ": " + msg.slice(0, 200) : ""));
  }
  return res.json();
}
//#endregion

//#region 状态机(纯函数,可单测)
const RUN_STARTED = "__started__";
const PR_PROPOSED = "__proposed__";

/** run 状态 → 事件(0..2 条)。known: undefined | "queued" | "in_progress" | "completed:<conclusion>" */
function mapRunState(known, run) {
  if (run.status !== "completed") {
    if (known === void 0) {
      return [{
        family: "test", type: "test.started", source: "github",
        data: {
          suite: "ci/" + (run.name ?? run.display_title ?? String(run.id)),
          provider: "github-actions", runId: run.id,
          workflow: run.name, headSha: run.head_sha, branch: run.head_branch,
          url: run.html_url, createdAt: run.created_at,
        },
        key: String(run.id),
      }];
    }
    return [];
  }
  const conclusion = run.conclusion ?? "failure";
  if (known !== void 0 && known.startsWith("completed:")) return [];
  return [{
    family: "test", type: "test.completed", source: "github",
    data: {
      suite: "ci/" + (run.name ?? String(run.id)),
      provider: "github-actions", runId: run.id,
      passed: conclusion === "success" ? 1 : 0,
      failed: conclusion === "failure" ? 1 : 0,
      durationMs: run.updated_at && run.created_at
        ? Math.max(0, Date.parse(run.updated_at) - Date.parse(run.created_at)) : 0,
      workflow: run.name, headSha: run.head_sha, branch: run.head_branch,
      url: run.html_url, conclusion, createdAt: run.created_at, completedAt: run.updated_at,
    },
    key: String(run.id),
  }];
}

function runNextKnown(known, run) {
  if (run.status !== "completed") return known === void 0 ? RUN_STARTED : known;
  return "completed:" + (run.conclusion ?? "failure");
}

/** PR 状态 → 事件(0..1 条)。known: undefined | "open" | "closed" | "merged" */
function mapPrState(known, pr) {
  const merged = pr.merged_at != null;
  const state = merged ? "merged" : pr.state;
  if (known === void 0) {
    if (state === "open") {
      return [{
        family: "completion", type: "completion.proposed", source: "github",
        data: {
          goalSummary: pr.title,
          confidence: 0.5,
          evidence: {
            filesChanged: [],
            checks: [{ name: "ci", result: "pending" }],
          },
          provider: "github", pr: pr.number, url: pr.html_url,
          headSha: pr.head?.sha, baseBranch: pr.base?.ref, createdAt: pr.created_at,
        },
        key: String(pr.id),
      }];
    }
    return [];
  }
  if (known === state) return [];
  if (state === "merged") {
    return [{
      family: "completion", type: "completion.verdict", source: "github",
      data: {
        goalSummary: pr.title,
        verdict: "pass", reason: "merged",
        provider: "github", pr: pr.number, url: pr.html_url,
        headSha: pr.head?.sha, mergedAt: pr.merged_at, mergeCommitSha: pr.merge_commit_sha,
      },
      key: String(pr.id),
    }];
  }
  if (state === "closed") {
    return [{
      family: "completion", type: "completion.verdict", source: "github",
      data: {
        goalSummary: pr.title,
        verdict: "fail", reason: "closed without merge",
        provider: "github", pr: pr.number, url: pr.html_url,
        headSha: pr.head?.sha, closedAt: pr.closed_at,
      },
      key: String(pr.id),
    }];
  }
  if (state === "open" && known === "closed") {
    // 关闭后重开:视为新的修复提议
    return [{
      family: "completion", type: "completion.proposed", source: "github",
      data: {
        goalSummary: pr.title,
        confidence: 0.5,
        evidence: { filesChanged: [], checks: [{ name: "ci", result: "pending" }] },
        provider: "github", pr: pr.number, url: pr.html_url,
        headSha: pr.head?.sha, baseBranch: pr.base?.ref, createdAt: pr.created_at,
        reopened: true,
      },
      key: String(pr.id),
    }];
  }
  return [];
}

function prNextKnown(pr) {
  return pr.merged_at != null ? "merged" : pr.state;
}

/** 一次轮询的完整规划:输入已知状态 + 拉取结果,输出事件与下一份已知状态。 */
function planEvents(known, runs, prs) {
  const events = [];
  const nextKnown = { ...known };
  // 墓碑恢复:pruneKnown 裁剪掉的条目若被 API 重新返回,
  // 用墓碑状态恢复已知值,避免重复发 started/completed。
  const restore = (section, id) => known.seen?.[section + ":" + id];
  for (const run of runs) {
    const k = known.runs?.[run.id] ?? restore("runs", run.id);
    events.push(...mapRunState(k, run).map((e) => ({ ...e, key: "run:" + run.id })));
    nextKnown.runs = { ...(nextKnown.runs ?? {}), [run.id]: runNextKnown(k, run) };
  }
  for (const pr of prs) {
    const k = known.prs?.[pr.id];
    events.push(...mapPrState(k, pr).map((e) => ({ ...e, key: "pr:" + pr.id })));
    nextKnown.prs = { ...(nextKnown.prs ?? {}), [pr.id]: prNextKnown(pr) };
  }
  return { events, nextKnown };
}

function pruneKnown(nextKnown, limit = 500) {
  // 墓碑:被裁剪的条目按 "section:id → 状态" 记入 seen(随 stateFile 持久化)。
  // GitHub API 只返回最近 ~20 条,known 达上限后裁剪的多为已归档的老记录,
  // 正常情况下不会重现;万一重现(如排序/分页变化),墓碑能保证不重复发事件。
  const seen = nextKnown.seen ?? (nextKnown.seen = {});
  for (const section of ["runs", "prs"]) {
    const obj = nextKnown[section];
    if (!obj) continue;
    const entries = Object.entries(obj);
    if (entries.length <= limit) continue;
    const trimmed = entries.slice(0, entries.length - limit);
    for (const [id, state] of trimmed) seen[section + ":" + id] = state;
    nextKnown[section] = Object.fromEntries(entries.slice(-limit));
    const keys = Object.keys(seen);
    if (keys.length > limit * 2) {
      for (const k of keys.slice(0, keys.length - limit)) delete seen[k];
    }
  }
}
//#endregion

const name = "dsh-github-sync";

function apply(ctx, config) {
  let lastGood;
  const current = () => {
    try {
      const next = Config(config ?? {});
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      ctx.logger?.error("dsh-github-sync: keeping the last good configuration");
      ctx.logger?.error(error);
      return lastGood;
    }
  };
  const opts = current();
  if (!opts.enabled) return;

  mkdirSync(opts.eventsDir, { recursive: true });
  mkdirSync(join(opts.stateFile, ".."), { recursive: true });
  const sink = createSink(opts.eventsDir, join(opts.eventsDir, "seq"));

  const loadKnown = () => {
    try {
      return JSON.parse(readFileSync(opts.stateFile, "utf8"));
    } catch {
      return { runs: {}, prs: {} };
    }
  };

  let ticking = false;
  let known = loadKnown();
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const runs = await ghApi(opts, "/actions/runs?per_page=" + opts.maxRunsPerPoll);
      const prs = await ghApi(opts, "/pulls?state=all&sort=updated&direction=desc&per_page=" + opts.maxPrsPerPoll);
      const { events, nextKnown } = planEvents(known, runs.workflow_runs ?? [], prs ?? []);
      if (events.length > 0) {
        for (const ev of events) {
          const { key, ...envelope } = ev;
          sink.push({
            schema: 1,
            eventId: "evt_" + ulid(),
            family: envelope.family,
            type: envelope.type,
            at: new Date().toISOString(),
            source: "github",
            data: envelope.data,
          });
          if (sink.seq % 25 === 0) sink.flush();
        }
        ctx.logger?.info("[dsh-github-sync] synced " + events.length + " event(s) from " + opts.repo);
      }
      known = nextKnown;
      pruneKnown(known);
      writeFileSync(opts.stateFile, JSON.stringify(known) + "\n", "utf8");
      sink.flush();
    } catch (error) {
      ctx.logger?.error("[dsh-github-sync] " + String(error?.message ?? error));
    } finally {
      ticking = false;
    }
  };

  void tick();
  const interval = setInterval(() => void tick(), opts.pollMs);
  interval.unref();

  ctx.on("dispose", () => {
    clearInterval(interval);
    sink.flush();
  });
  process.once("exit", () => sink.flush());

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { config = source; },
  });
}

export { Config, apply, createSink, ghApi, mapPrState, mapRunState, name, planEvents, prNextKnown, pruneKnown, runNextKnown, ulid };
