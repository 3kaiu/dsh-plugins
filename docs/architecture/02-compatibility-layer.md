# 02 · llm-opencode-zen:DeepSeek ↔ OpenCode 兼容层进化设计

> 状态:**设计定稿(未执行)**。对应路线图 Phase 3。
> 现状基线:packages/llm-opencode-zen 已有 429/402 感知、per-session 冷却、
> pacing、retry、用量遥测、tool-call JSON 修复、reasoning_content 回传,
> 并已有 rate-limit / reasoning-echo 回归测试。**这些全部保留,在其上叠加
> 协议层,而不是推倒重来。**

## 1. 定位

从"OpenCode Zen API 适配器"升级为:

> **DeepSeek ↔ OpenCode ↔ Harness 协议兼容层(Compatibility Layer)**

它是 dsh-reliability 的**第一个 consumer**:兼容失败由本层产生 failure record,
修复验证由 reliability 的 fixtures/regression/matrix 承接。

## 2. 目标目录结构

```text
packages/llm-opencode-zen/
├── src/
│   ├── provider/                 # 已有:Zen 端点适配
│   ├── compatibility/            # 新:协议层(核心)
│   │   ├── reasoning.ts          #   reasoning_content 保留/回传
│   │   ├── tools.ts              #   parallel delta 聚合、tool-call JSON 修复
│   │   ├── streaming.ts          #   SSE 边界、空 choices 容忍
│   │   ├── schema.ts             #   tool schema 规范化
│   │   ├── context.ts            #   上下文窗口与 token 上限(1,048,576)
│   │   └── endpoint.ts           #   endpoint 分类与 beta 规避
│   ├── resilience/               # 已有:pacing/cooldown/retry/backoff
│   ├── diagnostics/
│   │   └── doctor.ts             # 新:兼容体检(接 reliability-cli)
│   └── telemetry/                # 已有:用量遥测 → 扩展为 failure record
├── fixtures/                     # 新:按协议类别组织(见 §4)
├── tests/{unit,integration,regression,live}
├── compatibility/
│   ├── contract.yaml             # 新:兼容契约(唯一事实来源)
│   └── matrix.yaml               # 新:兼容矩阵
└── docs/known-issues/
```

## 3. Compatibility Contract(消灭 if-else 链)

代码不写 `if (model.includes("deepseek"))` 式散点判断,而是读契约:

```yaml
# compatibility/contract.yaml
version: 1
reasoning:
  preserveAssistantReasoning: true      # 多轮 tool-call 必须回传
tools:
  parallelDeltaAggregation: index       # 按 index 聚合并行 tool-call delta
  repairMalformedJson: true
stream:
  tolerateEmptyChoices: true
  fragmentBufferMs: 50
schema:
  canonicalize: true
  unorderedRequired: normalize
context:
  maxTokens: 1048576
endpoint:
  avoidBetaWithTools: true
  classificationFallback: opencode-native
```

结构:Contract(数据)→ Adapter(代码)。换 OpenCode Zen / Go / native / 其他
proxy 时,只改 contract + 对应 adapter,不动主逻辑。

## 4. Fixtures 体系(永久记忆)

```text
fixtures/
├── reasoning/     missing-replay.json · valid-replay.json · mixed-history.json
├── tool-calls/    parallel.json · interleaved.json · malformed.json
├── streaming/     empty-choices.json · fragmented-tool-call.json · reasoning-stream.json
├── schema/        unordered-required.json · malformed-schema.json
└── limits/        context-overflow.json · max-token.json
```

每个 fixture 三件套:`input.json`(上游给我们的)/ `expected.json`(契约要求)/
`actual.json`(首次失败现场)。规则:**没有 fixture 不允许修 bug。**

## 5. 五阶段处理流程(每次兼容问题必须走)

```text
Phase 1 Observe   收集环境(harness/plugin/opencode/node/os/model/endpoint/
                  streaming/thinking/tools/multi_turn)+ 原始请求/响应
Phase 2 Reproduce 建立最小复现(repro/<name>/,先证明 ❌ before)
Phase 3 Root Cause 输出结构化 ROOT CAUSE(层 / 失败点 / 观察值 / 期望值 / 影响)
Phase 4 Minimal Fix 优先在 compatibility/ 层修,不碰 Harness
Phase 5 Verify    三层验证:unit → integration(mock Zen)→ live(真实链路)
```

## 6. Layer Attribution 决策树(修哪里?)

```text
错误现场
  │
  ├─ 直连 DeepSeek API 也复现?     → DeepSeek API 层:记录 + 上游 issue,
  │                                   插件加 workaround 并标注 issue 链接
  ├─ 换 OpenCode native 不复现,
  │   走 Zen 复现?                 → OpenCode Zen 层:记录 + 上游 issue + workaround
  ├─ 协议分类/兼容检测失效?         → OpenCode 层(如 proxy 下 endpointClass
  │                                   误判导致 isDeepSeek=false):生成 upstream
  │                                   patch suggestion,插件侧补 detection 兜底
  ├─ 请求/响应在我们手里就能纠正?    → Plugin 兼容层:正式修复 + fixture + regression
  └─ 与插件无关的 Harness 行为?     → Harness 层:上游 issue,不污染插件
```

## 7. 已知公开问题 → 首批 fixture 素材

| 公开问题 | taxonomy | 首批 fixture |
| --- | --- | --- |
| Zen/Go 多轮 tool-call 的 reasoning_content 不一致(须回传) | PROTOCOL.REASONING_REPLAY | fixtures/reasoning/mixed-history.json |
| proxy/provider 下 endpoint 分类未识别 DeepSeek,reasoning replay 未启用 | PROTOCOL.REASONING_REPLAY | fixtures/reasoning/missing-replay.json |
| Zen/Go 的 DeepSeek V4 tool calling 报 Internal server error | TOOL.JSON_REPAIR(观察项) | fixtures/tool-calls/malformed.json |
| Zen 模型请求超时无响应 | NETWORK.TIMEOUT | fixtures/streaming/empty-choices.json |

## 8. UA 与合规策略(调整后的原则)

1. **默认正常 UA**,不把"伪装官方 CLI"当核心策略;
2. 防限流主防线 = pacing(3 req / 20s 窗口)+ 正确 429/402 处理 + per-session 隔离;
3. **网络身份(出口 IP/IPv6/Loon 出口)与请求身份(UA/Header)分离**,
   网络层配置不写进插件,插件只声明行为;
4. 若某端点确实需要特定 UA 才能工作,做成显式配置项并在 README 声明风险,
   默认关闭。

## 9. 验证三层(与 reliability 共用测试基建)

| 层 | 内容 | 运行位置 |
| --- | --- | --- |
| L1 Unit | 归一化/回传/聚合/schema 修复 | CI(每次 push) |
| L2 Integration | 插件 + mock Zen endpoint(录放 fixture) | CI |
| L3 Live | 真实 Harness + Zen + DeepSeek(隔离 DSH_HOME,免费额度 pacing 保护) | 手动 / 定时低频 |

再加 L4 E2E:Harness 内真实多轮 tool-call 任务走通 —— 这就是 03 篇的闭环终点。

## 10. Compatibility Matrix

```yaml
# compatibility/matrix.yaml(CI 自动追加)
- harness: 0.1.0-rc.6
  opencode: 1.18
  model: deepseek-v4-flash-free
  thinking: true
  tools: true
  streaming: true
  result: PASS
  evidence: [L1, L2, L3]
```

目标:每个 fix 之后矩阵多一行;发布前矩阵全绿才允许 bump 版本。

## 11. 与 dsh-reliability 的接口

- 生产失败 → `compatibility_failure` record(taxonomy 来自 reliability 枚举),
  并进入 autopilot 任务队列(issue,06 篇);同时以 error.recorded 事件
  进入 dsh-runtime 事件流,Console 的 Failure Center 实时可见(07/08 篇);
- reliability Doctor 读本层 contract,输出兼容分;
- fixtures/regression 目录被 reliability-cli 直接复用(不做两份)。

## 12. 明确不做

- 不把 pacing/UA/retry 做成"无限绕限制"的军备竞赛;
- 不为了兼容去 patch 官方 Harness;
- 不在本插件里内置 benchmark 任务集(那是 reliability 的事);
- 不把 network 出口策略(IP/IPv6)写进插件配置。
