// @3kaiu/dsh-github-sync 单元测试:状态机/幂等/sink/客户端(mock fetch)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSink, ghApi, mapPrState, mapRunState, planEvents, prNextKnown, pruneKnown, runNextKnown } from "../dist/index.js";

const run = (over = {}) => ({
  id: 101, name: "ci", display_title: "test job", status: "completed", conclusion: "success",
  head_sha: "abc123", head_branch: "main", html_url: "https://github.com/o/r/actions/runs/101",
  created_at: "2026-08-17T00:00:00Z", updated_at: "2026-08-17T00:02:00Z", ...over,
});
const pr = (over = {}) => ({
  id: 201, number: 12, title: "fix: the thing", state: "open", merged_at: null,
  html_url: "https://github.com/o/r/pull/12", created_at: "2026-08-17T00:00:00Z", closed_at: null,
  head: { sha: "def456" }, base: { ref: "main" }, ...over,
});

test("mapRunState: 新 in_progress run → test.started", () => {
  const evs = mapRunState(void 0, run({ status: "in_progress", conclusion: null }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "test.started");
  assert.equal(evs[0].family, "test");
  assert.equal(evs[0].source, "github");
  assert.equal(evs[0].data.runId, 101);
  assert.equal(evs[0].data.suite, "ci/ci");
});

test("mapRunState: in_progress → completed success → test.completed passed=1", () => {
  const evs = mapRunState("in_progress", run());
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "test.completed");
  assert.equal(evs[0].data.passed, 1);
  assert.equal(evs[0].data.failed, 0);
  assert.equal(evs[0].data.conclusion, "success");
  assert.equal(evs[0].data.durationMs, 120000);
});

test("mapRunState: completed failure → passed=0; 已知 completed 重复 → 无事件", () => {
  const failed = run({ conclusion: "failure" });
  const evs = mapRunState("in_progress", failed);
  assert.equal(evs[0].data.passed, 0);
  assert.equal(evs[0].data.failed, 1);
  assert.deepEqual(mapRunState("completed:failure", failed), []);
});

test("mapRunState: 新 run 直接 completed → 只发 completed(不发 started)", () => {
  const evs = mapRunState(void 0, run());
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "test.completed");
});

test("runNextKnown 状态转换", () => {
  assert.equal(runNextKnown(void 0, run({ status: "in_progress" })), "__started__");
  assert.equal(runNextKnown("__started__", run()), "completed:success");
  assert.equal(runNextKnown("completed:success", run()), "completed:success");
});

test("mapPrState: 新 open PR → completion.proposed", () => {
  const evs = mapPrState(void 0, pr());
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "completion.proposed");
  assert.equal(evs[0].family, "completion");
  assert.equal(evs[0].data.goalSummary, "fix: the thing");
  assert.equal(evs[0].data.pr, 12);
  assert.deepEqual(evs[0].data.evidence.checks, [{ name: "ci", result: "pending" }]);
});

test("mapPrState: open → merged → completion.verdict pass", () => {
  const merged = pr({ merged_at: "2026-08-17T01:00:00Z", state: "closed", merge_commit_sha: "f00d" });
  const evs = mapPrState("open", merged);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "completion.verdict");
  assert.equal(evs[0].data.verdict, "pass");
  assert.equal(evs[0].data.reason, "merged");
  assert.equal(evs[0].data.mergeCommitSha, "f00d");
  assert.equal(prNextKnown(merged), "merged");
});

test("mapPrState: open → closed(未合并) → verdict fail; 重复无事件", () => {
  const closed = pr({ state: "closed", closed_at: "2026-08-17T01:00:00Z" });
  const evs = mapPrState("open", closed);
  assert.equal(evs[0].data.verdict, "fail");
  assert.equal(evs[0].data.reason, "closed without merge");
  assert.deepEqual(mapPrState("closed", closed), []);
  assert.deepEqual(mapPrState("merged", pr({ merged_at: "x", state: "closed" })), []);
});

test("mapPrState: closed → open(重开)→ 新的 proposed", () => {
  const reopened = pr({ state: "open", reopened: true });
  const evs = mapPrState("closed", reopened);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "completion.proposed");
  assert.equal(evs[0].data.reopened, true);
});

test("planEvents: 幂等——相同 known+数据第二轮零事件", () => {
  const runs = [run(), run({ id: 102, status: "in_progress", conclusion: null })];
  const prs = [pr(), pr({ id: 202, state: "closed", closed_at: "x" })];
  const k0 = { runs: {}, prs: {} };
  const { events, nextKnown } = planEvents(k0, runs, prs);
  // run101 completed + run102 started + pr201 proposed;新 closed PR 不追溯(设计)
  assert.equal(events.length, 3);
  const second = planEvents(nextKnown, runs, prs);
  assert.equal(second.events.length, 0);
});

test("planEvents: 状态变化增量——同一 known 下 run 完成、PR 合并", () => {
  const k = { runs: { 101: "__started__" }, prs: { 201: "open" } };
  const { events } = planEvents(k, [run()], [pr({ merged_at: "2026-08-17T01:00:00Z", state: "closed" })]);
  assert.deepEqual(events.map((e) => e.type).sort(), ["completion.verdict", "test.completed"]);
});

test("createSink: seq 单调 + all/家族双写 + flush 持久化", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghevt-"));
  try {
    const sink = createSink(dir, join(dir, "seq"));
    sink.push({ schema: 1, eventId: "evt_1", family: "test", type: "test.completed", at: "t", source: "github", data: { suite: "s" } });
    sink.push({ schema: 1, eventId: "evt_2", family: "completion", type: "completion.verdict", at: "t", source: "github", data: {} });
    assert.equal(sink.seq, 2);
    const all = readFileSync(join(dir, "all.jsonl"), "utf8").trim().split("\n");
    assert.equal(all.length, 2);
    assert.equal(JSON.parse(all[0]).seq, 1);
    assert.equal(JSON.parse(all[1]).seq, 2);
    assert.equal(readFileSync(join(dir, "test.jsonl"), "utf8").trim().split("\n").length, 1);
    assert.equal(readFileSync(join(dir, "completion.jsonl"), "utf8").trim().split("\n").length, 1);
    sink.flush();
    assert.equal(readFileSync(join(dir, "seq"), "utf8"), "2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneKnown: 超限截断", () => {
  const big = Object.fromEntries(Array.from({ length: 600 }, (_, i) => ["k" + i, i]));
  const out = { runs: big, prs: { a: 1 } };
  pruneKnown(out, 500);
  assert.equal(Object.keys(out.runs).length, 500);
  assert.equal(out.prs.a, 1);
});

test("ghApi: URL/认证头构造(mock fetch)", async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    return { ok: true, json: async () => ({ workflow_runs: [] }) };
  };
  const opts = { repo: "3kaiu/dsh-plugins", tokenEnv: "GITHUB_TOKEN_TEST", ghApiBase: "https://api.github.com" };
  process.env.GITHUB_TOKEN_TEST = "tok123";
  const out = await ghApi(opts, "/actions/runs?per_page=20", fakeFetch);
  assert.deepEqual(out, { workflow_runs: [] });
  assert.equal(seen[0].url, "https://api.github.com/repos/3kaiu/dsh-plugins/actions/runs?per_page=20");
  assert.equal(seen[0].auth, "Bearer tok123");
  delete process.env.GITHUB_TOKEN_TEST;
});

test("ghApi: 非 200 → 抛错", async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, text: async () => "rate limited" });
  await assert.rejects(
    () => ghApi({ repo: "o/r", tokenEnv: "GITHUB_TOKEN", ghApiBase: "https://api.github.com" }, "/pulls", fakeFetch),
    /403/,
  );
});
