# 01 · dsh-reliability:Agent Reliability / Control Plane

> 本篇是整套规划的核心。状态:**设计定稿(未执行)**。
> 对应路线图 Phase 3(见 05-roadmap.md)。

## 1. 定位与问题

官方 Harness 已经覆盖 Agent 的"手脚"(fs/shell/terminal/lsp/web/subagent/
workflow/todo/plan/goal/guard/extensions/...),真正稀缺的是控制平面。
本插件回答官方不回答的十个问题:

1. Agent 为什么认为自己完成了?
2. 为什么同一工具连调 15 次?
3. 为什么改了 30 个文件?
4. 为什么测试失败还继续跑?
5. 为什么一个简单任务烧 5 倍 token?
6. subagent 的结论为什么被直接采信?
7. 一次错误的 tool call 为什么污染后面十几轮?
8. 断电 / 崩溃 / 网络失败后能不能恢复?
9. 模型换版本后行为有没有退化?
10. "成功"之后,需求真的被满足了吗?

结论:**dsh-reliability 不是工具插件,是 Agent Control Plane。**

> v0.2 补注:reliability 是**神经系统 + 实验室 + 手术室**,不负责思考;
> 大脑是使用中的 OpenCode Zen 免费模型(认证 = 字面 Bearer public,零凭证),
> 通过 03 篇的六工具 Maintenance API 与 06 篇的 GitHub 自动驾驶闭环工作。

## 2. 七大能力总览

| 能力 | 回答的问题 | 挂载点(官方机制) | 形态 |
| --- | --- | --- | --- |
| Observe | Agent 到底干了什么? | session 事件流 | 插件(常驻) |
| Trace | 为什么做这个动作?(因果链) | session / session-query | 插件 + CLI 查看 |
| Verify | 怎么证明做完了? | goal / jobs / shell | 插件 + CLI |
| Recover | 失败后怎么恢复? | checkpoint + repair loop | 插件 |
| Budget | 怎么不让它烧钱? | goal / interaction | 插件 |
| Guard | 什么绝对不允许?(策略级) | guard | 插件(增强,非替代) |
| Evolve | 怎么越用越强? | extensions / jobs | 流程 + CLI |

## 3. 数据模型(核心 schema)

### 3.1 Trace Event

```json
{
  "traceId": "t_20260816_2130_a1b2",
  "sessionId": "s_18291",
  "goalId": "g_42",
  "planId": "p_7",
  "turn": 12,
  "actor": "agent | tool | subagent | user | verifier",
  "kind": "prompt | reasoning | tool_call | tool_result | decision | observation | verification | checkpoint",
  "tool": "shell",
  "input": { "command": "npm test" },
  "output": { "exitCode": 1, "stdoutTail": "..." },
  "tokens": { "in": 3100, "out": 420, "reasoning": 1500 },
  "latencyMs": 6400,
  "at": "2026-08-16T21:30:11Z"
}
```

- 写:NDJSON 追加(`DSH_HOME/state/reliability/traces/<sessionId>.ndjson`)。
- 密文规则:input/output 落盘前做 secrets scrub(aws/ssh/token/key 正则 +
  与 policy 联动),**trace 里不允许出现凭证**。

### 3.2 Goal Assertion 与 Completion Gate

```yaml
goal:
  id: g_42
  summary: 修复登录超时
  assertions:
    - id: login_request_success
      check: { type: integration_test, target: auth.spec.ts }
    - id: timeout_bounded
      check: { type: custom, run: "node scripts/check-timeout.js" }
    - id: no_regression
      check: { type: unit_test }
checks:
  - { type: typecheck }
  - { type: build }
gate:
  required: all
  state: pending | pass | fail | repair
  maxRepairRounds: 3
```

### 3.3 Evidence(Agent 最终答复必须附带)

```yaml
evidence:
  goal: 修复登录超时
  filesChanged: ["src/auth.ts", "test/auth.test.ts"]
  checks:
    - { name: unit_test, result: pass, detail: "14/14" }
    - { name: build, result: pass }
    - { name: timeout_bounded, result: pass, detail: "request timeout = 15s" }
  confidence: 0.94
```

### 3.4 Failure Taxonomy(错误永远不叫 ERROR)

```text
PROTOCOL.REASONING_REPLAY      PROTOCOL.PARALLEL_TOOL_DELTA
PROTOCOL.EMPTY_CHOICES         TOOL.JSON_REPAIR
TOOL.SCHEMA_NORMALIZE          CONTEXT.OVERFLOW
CONTEXT.TRUNCATION             NETWORK.TIMEOUT
NETWORK.DNS                    RATE.429
RATE.402                       AGENT.LOOP
AGENT.EARLY_STOP               AGENT.SCOPE_DRIFT
POLICY.DENIED                  RUNTIME.CRASH
ENV.NODE_VERSION               ENV.PATH
```

Failure Record(生产侧唯一允许的产物):

```json
{
  "type": "compatibility_failure",
  "taxonomy": "PROTOCOL.REASONING_REPLAY",
  "provider": "opencode-zen",
  "model": "deepseek-v4-flash-free",
  "harness": "0.1.0-rc.6",
  "opencode": "1.18.x",
  "scenario": "tool_call",
  "sessionId": "s_18291",
  "traceRef": "traces/s_18291.ndjson",
  "reproducible": true,
  "at": "2026-08-16T20:31:00Z"
}
```

## 4. 能力详设

### 4.1 Observe / Trace

- 目标:从"日志"升级到"因果链" Goal → Plan → Action → Observation → Decision。
- 实现:监听官方 session 事件,补齐执行级事件(tool in/out、tokens、latency、
  exit code),关联 goalId/planId 形成 DAG。
- 查看:`dsh reliability trace <sessionId>`(CLI,v0.1 先做纯文本/JSON 输出,
  Phase 5 再做 Web 面板)。

### 4.2 Verify(goal_assert + evidence + completion_gate)

- `goal_assert`:把自然语言目标翻译成 assertions(v0.1 由 Agent 生成 +
  规则模板兜底;v0.2 加历史缓存)。
- checks 类型:v0.1 支持 typecheck / lint / test / build / command / http /
  fs / git_diff / custom;执行器复用官方 shell(经过 Guard policy)。
- completion_gate 状态机:

```text
pending → running → pass → DONE(带 evidence)
                  └→ fail → repair round ≤ maxRepairRounds → 重新喂给 Agent
                                  └→ 超限 → 交还用户(附 evidence + 失败原因)
```

- **Agent 不允许自证完成,只能提交 Proposed Completion,由 gate 裁决。**

### 4.3 Recover(checkpoint + repair loop)

- checkpoint 内容:workspace snapshot(git diff 摘要)、session 状态、
  plan/todo 状态、tool 状态;策略:轻量(每 N 轮 + 关键写操作前)。
- repair loop:失败 → 分析(taxonomy + diff + logs)→ 决策(rollback /
  局部修复 / 换策略)→ 重试;attempt 上限 + 每次 attempt 换策略提示。
- v0.1 只做"记录 checkpoint + 失败上下文打包";自动 rollback 进 Phase 4。

### 4.4 Budget

```yaml
budget:
  max_tokens: 150000
  max_tool_calls: 80
  max_subagents: 4
  max_time: 20m
  max_retries: 3
on_exceed: summarize_then_ask_user
```

- 实现:Observe 计数器 + 阈值事件;超支 → 摘要 → interaction 问用户
  (继续/换策略/停止)。Phase 4。

### 4.5 Guard(Policy-as-Code,官方 guard 的增强而非替代)

- 官方 guard 管"危险动作"(rm -rf / sudo 等);本插件管"策略意图":

```yaml
policy:
  filesystem: { allow: [workspace/**], deny: [~/.ssh/**, ~/.aws/**, ~/.config/**] }
  network:    { allow: [github.com, npmjs.com] }
  shell:      { requireApproval: [git push, npm publish] }
  git:        { requireApproval: [force_push, delete_branch] }
```

- 链路:Intent → Policy → Decision(allow / approve / deny)→ Tool。Phase 4。

### 4.6 Evolve(自驱演进)

- 闭环:production failure → failure record → 最小复现 → fixture →
  regression → patch → 三层验证 → benchmark → PR(人审 merge)。
- 利用官方 extensions(实验插件 mount/unmount):临时插件实验 → 验证 → 稳定 →
  提升为正式 patch → PR。细节见 03-self-evolution.md。

### 4.7 Maintenance API(交给模型的六个工具)

reliability 的所有能力通过六个工具暴露给任意 Agent(含免费 Zen):

| 工具 | 对应 reliability 能力 |
| --- | --- |
| dsh_maintenance_status | Observe + Failure Taxonomy |
| dsh_maintenance_inspect | Trace + Evidence |
| dsh_maintenance_reproduce | Fixtures + Delta Debugging |
| dsh_maintenance_test | Verify(定向) |
| dsh_maintenance_replay | Replay |
| dsh_maintenance_verify | Verify(全量)+ Contract |

工具的约束由 Maintenance Contract 提供(03 篇 §5);工具本身 backend 无关,
GitHub 只是其中一个适配(06 篇)。事件经 dsh-runtime 统一分发(08 篇),
第一个消费者是 DSH Console(07 篇)。

## 5. 附加能力(与核心七件套配套)

| 能力 | 说明 | 阶段 |
| --- | --- | --- |
| Replay | 用 trace 重放历史 session,对比 before/after | Phase 1 |
| Delta Debugging | 对 N 轮 trace 二分,自动找最小复现 | Phase 3 |
| Compatibility Matrix | Harness × OpenCode × Model × 场景 → PASS/FAIL | Phase 2 |
| Doctor | 兼容体检:endpoint/model/streaming/reasoning/parallel-tool/schema/context/429 → 打分 | Phase 2 |
| Benchmark | 任务集 × 版本组合,测成功率/tokens/tool-calls/regressions | Phase 4 |

## 6. 与官方机制的挂载点映射

| 官方 package / 机制 | reliability 用途 |
| --- | --- |
| goal | goal_assert 挂 goal 生命周期;completion_gate 在完成前拦截 |
| guard | policy 检查挂 guard 决策点 |
| session / session-query | trace 读取会话历史;replay 的输入源 |
| jobs | 异步 verify 任务、后台回归 |
| shell / fs | verify checks 的执行器(经 policy) |
| interaction | 预算超支 / 策略切换时问用户 |
| extensions | Evolve 的实验插件 mount/unmount |
| todo / plan | checkpoint 记录 plan 状态 |
| web | Phase 5 只读面板(独立端点,不修改官方 UI) |

## 7. 形态决策:插件 vs CLI vs daemon

| 形态 | 适用 |
| --- | --- |
| 插件(常驻) | trace recorder、goal_assert、gate、budget、policy guard |
| CLI(独立 npm 包) | doctor、replay、benchmark、delta-debug、trace 查看 |
| 外部 daemon | **不引入**。优先插件 + CLI;只有 CI 侧的 matrix 跑批用 GitHub Actions |
| 维护工具 | 六工具作为插件内 tool 暴露(Harness 内维护态);同一套逻辑以 CLI 供 GitHub runner 调用 |

## 8. v0.1 范围与验收标准

**v0.2 调整:MVP 两条线并行 —— ①dsh-maintenance 六工具 + Maintenance Contract + .dsh 记忆目录(03 篇,手动维护态);②reliability 五原语:Trace、Verify(goal_assert + evidence + gate)、Replay、Doctor(最小版)、Failure Record + Taxonomy。详见 05 篇新路线 Phase 1/3。**

验收(全部满足才算 Phase 1 完成):
1. 真实 session 跑完能产出完整 trace NDJSON,含工具入参/出参/tokens/exitCode;
2. 一个自定义 goal 走完 gate:pass 产出 evidence,fail 触发至少一轮 repair;
3. 历史 failure record 能被 replay 重放,并在 fixture 上复现;
4. `dsh doctor` 能给出兼容分(≥ 6 项检查);
5. trace 中 secrets scrub 生效(用假凭证自测);
6. 全量单测 + 冒烟在 CI 通过,发布为独立 npm 包。

**明确不做**(防范围蔓延):checkpoint/rollback、benchmark、budget、policy guard、
Web 面板、delta-debug——分别排入 Phase 3/4/5。

## 9. 数据目录与隐私

```text
$DSH_HOME/state/reliability/
├── traces/<sessionId>.ndjson
├── findings/<taxonomy>-<date>-<n>.json
├── fixtures/…
├── matrix/
└── contracts/
```

- 全部数据默认只存本机;trace 保留期可配置(默认 30 天)。
- secrets scrub 是写入前置条件,不是事后清理。

## 10. 风险

| 风险 | 对策 |
| --- | --- |
| 官方 session/事件 API 变动 | 只依赖公开 service/事件;变化集中在 1 个 adapter 文件 |
| 与官方 goal/guard 功能重叠 | 定位为"增强与编排",不替换;官方增强后自动让位 |
| trace 存储膨胀 | NDJSON 追加 + 保留期 + 采样(长任务按轮次抽样) |
| verify 被用来跑任意命令 | 所有 check 命令必须经过 Guard policy 白名单 |
