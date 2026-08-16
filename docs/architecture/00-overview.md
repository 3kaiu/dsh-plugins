# 00 · 总体架构与原则

> DeepSeek Harness 个人发行体系 — 规划文档集 v0.4
> 状态:**设计定稿(未执行)** · 2026-08-16
> v0.3 变更:最终产品从"插件集合"重新定位为 **个人 Agent 工作台(DSH Console)**;
> 新增 07(产品设计)与 08(事件协议与目录底座);一切组件的消费者链条最终指向你自己。
> v0.4 变更:补齐实现级接口规范(09)与 Console 组件级设计(10),
> 底座细化到可直接开工;规划至此收敛,下一步转入执行。

## 文档集

| 文档 | 内容 |
| --- | --- |
| 00-overview.md(本篇) | 总体架构、核心原则、仓库地图、消费方链条 |
| 01-reliability-control-plane.md | reliability 控制平面(神经系统 + 实验室 + 手术室) |
| 02-compatibility-layer.md | llm-opencode-zen 兼容层进化设计 |
| 03-self-evolution.md | 自维护协议:模型是大脑、六工具、契约与记忆 |
| 04-distribution-and-desktop.md | 发行层 / Profile / 桌面与 PWA 集成 / 更新策略 |
| 05-roadmap.md | 路线图、优先级矩阵、验收标准、风险与指标 |
| 06-autopilot.md | dsh-autopilot:GitHub 托管的自维护闭环 |
| 07-console.md | **DSH Console:个人 Agent 工作台(驾驶舱)** |
| 08-protocol.md | **dsh-runtime 事件协议与目录底座** |
| 09-interfaces.md | **实现级接口规范(API / WS / 六工具 / contracts)** |
| 10-console-components.md | **Console 前端组件级设计** |

## 1. 一句话定位(v0.3)

最终产品不是"插件集合",而是**你自己的 Agent 工作台**:

> 你每天用 OpenCode(官方 Harness + Zen)做任何事情时,PWA(DSH Console)
> 都能让你看见:它在干什么、为什么这么干、哪里出问题、有没有真的完成。

插件、Reliability、Autopilot 全部退居底层,成为 Console 的数据/能力供应商。
**OpenCode 负责做事,Zen 负责思考,插件负责能力,Runtime 负责感知,
GitHub 负责持续维护,Console 负责让你看见这一切。消费者永远是下一层,
最终消费者是你自己。**

## 2. 核心原则(所有后续决策的约束)

1. **官方 Harness 是 Core**:不 fork、不修改官方源码、不 vendoring 官方 Web UI。
2. **Everything is a Plugin**:一切扩展走官方 bundle / profile / patch 机制。
3. **分层解耦**:UI / 生命周期 / Core / Profile / 能力层 / 维护者六层独立升级回滚。
4. **生产与开发分离**:生产 Agent 只写 diagnostics;仓库修改只能 branch → tests → PR。
5. **长期资产化**:每个问题按 finding → fixture → regression → contract → matrix 沉淀。
6. **按需启动**:不用时进程为零。
7. **大脑零成本**:不提供模型/API Key/服务器;免费 Zen 模型就是大脑。
8. **全自动 ≠ 无约束**:自动循环必须带 budget、白名单、分阶合并。
9. **每个组件都有下游消费者**(v0.3 新增):不做"技术上很酷但没人用"的项目;
   组件价值 = 它让下一层变得可见/可用,最终让你每天用得着。

## 3. 分层架构总览(v0.3)

```text
                    你(最终消费者)
        ┌───────────────┴────────────────┐
        ▼                                ▼
DSH Console(3090,自建 PWA)      官方 Harness Web(3080,聊天/Agent 工作)
驾驶舱:Dashboard/Sessions/        │
Tasks/Failures/Health/Maintenance │ http://127.0.0.1:3080
        │ WS + REST                ▼
        ▼                    dsh web(官方 Core,0.1.0-rc.6,零修改)
dsh-runtime(事件中枢)              │
 ├─ Harness 事件采集(trace recorder)│
 ├─ 本地事件库(JSONL)              ├─ 官方内置能力(不重做)
 ├─ WebSocket 推送                └─ Profile 层(胶水)
 └─ GitHub sync                          ├── dsh-reliability-*  ← 神经系统
                                         ├── dsh-maintenance    ← 手术室
                                         ├── llm-opencode-zen   ← 兼容层
                                         ├── layout-infer
                                         └── harness-updater    ← 只通知
        │                                        │
        ▼                                        ▼
GitHub(Issues/Actions/PR/CI)              OpenCode Zen(大脑)→ DeepSeek
        │
        └── dsh-autopilot:issue → agent → patch → PR → guarded merge
```

## 4. 各层职责与边界

| 层 | 职责 | 仓库 | 禁止事项 |
| --- | --- | --- | --- |
| **DSH Console(UI)** | 感知 + 控制:活动流/timeline/失败/验证/健康/维护/任务入口 | 3kaiu/dsh-plugins(packages/dsh-console) | 不 iframe 官方 UI、不注入官方前端、不做聊天主界面 |
| 官方 Harness Web | 聊天/会话交互(零修改) | 官方 | — |
| 感知层 dsh-runtime | 事件采集/存储/推送/GitHub sync | packages/dsh-runtime | 不"偷窥终端",只消费会话事件 |
| 生命周期 | 安装、按需启动、健康、更新闸门 | 3kaiu/dsh-launcher | 不打包官方代码 |
| Core / Profile / 能力层 / 维护者 | 同 v0.2 | 同 v0.2 | 同 v0.2 |

## 5. 仓库地图

```text
3kaiu/
├── dsh-launcher                ✅ v0.1.0(生命周期层,已发布)
│
└── dsh-plugins                 monorepo = 能力层 + 工作台
    └── packages/
        ├── dsh-runtime              事件中枢 + console server(新,P1)
        ├── dsh-console              驾驶舱前端(新,P1)
        ├── dsh-maintenance-core     六工具 Maintenance API(新,P1)
        ├── reliability-core         控制平面原语(新,P3 深化)
        ├── llm-opencode-zen         兼容层(已有)
        ├── layout-infer             设计工具(已有)
        ├── harness-updater          更新器(已有,改造)
        └── shared                   plugin-kit(已有)
    ├── .dsh/                        工程记忆 + incidents + state(新)
    ├── .github/workflows/           ci + maintenance + regression + benchmark
    └── docs/architecture/           本规划文档集(9 篇)
```

## 6. 现状盘点与已验证事实

| 对象 | 状态 |
| --- | --- |
| 官方 deepseek-harness | 0.1.0-rc.6,developer preview;官方"手脚"已完整,缺口在控制平面与感知 |
| 3kaiu/dsh-launcher | v0.1.0 已发布;CI 全绿;Release 含 zip + SHA256SUMS |
| 3kaiu/dsh-plugins | 三插件 + kit;llm-opencode-zen 已有 pacing/cooldown/retry/reasoning echo/tool-call repair |
| **Zen 接入事实(源码级已核实)** | 端点 opencode.ai/zen/v1;免费层认证 = 字面 Bearer public(无头 CI 零凭证);可选 OPENCODE_ZEN_API_KEY 提额;UA 可配置(服务端加签名即失效的风险已注明) |
| 生态信号 | 工具类插件同质化 → 差异化在"可靠性基础设施 + 自维护闭环 + 个人工作台" |

## 7. 消费方链条(v0.3 核心表)

| 组件 | 消费方 | 你实际得到什么 |
| --- | --- | --- |
| llm-opencode-zen | Harness / OpenCode Zen | 更稳定的 DeepSeek |
| dsh-reliability | dsh-runtime | Trace / Verify / Replay |
| dsh-runtime | DSH Console | 实时 Agent 状态 |
| **DSH Console** | **你自己** | 感知 / 控制 / 分析 |
| GitHub Autopilot | dsh-plugins | 自动维护 |
| Knowledge | Agent | 经验积累 |
| Benchmark | Console / Autopilot | 判断版本是否变好 |

**这一张表就是"防自嗨"的总检查单:任何新组件上马前,先在表里写清它的下游。**

## 8. 价值主张(五层)

| 层 | 解决什么 | 长期护城河 |
| --- | --- | --- |
| **DSH Console(产品层)** | 让你每天看得见、控得住、用得着 | **高:个人 Agent OS 的交互入口** |
| dsh-runtime(感知层) | 统一事件协议,本地/云端一个协议栈 | 高:AMP 的传输底座 |
| Reliability Control Plane | 可观察、可验证、可恢复、可回放、可评测 | 高 |
| Compatibility Layer | DeepSeek ↔ OpenCode ↔ Harness 协议兼容 | 中(资产化后变高) |
| Desktop Runtime Layer | 安装 / 启动 / 更新 / 健康 | 低(单薄但必须) |
