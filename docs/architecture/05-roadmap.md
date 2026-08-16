# 05 · 路线图、优先级与验收(v0.3)

> 状态:**设计定稿(未执行)**。
> v0.3 变更:路线图从"按能力分层"改为**按产品推进**——先做你每天用得上的
> 工作台 MVP(四件套),再做聪明(可靠性深化)、自动化、分析。

## 1. 阶段总览(产品视角)

| Phase | 目标 | 交付物 | 完成定义(DoD) |
| --- | --- | --- | --- |
| 0 ✅ | macOS 桌面底座 | dsh-launcher v0.1.0 | 已完成:CI 全绿、Release 发布、冒烟通过 |
| 0.5 | **无头大脑 PoC** | **完成(2026-08-16,11 篇)**:探测实测 + CI 双 runner + agent-loop 最小闭环全链路(本地构建插件 → headless 全栈 → Agent 跑测试写记录 → 提交推分支;PR 创建待仓库设置开关,见 11 篇 §5) | 最小闭环 PR 出现(人工 merge),budget/白名单真实生效(PR 开关开启后满足) |
| 1 | **工作台 MVP(四件套)** | ①llm-opencode-zen 稳定性收尾 ②dsh-runtime(五族事件+WS+事件库)③DSH Console(四页 MVP)④GitHub 维护闭环(Issue→Zen→PR→CI,人工 merge)(实现级接口见 09 篇,组件见 10 篇) | **你自己每天能通过 Console 全程看见一次真实任务**;一个真实 failure 走完"事件→issue→PR→人工 merge"闭环 |

> Phase 1 进度(2026-08-17):① 完成(agent-loop 已闭环) ② **dsh-runtime-events v0.1.0 完成**(事件桥,见 11 篇 §6) ③ **dsh-console v0.1.0 完成**(事件库服务端 REST+WS+静态托管 3090,七页 MVP 实时绑定事件流:总览/会话/任务/失败/健康/维护/设置,Preact+signals;实时闭环实测:任务结束 10s 内 session.completed 推送到位) ④ 待执行(维护闭环工作流)。
| 2 | **变聪明** | Verify/Replay/Recovery/Knowledge/Benchmark(原 reliability 深化)+ 兼容 matrix | gate 拦截一次"假完成";matrix ≥3 组合 CI 自动跑 |
| 3 | **自动化** | auto repair / auto PR / auto regression / guarded auto-merge + budget 全量 | 0 误合并(1 放行 + 1 拦截) |
| 4 | **分析** | Agent Score/Analytics/归因 + 无人值守演示 + 发行门禁 | "00:00 失败 → 02:40 修复合入"一次走通;score 归因能解释一次下降 |

## 2. Phase 1 四件套的明确边界(最重要的一版)

| 件 | 做 | 不做 |
| --- | --- | --- |
| ① llm-opencode-zen | 现有稳定性收尾(pacing/cooldown/reasoning/tool-call) | 协议合同化(Phase 2)、benchmark |
| ② dsh-runtime | **事件桥 v0.1.0 已落地(2026-08-17,见 11 篇 §6)**:firehose 订阅面实测 + 五族归一化 JSONL(session/tool/error 有真实数据,test/completion 留 GitHub 侧);待续:WS + 事件库消费侧 + GitHub sync(读) | verify/replay 等扩展族、daemon 化 |
| ③ DSH Console | Dashboard 实时 + Sessions(活动流+timeline 只读)+ Failures(聚合+Inspect)+ Health 摘要 | Score 完整版、Analytics、原生壳 |
| ④ GitHub 维护闭环 | Issue → agent → PR → CI → 人工 merge;budget 四项 | guarded auto-merge、一次修多任务 |

## 3. 每阶段的"明确不做"(防范围蔓延)

- **0.5**:不做任务选择逻辑、auto-merge、常驻服务;
- **1**:不做聊天主界面、不注入官方 UI、不做 auto-merge、不做协议合同化;
- **2**:不做 rollback 全自动、不做 policy guard 全量;
- **3**:不做无条件 auto-merge、不替代官方 guard;
- **4**:不做 iframing、不做 Pake/Tauri 壳(除非出现明确的系统级需求)。

## 4. 优先级矩阵(全能力一览,v0.3)

| 能力 | 价值 | 官方替代风险 | 难度 | 阶段 |
| --- | --- | --- | --- | --- |
| **dsh-runtime(五族事件 + 协议底座)** | ★★★★★★ | 低 | 中 | 1 |
| **DSH Console(四页 MVP)** | ★★★★★★ | 低 | 高 | 1 |
| **GitHub 维护闭环(人工 merge)** | ★★★★★★ | 低 | 高 | 1 |
| dsh-maintenance 六工具 | ★★★★★★ | 低 | 中 | 1 |
| Maintenance Contract + 工程记忆 | ★★★★★★ | 低 | 中 | 1 |
| Verification / Evidence / Gate | ★★★★★★ | 低 | 高 | 2 |
| Agent Trace / Replay | ★★★★★★ | 低 | 高 | 2 |
| Compatibility Contract + Fixtures + Matrix | ★★★★★★ | 低 | 中 | 2 |
| Recovery / Checkpoint | ★★★★★★ | 低 | 很高 | 2-3 |
| Agent Benchmark | ★★★★★ | 低 | 高 | 2 |
| Budget / 白名单 / guarded merge | ★★★★★ | 低 | 中 | 1-3 |
| Agent Score / Analytics | ★★★★★ | 低 | 中 | 4 |
| llm-opencode-zen 维护 | ★★★★★ | 中 | 高 | 持续 |
| layout-infer | ★★★ | 中 | 中 | 维护 |
| harness-updater | ★★ | 高 | 低 | 改造 |
| 新工具型插件 | ★★ | **很高** | 低 | **不做** |

## 5. 里程碑

| 里程碑 | 判据 |
| --- | --- |
| M0.5 | 最小闭环 PR 出现(issue → agent 改 1 文件 → 测试绿 → PR) |
| M1 | **一次真实任务在 Console 全程可见**(五族事件、timeline、无 seq 缺口) |
| M2 | 首个真实 incident 经维护闭环合入(人工 merge) |
| M3 | matrix ≥3 组合 CI 自动跑;gate 拦截一次假完成 |
| M4 | guarded auto-merge 0 误合并 |
| M5 | 无人值守场景端到端演示通过 |

## 6. 成功指标

| 指标 | 目标 |
| --- | --- |
| **Console 日活** | = 你自己每天打开(定性:早上看早报、晚上看维护报告) |
| 事件回放补齐成功率 | 100%(断线重连无缺口) |
| 事件库 secrets 泄漏 | 0(scrub 自测) |
| 无人值守闭环数 | 稳定后每周 ≥1 |
| auto-merge 误合并(FP) | 0 |
| budget 超限率 | 0 |
| needs-human 升级率 | 20~40%(过低说明闸门太松) |
| 闭环时长(failure → PR) | 中位数 ≤ 2 天 |
| fixture 月增量 | ≥1 |
| 兼容分(doctor) | 稳定 ≥90 |

## 7. 风险与对策(v0.3 增补)

| 风险 | 对策 |
| --- | --- |
| **Console 变成"另一个漂亮壳"没人用** | 以"你每天用得着"为 Phase 1 验收;四页全部绑定真实事件流,禁止静态演示页 |
| **双 App(官方 3080 / Console 3090)认知负担** | Console 首页放"打开 Harness"跳转;dshctl open 默认开 Console |
| **console 端口/token 安全** | 仅 127.0.0.1 + 首启 token(0600);token 不进仓库 |
| CI 出口 IP 被 Zen 429 争用 | pacing 实测调优;OPENCODE_ZEN_API_KEY secret 提额;Local-Brain 兜底 |
| 模型乱改仓库 / token 爆炸 | 每 run 一个任务;budget 四项封顶;白名单 deny |
| 误自动合并 | guarded 规则 + reviewer-agent + 0 FP 硬指标 |
| GITHUB_TOKEN 误用 / 递归 | 显式权限矩阵;repair 循环用 workflow_dispatch |
| Zen 服务端加 UA 签名 | UA 可配置且不依赖;回退 secret 或换 endpoint |
| 官方 breaking changes | manifest 版本锁定 + matrix gate + 人工确认 |
| 范围蔓延 | 七阶段 + 四件套边界 + DoD |
| trace 隐私 | scrub 前置;本地存储;artifact 保留期 |

## 8. 一句话总结

工作台 MVP 四件套(稳定 Provider + 事件底座 + 驾驶舱 + 维护闭环)一旦串起来,
**你自己马上就能用**;之后聪明(可靠性)、自动化、分析都是在这个每天使用
的骨架上长肉。**判断任何一个后续功能值不值得做,只有一个标准:
它有没有让"你明天打开 Console 时看到的东西"变得更有用。**
