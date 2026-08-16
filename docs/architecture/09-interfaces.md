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
    "description": "用历史 trace 回放整个会话,对比修复前后行为差异。",
    "parameters": { "type": "object",
      "properties": { "traceRef": { "type": "string" },
                      "before": { "type": "string" }, "after": { "type": "string" } },
      "required": ["traceRef"] }
  },
  {
    "name": "dsh_maintenance_verify",
    "description": "跑全量回归 + 契约校验。这是修复完成前的最后一道闸,全部通过才算 Fixed。",
    "parameters": { "type": "object",
      "properties": { "scope": { "enum": ["full", "contract"] } }, "required": [] }
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
  default: opencode/1.18.18                # 跟随官方 CLI;可配置
  spoofMode: false                         # 默认关,显式开启须在 README 声明风险
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
