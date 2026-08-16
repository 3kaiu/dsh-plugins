# 03 · 自维护协议:模型是大脑,插件是神经系统

> 状态:**设计定稿(未执行)** · v0.2 重写
> 核心观念(本轮的定性变化):不是"写一个 AI 来维护插件",而是
> **让正在使用 OpenCode Zen 的免费模型本身成为维护者**。
> 项目不养模型、不提供 API Key、不需要服务器;只提供环境、工具、约束、记忆。

## 1. 已验证的事实(源码级,决定可行性)

| 事实 | 来源 | 对自维护的含义 |
| --- | --- | --- |
| 免费层认证 = 字面 Bearer `public` | llm-opencode-zen/src/index.js(注释 + 请求头) | 无头环境(含 GitHub Actions)零凭证即可调用,大脑零成本 |
| 可选 `OPENCODE_ZEN_API_KEY` 提额 | DEFAULT_API_KEY_ENV | 需要更高额度时,一个 GitHub Secret 即可 |
| 端点 opencode.ai/zen/v1,可覆盖 | PUBLIC_BASE_URL / OPENCODE_ZEN_BASE_URL | 可接镜像/代理,不与网络出口绑定 |
| UA 默认跟随官方 CLI、可配置 | OPENCODE_UA + userAgent 配置项 | 兼容手段而非策略;源码已警告服务端加签名即失效 |

**结论:认证不构成障碍。真正的工程风险是行为约束(见 §8/§9)与
CI 出口 IP 的 429 争用(见 06 篇 PoC)。**

## 2. 关系图

```text
OpenCode Zen 免费模型          ← 大脑(理解/推理/搜索/修改/调试/决策)
        │
        ▼
DeepSeek Harness               ← 宿主
        │
        ├── llm-opencode-zen   ← 稳定的 LLM Provider(不承担维护职责)
        │
        └── dsh-maintenance    ← 神经系统 + 手术室
             ├── 状态(status)  ├── 证据(fixtures)
             ├── 复现(reproduce) ├── 测试(test)
             ├── 回放(replay)  ├── 验证(verify)
             ├── 约束(contract) └── 记忆(knowledge)
```

## 3. Maintenance Mode(任务模式)

正常情况下模型在"工作态";当检测到维护机会或用户触发时进入"维护态":

```text
工作态 ──(failure record / 用户 / 调度)──▶ 维护态
                                            │
                          status → inspect → reproduce → read source
                          → edit → test → replay → verify → regression
                                            │
                          ◀──(pass / budget 超限)── 退出维护态 → patch → 人工审批
```

模型使用 Harness 自带的 fs.read / grep / search / edit / shell 读改源码,
维护态只增加**标准化维护工具**,不新增"特权通道"。

## 4. Maintenance API(第一版六个工具)

| 工具 | 作用 | 输出示例 |
| --- | --- | --- |
| `dsh_maintenance_status` | 列出维护事项(严重度/频率/可复现) | "3 issues:1 HIGH(reasoning replay)" |
| `dsh_maintenance_inspect` | 事件详情(期望 vs 实际、涉及组件) | expected/actual/component/trace |
| `dsh_maintenance_reproduce` | 在隔离环境重放最小复现 | "PASS×3 → FAIL,稳定复现" |
| `dsh_maintenance_test` | 针对修复跑定向测试 | before:FAIL / after:PASS |
| `dsh_maintenance_replay` | 用历史 trace 回放对比 | 新旧版本结果 diff |
| `dsh_maintenance_verify` | 全量回归 + 契约校验 | "143/143 PASS,contract OK" |

后续(Phase 3/4):checkpoint、benchmark、budget、auto-pr、knowledge-graph。

## 5. Maintenance Contract(机器可读宪法)

```yaml
maintenance:
  repository: dsh-plugins
  allowed: [packages/**, tests/**, fixtures/**, .dsh/knowledge/**, docs/**]
  forbidden: [.github/workflows/release.yml, .dsh/autopilot.yml, LICENSE, secrets/**]
  requirements: [reproduction_required, regression_required, tests_required,
                 no_unrelated_changes]
  completion:
    require: [reproduction_pass, regression_pass, typecheck_pass, build_pass]
```

模型每次维护都必须遵守;**改行为之前先改 contract**(见 02 篇兼容契约)。

## 6. Engineering Memory(工程记忆,不是偏好记忆)

```text
.dsh/
├── incidents/    2026-08-16-001/ {metadata,request,response,trace,environment}.json
├── fixtures/     按 taxonomy 分类的 input/expected/actual
├── regressions/  每个 fix 必留的回归测试
├── decisions/    修/不修决策记录(issue→severity×frequency→action)
└── knowledge/
    ├── compatibility.md   按 OpenCode Zen / DeepSeek 组件组织的经验树
    ├── known-failures.md
    └── decisions.md
```

下次遇到相似问题,模型先搜 knowledge 再动手——免费模型的能力被经验库放大。

## 7. 触发三级(由保守到自动)

| 级别 | 触发 | 备注 |
| --- | --- | --- |
| L1 手动 | 用户 `/dsh-maintain` / `dsh maintain` / Console 的 [Fix] 按钮 | 第一版默认 |
| L2 建议 | 检测到 failure → "maintenance opportunity" → 模型决定现在修/忽略 | 第二版 |
| L3 自动 | failure → 队列 → 自动进入维护(带 budget) | 谨慎开放,见 06 |

## 8. 决策自主权:模型决定"要不要修"

```text
Issue #182: frequency=1, severity=LOW, reproducible=NO, affected=0.01% → 建议 ignore
Issue #183: frequency=328, severity=HIGH, reproducible=YES, regression=YES,
           affected=all Zen users → 修
```

决策本身落盘到 decisions/,形成可审计的取舍历史。

## 9. 隔离与可审计(不让 AI 改运行中的自己)

```text
AI → 提出修改 → 创建 isolated workspace(分支或 copy)
    → 运行 reproduction → 修改 → 运行 regression → 验证
    → 生成 patch → 人工 / policy approve → merge
```

- 生产环境中的插件运行实例**永不热改**;实验走官方 extensions 临时 mount;
- 修改永远可审计、可回滚、可验证。

## 10. 双角色自评审(同一个免费模型)

同一模型、两个 system role:`Developer Agent` 写补丁,`Reviewer Agent`
按 contract 审查(diff 范围、回归覆盖、无关改动)。Phase 4 引入。

## 11. 权限模型(沿用并强化)

| 角色 | 权限 | 边界 |
| --- | --- | --- |
| Production Agent | 只写 diagnostics / logs / failure record | 禁止 git 写操作 |
| Maintenance Agent | 分支、改代码、跑测试、开 PR | 禁止 push main、禁止 force-push |
| Human | review PR、merge、tag | 最终裁决 |

## 12. 明确不做

- 不做生产环境自热更新;
- 不让 AI 以"绕过限制"为目标(UA 伪装、绕过 429);
- 不自动合并 PR(哪怕全绿;guarded auto-merge 属 06 篇,且有独立约束);
- 不把维护逻辑塞进 llm-opencode-zen(它只做稳定 Provider)。
