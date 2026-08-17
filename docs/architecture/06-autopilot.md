# 06 · dsh-autopilot:GitHub 托管的自维护闭环

> 状态:**设计定稿(未执行)** · v0.2 新增 · 对应路线图 Phase 0.5 / 1 / 2
> 目标:0 服务器 / 0 API Key / 0 常驻 Mac。GitHub 提供"身体"
> (定时器 + 计算 + 存储 + CI + PR),OpenCode Zen 免费模型提供"大脑"。
> **你唯一需要拥有的资产就是 GitHub 仓库本身。**

## 1. 可行性基线(源码级已核实)

| 问题 | 结论 |
| --- | --- |
| Zen 免费模型能否无头认证? | **能**。认证是字面 Bearer `public`,无登录态、无本机凭证依赖 |
| 更高额度怎么办? | 一个 GitHub Secret(`OPENCODE_ZEN_API_KEY`)即可,不需要自己的 API 服务 |
| UA 会成阻碍吗? | **已实测(11 篇)**:服务端确实校验客户端形态——裸请求 429,伪造 opencode 客户端指纹即 200;插件做法是免费层可用性前提,签名校验风险依旧成立 |
| public repo 的 Actions 计费? | GitHub-hosted 标准 runner 对公开仓库免费(官方计费文档) |
| 定时调度? | cron + 时区;最小间隔 5 分钟(官方 workflow 语法文档) |
| 真正的 PoC 风险 | **runner 出网 ✅ 已实测**(ubuntu+macos 均 200 POC_OK);CI 出口 IP 无额外 429(指纹形态);pacing 参数调优仍待 agent-loop 长跑观察 |

## 2. 架构

```text
                GitHub(免费控制平面)
┌────────────────────────────────────────────────┐
│ Issues    ← 任务队列(incident → issue + label) │
│ Actions   ← 计算 + 定时器 + 修复循环            │
│ Repo+Git  ← 代码 + 工程记忆(.dsh/)             │
│ PR        ← AI 沙盒                            │
│ CI        ← 验证闸门                            │
│ Artifacts ← 飞行记录仪                          │
│ Cache     ← 依赖加速                            │
│ Releases  ← 人工发布                            │
└───────────────────────┬────────────────────────┘
                        │  推理请求(Bearer public)
                        ▼
              OpenCode Zen 免费模型(大脑)
                        │
                        ▼
                   修复 dsh-plugins
```

## 3. 分层(backend 无关)

```text
dsh-maintenance-core          诊断/复现/修复/验证/回放/记忆(纯能力,不依赖 GitHub)
        │
        ▼
dsh-autopilot(GitHub 适配层)  Issues / Actions / PR / Artifacts / Releases
        │
        └── 未来可换:GitLab / Gitea / Forgejo / 本地(接口不变)
```

## 4. 仓库布局

```text
dsh-plugins/
├── packages/
│   ├── dsh-maintenance-core    六工具 + contract + 记忆读写
│   └── ...(llm-opencode-zen 等)
├── .dsh/
│   ├── autopilot.yml           自动驾驶配置(见 §9)
│   ├── incidents/ · fixtures/ · regressions/ · knowledge/ · benchmarks/ · state/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml              PR 验证闸门(typecheck/test/build/regression)
│   │   ├── maintenance.yml     每日扫描 + 选任务 + 驱动 agent
│   │   ├── regression.yml      矩阵/回归跑批
│   │   └── benchmark.yml       版本对比基准
│   └── ISSUE_TEMPLATE/maintenance.yml
└── docs/architecture/          本规划
```

## 5. 循环生命周期(核心)

```text
触发(三选一):
  ① cron 每日(默认 02:00,时区可配)
  ② 新 failure record 落盘后的 issue 事件
  ③ 手动 workflow_dispatch

        ▼
扫描并选择任务(一次只修一个:severity × frequency 排序,取 top-1)
        ▼
组装上下文包:issue + incident + trace + fixture + knowledge + env + 上次尝试
        ▼
agent 修复(在 maintenance/<issue>-<n> 分支;读源码→最小修复→加 regression)
        ▼
本地验证(contract 要求的 typecheck/test/regression)
        ▼
开 PR(pull_request 事件触发 ci.yml 全量验证)
        ▼
结果回流 issue(评论:fix/evidence/测试结果;失败则附日志)
        │ 过程事件以同一 envelope 回写 .dsh/state/(08 篇协议),
        │ Console 的 Maintenance 页实时可见 attempt/status
        │
   ┌────┴─────┐
  PASS       FAIL 且 attempt < max_attempts → 显式 workflow_dispatch 进入 repair round
   │          FAIL 且 attempt 达上限 → label: needs-human,停止
   ▼
三阶段审批(见 §8)→ guarded auto-merge 或 needs-human
```

**反递归设计**:用 GITHUB_TOKEN 触发的事件不会再级联出新 workflow(push 类),
因此 repair 循环一律用**显式 workflow_dispatch / repository_dispatch** 驱动;
PR 分支的 CI 走 `pull_request` 事件(与 bot PR 行为一致),不依赖隐式链式触发。

## 6. GITHUB_TOKEN 权限矩阵(最小化)

```yaml
permissions:
  contents: write        # 分支 + commit + PR
  issues: write          # 建 issue / 评论
  pull-requests: write   # 开 PR / 请求 review
  actions: read          # 轮询本 run 状态(显式 dispatch 用)
  # 明确不给:secrets、deployments、packages、administration
```

## 7. Budget(防烧额度 + 防乱改)

```yaml
budget:
  max_runs_per_day: 3
  max_attempts_per_issue: 3
  max_changed_files: 15
  max_diff_lines: 500
  max_runtime: 15m
  require_tests: true
  require_regression: true
```

超限 → `label: needs-human`,绝不进入第 4 次尝试。

## 8. 三阶段审批与 guarded auto-merge

| 阶段 | 执行者 | 内容 |
| --- | --- | --- |
| 1 修复 | Maintenance Agent | 最小修复 + regression |
| 2 验证 | CI + Reviewer Agent(同一模型,reviewer role) | 全量测试 + contract 审查 |
| 3 决策 | GitHub(规则) | 全部满足才自动合并:全绿 + 无 forbidden 路径 + diff < 阈值 + 无依赖/API 变更 + reviewer pass;否则 needs-human |

**auto-merge 不是无条件:它只放行"证明过的小事",任何风险信号都升级人工。**

> **Phase 3 已实现(2026-08-17)**:判定由 `dsh-maint guard` 落地——维护分支(maintenance/ 前缀)+ verified 标签(evidence 闸门全过时 workflow 打上)+ 无 needs-human + attempts<3(PR body 解析)+ CI 全绿(mergeStateStatus=CLEAN/READY);放行 → `gh pr merge --squash --delete-branch` + 关 issue;拦截 → 打 needs-human + 输出全部原因。实测见 11 篇 §15(M4 里程碑达成)。

## 9. dsh-autopilot.yml(用户视角的完整配置)

```yaml
version: 1
agent: { provider: opencode-zen, model: deepseek-v4-flash-free }
schedule: { cron: "0 2 * * *", tz: Asia/Shanghai }
selection: { max_tasks_per_run: 1 }
repair: { max_attempts: 3, max_changed_files: 15, max_diff_lines: 500, max_runtime: 15m }
verification: { required: [typecheck, test, regression] }
git: { strategy: pull_request, branch_prefix: maintenance/ }
merge: { mode: guarded }
permissions:
  allow: [packages/**, tests/**, fixtures/**, .dsh/knowledge/**, docs/**]
  deny: [.github/workflows/release.yml, .dsh/autopilot.yml, LICENSE, secrets/**]
```

## 10. Flight Recorder 与 Cache

- 每次 run 把 trace.json / failure.json / diff.patch / test-report.json /
  benchmark.json 上传为 **artifact**(默认保留 90 天)= 完整的"AI 实验现场";
- pnpm store / node_modules / build 缓存用 actions/cache 跨 run 复用,
  runner 不必每次从零装环境。

## 11. 混合兜底:Local-Brain Mode

若某些环境(GitHub runner 出网受限 / 组织策略)跑不了大脑:

```text
GitHub 仍然负责身体:检测 → 生成任务 → 组装上下文 → CI 验证 → PR 闸门
"思考"步骤由 Mac 上的 dsh-maintenance 按需消费任务队列(workflow_dispatch 通知),
Mac 不需要常驻 —— 用户打开 Harness 时顺手跑 /dsh-maintain 即完成闭环。
```

同一套六工具与 contract,只是"大脑的位置"不同。**架构对两种模式统一。**

## 12. PoC 清单(Phase 0.5,先验证再开工)

1. ubuntu-latest / macos-latest 各跑一次:安装 opencode CLI(或 dsh headless)
   + Bearer public 完成一个**受控小任务**(读 1 个文件、回答一个问题);
2. 记录:runner 出网是否可达 opencode.ai、429 行为、pacing 参数效果、
   挂 OPENCODE_ZEN_API_KEY secret 后的额度差异;
3. 最小闭环:issue → agent 在分支改 1 个文件 → 测试通过 → 开 PR(人工 merge);
4. 出口标准:上述 PR 出现,且 budget/白名单在 run 中真实生效。

## 13. 明确不做

- 不做"一次修全部"(每 run 一个任务,防 token 爆炸);
- 不做无限重试(max_attempts 封顶);
- 不让 agent 改 release workflow / autopilot 配置 / 依赖版本(需人工);
- 不在 Phase 1 就开 auto-merge(先人工 merge 跑熟再说)。
