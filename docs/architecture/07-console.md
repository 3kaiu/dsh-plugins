# 07 · DSH Console:个人 Agent 工作台(驾驶舱)

> 状态:**已执行(Console 四页 MVP + 维护早报面板落地,实测见 11 篇 §19/§22);日活指标待真实使用周期统计** · v0.3 新增
> 定位转变:不做"另一个 Harness UI",而是 **OpenCode 的驾驶舱**——
> OpenCode 负责开车,你看仪表盘。官方 Harness Web(3080)继续承担聊天/Agent
> 交互;DSH Console(3090)承担**感知与控制**。

## 1. 一句话需求

> 你每天用 OpenCode 做任何事情时,Console 都能让你看见:
> **它在干什么、为什么这么干、哪里出问题、它有没有真的完成。**

## 2. 与官方 UI 的分工(两个 Web App)

| | 官方 Harness Web(3080) | DSH Console(3090,本设计) |
| --- | --- | --- |
| 聊天 / 会话交互 | ✅ | ❌(只读 + 任务入口) |
| Session Observatory(实时活动) | ❌ | ✅ |
| Agent Timeline(为什么改 auth.ts) | ❌ | ✅ |
| Failure Center / Verification / Health | ❌ | ✅ |
| Maintenance 状态 | ❌ | ✅ |
| 代码归属 | 官方(零修改) | 自建 dsh-console |

**决策:两个 Dock 图标,互不侵入。** Console 内放"打开 Harness"按钮跳转官方 UI;
不 iframe、不改官方 UI、不注入官方前端。
(替代方案"client 插件注入官方 UI"因官方 client API 仍属 developer preview、
变更风险高,MVP 不采用;官方 API 稳定后再评估合并。)

## 3. 七个页面

### 3.1 Dashboard(最常看)

```text
┌────────────────────────────────────────────┐
│ DSH Console                               │
├────────────────────────────────────────────┤
│ ACTIVE AGENTS                              │
│ ● opencode-zen  Fix auth timeout  Run 02:31│
│   Tools 27 · Tokens 31.4k · ███████░░ 72%  │
│   ✓ Analysis ✓ Implementation              │
│   ● Testing   ○ Verification               │
├────────────────────────────────────────────┤
│ HEALTH                                     │
│   Plugin compatibility  98%                │
│   Regression tests      142/143            │
│   Open issues           3                  │
│   Maintenance           1 running          │
│                                            │
│ 早报:overnight 3 completed · 1 needs review│
└────────────────────────────────────────────┘
```

### 3.2 Sessions(Session Observatory + Agent Timeline)

- 实时活动流(10:32:11 read src/auth.ts → 10:32:27 edit auth.ts →
  10:32:31 npm test → 10:32:45 failed → 10:32:48 analyzing);
- Agent Timeline:Plan 分支图(Repository analysis → Find auth impl →
  Identify bug → Modify → Test → Diagnose → Fix → Verify ✓);
- 节点可点开 **Reason**:"The existing refresh flow does not update the cached
  access token after retry."(因果链,来自 01 篇 Trace 能力);
- Agent Score(87 分,组成:Completion 30 / Correctness 30 / Efficiency 15 /
  Tool discipline 10 / Regression 10 / Safety 5)——Phase 4。

### 3.3 Tasks(任务入口)

- `+ New Task`:输入"优化 llm-opencode-zen 的 DeepSeek tool call 兼容性"
  → 创建维护任务(本地 /dsh-maintain 或 GitHub issue → autopilot);
- 任务列表:queued / running / verifying / merged / needs-human。

### 3.4 Failures(Failure Center)

- 统一汇总 terminal / GitHub / Harness / npm / 插件日志的失败,
  按 severity × taxonomy 聚合;
- 条目:reasoning replay · 12 occurrences · first seen 12:31 · known issue #182
  · 按钮 **[Inspect] [Replay] [Fix with OpenCode Zen]**;
- [Fix] = 创建 incident → 本地维护态或 GitHub issue(03/06 篇)。

### 3.5 Health(Agent Health)

```text
OpenCode Zen
  Reliability 98.4% · Tool Success 99.1% · Verification 93.8%
  Retry Rate 4.2% · Avg Tokens 42k · Avg Task Time 8m21s

Last 7 days
  Tasks 128 · Success 117 · Failed 11
  Self-recovered 8 · Human intervention 3
```

- score 变化归因(Phase 4):"今天 72 vs 昨天 87 → Tool retries +34%、
  reasoning replay failures +12%、avg context +21%";
- 触发阈值告警(如 Tool Success 连续下降 → 自动生成维护 issue)。

### 3.6 Maintenance(Autopilot 视图)

- 当前自维护状态:issue #182 · status investigating · attempt 2/3;
- Overnight 报告:2 repaired · 1 pending review · 0 regressions。

### 3.7 Settings

- 端口(3080/3090)、事件保留期、GitHub 仓库、token、agent provider、
  UA(显式配置项,默认跟随官方,风险注明)。

## 4. 每日使用闭环

| 时段 | 场景 | Console 提供 |
| --- | --- | --- |
| 早上 | 过夜结果 | 早报:overnight 3 completed · 1 needs review |
| 工作中 | 正常干活 | ● Agent working(实时活动,偶尔瞄一眼) |
| 出问题 | 卡住/失败 | 🔴 stuck → [Inspect] / [Ask Agent to Recover] |
| 晚上 | 无人值守 | GitHub autopilot 跑 tests/compat/benchmark/deps |
| 次日 | 复盘 | 维护报告 + score 变化归因 |

## 5. 消费方链条(每个组件都有明确下游)

| 组件 | 消费方 | 你实际得到什么 |
| --- | --- | --- |
| llm-opencode-zen | Harness / OpenCode Zen | 更稳定的 DeepSeek |
| dsh-reliability | dsh-runtime | Trace / Verify / Replay |
| dsh-runtime | **Console** | 实时 Agent 状态 |
| **Console** | **你自己** | 感知 / 控制 / 分析 |
| GitHub Autopilot | dsh-plugins | 自动维护 |
| Knowledge | Agent | 经验积累 |
| Benchmark | Console / Autopilot | 判断版本是否变好 |

**原则:消费者永远是下一层,最终消费者是你自己。**

## 6. MVP 边界(Phase 1,防范围蔓延)

- 做:Dashboard(实时)+ Sessions(activity feed + timeline 只读)+
  Failures(聚合 + Inspect)+ Health(摘要四指标);
- 读:Tasks / Maintenance 只读 GitHub 状态(按钮式创建 issue);
- 不做:Agent Score 完整版、Analytics 归因、原生壳(Pake/Tauri)、
  "一次性修全部"的任务面板;
- 交付形态:直接 Safari 添加到程序坞(自带 manifest,display standalone),
  `⌘+Space → DSH Console`,看起来就是独立 App。

## 7. 技术归属

- 前端:dsh-console(vite 静态站,零重型依赖,自带 manifest);
- 后端:dsh-runtime 同端口 serve + WebSocket(协议见 08 篇);
- 默认 127.0.0.1:3090,仅本机;鉴权 = 首启生成 token。
