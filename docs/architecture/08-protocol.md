# 08 · dsh-runtime 事件协议与目录底座

> 状态:**设计定稿(未执行)** · v0.3 新增 · 对应路线图 Phase 1(MVP 四件套之二)
> 这是当前最重要的一篇:把 **dsh-runtime → Harness(OpenCode)→ PWA →
> GitHub Autopilot** 的通信协议与目录结构定下来。底座确定后,上层自然长出。

## 1. 数据源澄清(先对齐事实)

用户口中的"OpenCode 正在干什么" = **Harness(官方 dsh)里 Agent 的会话与
工具事件**;OpenCode Zen 只是模型 Provider。因此:
- 事件源 = Harness 会话事件(经 01 篇 reliability 的 trace recorder 采集),
  **不是"偷窥终端"**;
- Zen 的兼容失败以 error.* 事件(taxonomy)呈现,与工具事件同流。

## 2. 事件族(MVP 五族;Phase 2+ 扩展)

| 族 | 事件 | MVP |
| --- | --- | --- |
| session | session.started / session.title / session.completed | ✅ |
| tool | tool.started / tool.completed / tool.failed | ✅ |
| error | error.recorded(compatibility_failure / runtime.crash / rate_limit ...) | ✅ |
| test | test.started / test.completed | ✅ |
| completion | completion.proposed / completion.verdict / completion.evidence | ✅ |
| (扩展) | verify.* / replay.* / recovery.* / budget.* / maintenance.* / github.* | Phase 2+ |

## 3. Envelope(统一信封,所有通道共用)

```json
{
  "schema": 1,
  "seq": 48291,
  "eventId": "evt_01J8VK3MZQ",
  "family": "tool",
  "type": "tool.completed",
  "at": "2026-08-16T21:30:11.123Z",
  "sessionId": "s_18291",
  "goalId": "g_42",
  "source": "harness | github | console",
  "data": {}
}
```

规则:`seq` 全局单调递增(重放游标);追加字段向后兼容;`schema` 版本号防误读。

## 4. 各族 payload(带示例)

```json
// tool.completed
{ "tool": "shell", "command": "npm test", "exitCode": 1,
  "latencyMs": 3210, "stdoutTail": "...",
  "tokens": { "in": 3100, "out": 420 } }

// tool.failed(错误也同时发 error.recorded)
{ "tool": "shell", "command": "npm test", "exitCode": 1,
  "taxonomy": "RUNTIME.CRASH" }

// error.recorded
{ "taxonomy": "PROTOCOL.REASONING_REPLAY", "severity": "HIGH",
  "occurrences": 7, "firstSeenAt": "2026-08-16T12:31:00Z",
  "knownIssue": "#182", "traceRef": "traces/s_18291.ndjson" }

// test.completed
{ "suite": "llm-opencode-zen", "passed": 142, "failed": 1,
  "durationMs": 12000, "matrix": "rc.6 × 1.18 × v4-flash-free" }

// completion.proposed(Agent 宣称完成,不能自证)
{ "goalSummary": "Fix login timeout", "confidence": 0.94,
  "evidence": { "filesChanged": ["src/auth.ts"],
                "checks": [ { "name": "unit_test", "result": "pass" } ] } }

// completion.verdict(gate 裁决)
{ "goalSummary": "Fix login timeout", "verdict": "pass | fail | repair",
  "repairRound": 1, "reason": "integration_test failed" }
```

密文规则:payload 落盘前 secrets scrub(凭证不进事件库,前置执行)。

## 5. 传输与 API(dsh-runtime)

```text
Console(PWA)              dsh-runtime(127.0.0.1:3090)         事件源
   │                              │                              │
   │ WS /ws?filter=tool,error     │ ◄── Harness 事件(trace recorder)
   │ GET /api/events?since=seq    │ ◄── verify/test 结果
   │ GET /api/sessions/:id/timeline│ ◄── GitHub 拉取(github.*)
   │ POST /api/tasks(维护任务)     │
   ▼                              ▼
  事件回放补齐后接 WS 增量          append-only JSONL 事件库
```

- 打开 Console 的时序:先 REST 拉历史(游标 since=),再 WS 订阅增量,
  断线重连重复此流程,**事件库是重放事实源,WS 只是加速通道**;
- 鉴权:仅绑定 127.0.0.1 + 首启生成的 bearer token(存 state,权限 0600);
- 健康:GET /api/health(进程 + 端口 + 事件库游标)。

## 6. 目录结构(底座)

```text
~/.local/share/dsh-runtime/             # 既有:隔离 Node + 官方 dsh
~/.local/state/dsh-runtime/
├── dsh.pid
├── logs/
├── token                               # console 鉴权(0600)
└── events/
    ├── 2026-08-16.jsonl                # 事件库(append-only,默认保留 30 天)
    └── seq                             # 单调游标

~/.dsh/state/reliability/               # 可靠性数据(01 篇:traces/findings/
│                                       #   fixtures/matrix)
dsh-plugins/(仓库)
├── packages/
│   ├── dsh-runtime/                    # 事件中枢 + console server(新)
│   ├── dsh-console/                    # console 前端(新,vite,自带 manifest)
│   ├── dsh-maintenance-core/           # 六工具(03 篇)
│   ├── reliability-core/               # 控制平面原语(01 篇)
│   └── ...(llm-opencode-zen 等)
├── .dsh/
│   ├── incidents/ fixtures/ regressions/ knowledge/ benchmarks/
│   └── state/                          # autopilot 回写(同一 envelope 格式)
└── .github/workflows/{ci,maintenance,regression,benchmark}.yml
```

## 7. GitHub Sync(本地 ↔ 云端,同一协议)

| 方向 | 内容 | 通道 |
| --- | --- | --- |
| 上行 | error.recorded → .dsh/incidents/ + findings;Console [Fix] 按钮/规则触发 → issue | 分支 commit → issue(06 篇) |
| 下行 | autopilot 过程事件(issue/attempt/PR/CI)→ .dsh/state/autopilot-<run>.json | 工作流回写 + git pull;公共仓库 GitHub REST 免 token |

- runtime 把下行内容转成 github.* / maintenance.* 事件 → Console 的
  Maintenance 页与 Failures 页实时可见;
- **Console 永远只讲一种协议**(本地 envelope),本地/云端对它透明。

## 8. 与 autopilot / maintenance 的关系

- 06 篇的维护循环消费 .dsh/incidents(同源事件);
- Console 的 [Fix with OpenCode Zen] = 创建 incident → 本地维护态(03 篇)
  或 GitHub issue(06 篇),二选一由 Settings 配置;
- 维护过程的每个阶段(status/inspect/reproduce/test/verify)都以同一
  envelope 回写,Console 全程可见 attempt 2/3。

## 9. 兼容与演进原则

1. envelope `schema` 版本号 + 追加字段向后兼容,不删不改既有字段;
2. taxonomy 枚举版本化(新增自由,重命名走迁移);
3. 事件库只追加(JSONL),清理按天删除,不做原地更新;
4. 丢事件无碍:store 是事实源,所有消费方可重放补齐;
5. 多事件源时钟:以 runtime 接收时间为准,源侧时间保留在 data 内。

## 10. MVP 验收(事件侧)

1. 一次真实任务产生完整五族事件,Console 全程可见(活动流 + timeline);
2. 断线重连后 REST 回放补齐,seq 无缺口;
3. 一个 error.recorded 经人工触发变成 GitHub issue;
4. 公共仓库场景零 token 可读 autopilot 状态;
5. 事件库中无凭证(scrub 自测通过)。
