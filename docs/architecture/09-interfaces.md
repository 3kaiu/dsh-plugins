# 09 · 实现级接口规范(API / WS / Tools / Contracts)

> 状态:**设计定稿(未执行)** · v0.4 新增 · Phase 1 的直接输入
> 目的:把 08 篇协议细化到"可直接开工"。读者 = 实现者(人)+ OpenCode Zen
> (工具调用方)。原则:**先定数据,再定代码**;所有组件共用同一份 schema。

## 1. dsh-runtime HTTP API(127.0.0.1:3090)

| Method | Path | 说明 |
| --- | --- | --- |
| GET | /api/health | `{ok, pid, seq, uptimeMs, eventsToday}`(免 token,不泄露细节) |
| GET | /api/events?since=<seq>&limit=500 | 回放。响应 `{events:[Envelope], nextSeq}` |
| GET | /api/sessions/:id/timeline | 该会话事件按 at 排序 + `{tools, tokens, durationMs, phases[]}` |
| GET | /api/failures?window=7d | error 聚合 `[{taxonomy, severity, count, firstAt, lastAt, knownIssue}]` |
| GET | /api/health/summary | Console Health 页数据(指标卡,见 10 篇) |
| GET | /api/tasks | 维护任务列表(本地 + GitHub 汇总) |
| POST | /api/tasks | 创建维护任务 `{goal, scope:"local"|"github", issueTitle?}` → `{taskId}` |
| GET | /api/github/summary | autopilot 状态聚合(60s 缓存;公共仓库免 token) |

- 认证:`Authorization: Bearer <token>`;token 首启生成于
  `~/.local/state/dsh-runtime/token`(0600),Console 自动注入,无登录界面;
- 错误码:401 无效 token;404 未知资源;429 拉取节流;500 内部;
- 所有响应 `Content-Type: application/json`,时间一律 ISO-8601 UTC。

## 2. WebSocket 协议(ws://127.0.0.1:3090/ws)

```text
client → server:
  { op:"subscribe", families:["tool","error"], since:48291 }
  { op:"unsubscribe", families:["tool"] }
  { op:"ping" }

server → client:
  { op:"hello", tokenRequired:true }
  { op:"pong" }
  { op:"event", event:<Envelope> }
  { op:"ack", since:<seq> }      # 每 500 条或 10s 一次
```

规则:一条连接一个订阅;断线后用 `GET /api/events?since=<lastAck>` 补齐;
服务端推送窗口 1024 条,更早历史只走 REST;心跳 30s 无响应即断开。

## 3. 五族事件完整 schema(实现者直接抄)

```ts
// packages/shared/src/events.ts —— 唯一事实来源
type Family = "session" | "tool" | "error" | "test" | "completion";
type Source = "harness" | "github" | "console";

interface Envelope<T = unknown> {
  schema: 1;
  seq: number;            // 全局单调递增
  eventId: string;        // "evt_" + ulid
  family: Family;
  type: string;           // 见下表
  at: string;             // runtime 接收时间(ISO-8601)
  sessionId?: string;
  goalId?: string;
  source: Source;
  data: T;
}

// session.*
interface SessionStarted { title?: string; profile: string; model?: string; }
interface SessionTitle { title: string; }
interface SessionCompleted { turns: number; durationMs: number;
  tokens: { in: number; out: number; reasoning?: number }; }

// tool.*
interface ToolStarted { tool: string; inputSummary: string; }
interface ToolCompleted { tool: string; command?: string; exitCode: number;
  latencyMs: number; stdoutTail?: string; tokens?: { in: number; out: number }; }
interface ToolFailed { tool: string; command?: string; exitCode?: number;
  taxonomy: string; message: string; }

// error.recorded(同时允许 source=harness|github|console)
interface ErrorRecorded { taxonomy: string; severity: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL";
  message: string; occurrences: number; firstSeenAt: string;
  knownIssue?: string; traceRef?: string; reproFile?: string; }

// test.completed
interface TestCompleted { suite: string; passed: number; failed: number;
  durationMs: number; matrix?: string; }

// completion.*
interface CompletionProposed { goalSummary: string; confidence: number;
  evidence: { filesChanged: string[]; checks: { name: string; result: "pass"|"fail"; detail?: string }[] }; }
interface CompletionVerdict { goalSummary: string;
  verdict: "pass" | "fail" | "repair"; repairRound?: number; reason?: string; }
```

字段规则:表中类型为最小契约;实现可加可选字段,**不得删改既有字段**
(schema 版本升级时遵守 08 篇兼容原则)。

## 4. Maintenance Tools(function-calling 定义,OpenCode Zen 直接消费)

```json
[
  {
    "name": "dsh_maintenance_status",
    "description": "列出当前全部维护事项,按严重度×频率排序。动手前先调用,判断有没有值得处理的问题;也可以什么都不修。",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  {
    "name": "dsh_maintenance_inspect",
    "description": "查看单个维护事项的完整现场:环境、期望 vs 实际、涉及组件、trace 引用、相关历史知识。",
    "parameters": { "type": "object",
      "properties": { "incidentId": { "type": "string" } }, "required": ["incidentId"] }
  },
  {
    "name": "dsh_maintenance_reproduce",
    "description": "在隔离环境重放该事项的最小复现,确认问题稳定可复现。返回 before 状态与逐次结果。",
    "parameters": { "type": "object",
      "properties": { "incidentId": { "type": "string" } }, "required": ["incidentId"] }
  },
  {
    "name": "dsh_maintenance_test",
    "description": "对当前工作树跑定向测试(修复前/后对比)。修改代码后必须调用。",
    "parameters": { "type": "object",
      "properties": { "incidentId": { "type": "string" } }, "required": ["incidentId"] }
  },
  {
    "name": "dsh_maintenance_replay",
    "description": "用历史 trace 深度回放整个会话,对比修复前后行为差异。traceRef 支持 .dsh/state/traces/<ref>.jsonl、仓库内相对路径、绝对路径;事件兼容五族包络(tool.started/completed/failed、error.recorded、llm/retry、session.*)与原始 firehose(tool/call+tool/result、turn/start|end、request/context)两种形态。单 trace 输出:session 元数据(标题/模型/turns/tokens/结果)、工具调用序列(tool/input/exitCode/latencyMs/output,配对 tool.started→completed)、错误聚合(taxonomy/severity/occurrences)、llmRetries、人类可读 timeline。给 --before+--after 时输出修复前后对比:工具序列差异(added/removed/changed)、同工具 exitCode 变化、错误总数变化(before→after)、会话结果变化(failed→completed 等)。",
    "parameters": { "type": "object",
      "properties": { "traceRef": { "type": "string", "description": "单 trace 深度回放;与 --before/--after 二选一" },
                      "before": { "type": "string", "description": "对比:修复前 trace" },
                      "after": { "type": "string", "description": "对比:修复后 trace" } },
      "required": [] }
  },
  {
    "name": "dsh_maintenance_benchmark",
    "description": "Agent Benchmark:消费 trace 计算行为指标并给出质量分,用于复盘/门禁。单 trace 输出 metrics(turns/toolCalls/toolKinds/avgLatencyMs/failedCalls/failureRate/llmRetries/errors/errorDensity/reason)+ quality 分(100 - 失败率 - 0.15×重试 - 0.1×错误密度,全可解释)+ verdict(good/ok/poor)。失败率语义:只读探测类工具(read/glob/grep/ls/cat/find/stat)exit 1 = 探测结果(目标不存在),不计执行失败。给 --before+--after 时输出修复前后指标对比:每项 delta + 改善项列表 + 判定变化。",
    "parameters": { "type": "object",
      "properties": { "traceRef": { "type": "string", "description": "单 trace 评分;与 --before/--after 二选一" },
                      "before": { "type": "string", "description": "对比:修复前 trace" },
                      "after": { "type": "string", "description": "对比:修复后 trace" } },
      "required": [] }
  },
  {
    "name": "dsh_maintenance_checkpoint",
    "description": "Recovery/Checkpoint 最小可用版:对维护事项做现场快照,供中断后恢复执行。create(默认):快照 = 事项全文 + attempts 数 + 知识文件列表 + git head/dirty + trace 摘要,写入 .dsh/state/checkpoints/<id>-<ts>.json;list:按时间倒序列出;restore <id>:读取快照并验证完整性(7 个必填字段),返回现场信息。",
    "parameters": { "type": "object",
      "properties": { "action": { "enum": ["create", "list", "restore"], "description": "默认 create" },
                      "incidentId": { "type": "string", "description": "create 必填" },
                      "id": { "type": "string", "description": "restore 必填:快照 id" } },
      "required": [] }
  },
  {
    "name": "dsh_maintenance_knowledge",
    "description": "工程记忆读写:query(默认)返回事项内嵌 knowledge 字段 + .dsh/knowledge/ 匹配文件全文;add 把修复经验沉淀到 .dsh/knowledge/<incidentId>.md(时间戳头、相同文本去重);list 列出全部知识文件与内嵌条目。知识随 checkpoint 快照一起保存,支持恢复续跑。",
    "parameters": { "type": "object",
      "properties": { "action": { "enum": ["query", "add", "list"], "description": "默认 query" },
                      "incidentId": { "type": "string", "description": "query/add 必填" },
                      "text": { "type": "string", "description": "add 必填:经验文本" } },
      "required": [] }
  },
  {
    "name": "dsh_maintenance_trace",
    "description": "Trace 落盘:把会话事件流(五族包络/原始 firehose 的 JSONL)写入事项的 traceRef 路径(.dsh/state/traces/<incidentId>.jsonl),落盘后 replay/benchmark 即可消费。事件文件需逐行合法 JSON。",
    "parameters": { "type": "object",
      "properties": { "incidentId": { "type": "string", "description": "必填" },
                      "from": { "type": "string", "description": "必填:事件文件路径" } },
      "required": ["incidentId", "from"] }
  },
  {
    "name": "dsh_maintenance_guard",
    "description": "Guarded auto-merge 判定(Phase 3):条件 = 维护分支(maintenance/ 前缀)+ verified 标签(evidence 闸门全过时 workflow 打上)+ 无 needs-human 标签 + attempts<3(PR body 解析)+ CI 全绿(mergeStateStatus=CLEAN/READY)。输出 allowMerge + 全部拦截原因。--pr 走真实 gh 数据;--mock 注入 PR 数据(单测/DoD 实测)。",
    "parameters": { "type": "object",
      "properties": { "pr": { "type": "string", "description": "PR 号(真实 gh 数据)" },
                      "mock": { "type": "string", "description": "PR 数据 JSON 文件路径(测试用)" } },
      "required": [] }
  },
  {
    "name": "dsh_maintenance_score",
    "description": "Agent Score/Analytics(Phase 4):聚合 .dsh/state/benchmarks/ 全部评分记录——runs/平均质量/按事项聚合(趋势 + 回归检测:单次降幅 ≥20 时归因到 failureRate/llmRetries/errorDensity 中变化最大者)/按 taxonomy 分布;发行门禁 --gate <阈值>(默认 60):最新一次评分 ≥ 阈值且 reason=completed 才通过(历史失败不惩罚当前)。benchmark --record 是输入侧。",
    "parameters": { "type": "object",
      "properties": { "gate": { "type": "string", "description": "发行门禁阈值(默认 60)" } },
      "required": [] }
  },
  {
    "name": "dsh_maintenance_report",
    "description": "Console 维护报告(Phase 4 收尾):状态总览(open/fixed 事项计数 + open 列表)+ Agent Score 聚合(与 score 同一数据源,趋势/回归/门禁)+ 运行痕迹(最近 3 个恢复点 + 知识文件数);--gate 透传门禁阈值;Console 早报/维护报告的 CLI 输入侧。",
    "parameters": { "type": "object",
      "properties": { "gate": { "type": "string", "description": "发行门禁阈值(默认 60,透传给 score)" } },
      "required": [] }
  },
  {
    "name": "dsh_maintenance_verify",
    "description": "跑契约或证据核验。contract:diff 范围+禁止路径+行数(默认);evidence:agent 声明 vs 磁盘事实——summary 非空、声明文件真实出现在 diff、无未声明文件、reproduce 转不可复现、test 通过,拦截'假完成';full:再加 pnpm test+build。这是修复完成前的最后一道闸,全部通过才算 Fixed。",
    "parameters": { "type": "object",
      "properties": { "scope": { "enum": ["contract", "evidence", "full"] },
                      "claim": { "type": "string", "description": "evidence 必填:agent 声明 JSON 路径,格式 { incidentId, changedFiles: string[], summary }" },
                      "incidentId": { "type": "string", "description": "evidence 必填:事项 ID,用于读取 reproduce/test 命令" } }, "required": [] }
  }
]
```

返回结构约定(所有工具):

```json
{ "ok": true, "data": { }, "diagnostics": [ ] }
```

## 5. Maintenance Contract 完整 schema 与默认值(03 篇 §5 的落盘版)

```yaml
maintenance:
  repository: dsh-plugins
  allowed: [packages/**, tests/**, fixtures/**, .dsh/knowledge/**, docs/**]
  forbidden:                    # 永远生效,配置不可放宽
    - .github/workflows/release.yml
    - .dsh/autopilot.yml
    - LICENSE
    - secrets/**
    - "**/package.json"         # 依赖变更一律人工
  requirements:
    - reproduction_required
    - regression_required
    - tests_required
    - no_unrelated_changes
  completion:
    require: [reproduction_pass, regression_pass, typecheck_pass, build_pass]
  budget:                       # 06 篇 §7 同源
    max_runs_per_day: 3
    max_attempts_per_issue: 3
    max_changed_files: 15
    max_diff_lines: 500
    max_runtime: 15m
```

校验实现:contract 文件进 repo,CI 用 schema 校验;deny 规则在 merge gate 与
autopilot 工作流两侧各实现一次(双保险)。

## 6. compatibility contract.yaml 完整版(1.0 草案)

```yaml
version: 1
reasoning:
  preserveAssistantReasoning: true   # issue:#25000(zen/go 多轮回传)
  replayOnToolContinuation: true
tools:
  parallelDeltaAggregation: index
  repairMalformedJson: true
stream:
  tolerateEmptyChoices: true
  fragmentBufferMs: 50
  reasoningStreamGuard: true         # 重复 delta 归一(duplicate delta)
schema:
  canonicalize: true
  unorderedRequired: normalize
context:
  maxTokens: 1048576
endpoint:
  avoidBetaWithTools: true
  classificationFallback: opencode-native   # proxy 下检测失效的兜底(issue:#86521)
resilience:
  pacing: { requests: 3, windowMs: 20000, maxHoldMs: 15000 }
  cooldown: per_session                    # session 级隔离,不全局连坐
  maxConcurrentStreams: 2
  streamIdleTimeoutMs: 300000
userAgent:
  default: opencode/1.18.18                # 免费层可用性前提(实测:无此形态→429,见 11 篇)
  note: 可配置;服务端若加签名校验则适配器失效,README 声明脆弱性
```

## 7. GitHub sync 文件格式(08 篇 §7 的落盘版)

上行 incident(.dsh/incidents/<date>-<n>.json):

```json
{ "incidentId": "2026-08-16-001", "taxonomy": "PROTOCOL.REASONING_REPLAY",
  "severity": "HIGH", "frequency": 7, "reproducible": true,
  "environment": { "harness": "0.1.0-rc.6", "opencode": "1.18.x",
                   "model": "deepseek-v4-flash-free" },
  "traceRef": "traces/s_18291.ndjson", "reproFile": "fixtures/reasoning/mixed-history.json" }
```

下行 autopilot 状态(.dsh/state/autopilot-<runId>.json):

```json
{ "runId": "31950255710", "issue": "#182", "attempt": 2, "maxAttempts": 3,
  "status": "investigating|testing|pr_open|ci_pass|ci_fail|merged|needs_human",
  "prUrl": "…", "artifacts": ["trace.json", "diff.patch"], "at": "2026-08-16T02:20:00Z" }
```

runtime 将其转成 github.* / maintenance.* 事件供 Console 消费(映射表见 08 篇 §2 扩展族)。

## 8. taxonomy 单一事实源

taxonomy 枚举放 `packages/shared/src/taxonomy.ts`(或 yaml),事件、console、
autopilot、doctor 全部 import 同一份;新增自由,重命名走迁移(08 篇 §9)。

## 9. 兼容规则(重申)

envelope schema 版本号;追加字段向后兼容;事件库 JSONL 只追加;seq 恢复读
`events/seq` 文件;所有消费方可重放补齐,丢事件无碍。
