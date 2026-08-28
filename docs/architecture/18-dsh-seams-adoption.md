# 18 · DSH 宿主能力面采纳现状（2026-08-28）

> 目标：把本仓库插件与 DeepSeek Harness 宿主能力的接合点（seam）收归官方通道，
> 消除自造轮子与契约漂移。基于本地宿主包（`@deepseek-ai/*` 0.1.0-rc.6/rc.7）与
> 上游官方文档（develop/*、subsystems/*、cookbook/*，npm latest 0.1.1-rc.2）。

## 1. 版本对齐（已完成，含一次真隐患修复）

- 插件 pin 从 `0.1.0-rc.6` 升至 **`0.1.0-rc.7`**，与宿主 profile（dsh-base/web-app rc.7）一致。
- 此前 profile 内 **dsh-llm / dsh-tools 各存在 rc.6 + rc.7 两份副本**（我们的精确 pin
  与 dsh-base 的 range 各解析一份）——宿主 core 与插件 externals 可能跨副本取类，
  `LlmError`/brand 识别存在隐患。对齐 pin 后 pnpm 归并为单实例（已实测验证）。
- 注意：升级 **0.1.1 线**必须同时升宿主（dsh-base/web-app）与插件 pin，否则重新引入
  split-brain。`ctx.jobs` 后台任务运行时在宿主 0.1.2/master 才提供。

## 2. 已采纳（本轮落地，全部带回归测试）

| Seam | 落点 | 说明 |
|---|---|---|
| `ctx.systemPrompt.variable(name, provider)` | ui-reverse `src/index.ts` | 修复传对象导致 `{{COMPLETE_THRESHOLD}}` 从未替换的签名错误 |
| `ctx.systemPrompt.context()` | ui-reverse `src/index.ts` | 每轮 `.ui-reverse/state.json` 关键状态注入为 user-role 快照，替代模型手动 `state_read`（有界、缺席时空贡献） |
| `ctx.userQuestions.ask()` | ui-reverse `src/services/ask-user.ts` | 多选歧义询问走官方契约（questions/options/answers.selected·custom）；替换此前对 `ctx.approval` 的错误探测与错误传参 |
| `ToolDefinition.timeoutMs` | ui-reverse 9 个长任务工具 | browser/devserver/摄取/扇出/像素对比的宿主协作超时 |
| `exec.signal` | ui-reverse browser_*/devserver/reference | 官方契约 "Honor exec.signal"；Playwright API 原生透传，`page.evaluate` 用 raceAbort 包装 |
| `presentCall/presentResult/presentationMeta` | compare_screenshots、browser_screenshot、browser_dom_dump | generic 卡片 + meta 投影（纯函数，符合 replay 纯度规则） |
| `ctx.storageDomain`（dsh-storage） | ui-reverse `src/memory/state.ts` | **双后端**：宿主挂载 storage 时 state 走 `ui-reverse-state` domain（global 单槽，zod loose schema 防 strip、拒 null）；未挂载/open 失败自动回退 fs。zod 保持 external（宿主同实例） |
| schemastery `Config` | ui-reverse `src/config.ts` | `tol/completeThreshold/weights` 从"yml 传了但 apply 静默丢弃"变为 schema 校验 + `runtimeConfig` 热路径生效；`apply(ctx, config)` 接第二参数 |
| cordis `ctx.effect` 生命周期 | ui-reverse `src/index.ts` | Playwright/DevServer 不再是裸模块单例：fiber 卸载时整组 kill + await exit（官方 "Dispose must reach quiescence"） |

LLM 侧（llm-opencode-zen）：`temperature/stop/system/maxTokens/signal/reasoningEffort/tools`
对官方 GenerateOptions 契约逐字段透传（`options-map.test.ts` 锁住）；`top_p` 为适配器
自有采样默认（契约无 topP 字段，注释说明）。

## 3. 启用待定（代码就绪，等待宿主/组合决策）

| 项 | 现状 | 启用方式 |
|---|---|---|
| storage domain 持久化 state | 适配器 + 测试就绪，但 dsh-base rc.7 未注册 storage 服务，`ctx.storageDomain` 探测为空 → 走 fs | 在 cordis.patch.yml（bundle 层）插入 `@deepseek-ai/dsh-storage` + `@deepseek-ai/dsh-storage-json` 两行（npm 已有 0.1.0-rc.7）。影响全局组合，需宿主侧确认后启用 |
| `ctx.attachments.saveImage` | 截图/热图目前只回传路径 | 会话 UI 可渲染图片（模型侧 text-only 不可见）；待与客户端卡片联调 |
| `exec.agent.inject` | 被 `context()` 快照取代（同信息、零工具调用） | 若需"事件驱动补叙"再接 |
| `tools/pre-execute` 高风险 ask（git 回滚/merge 落盘） | 未接 | 需先确认宿主 approval 组合与 UX；接 `tools/guard()` 做收敛期只读亦同批 |
| Code Mode（PTC） | 工具 canonical value 已是程序友好 JSON，天然兼容 | 宿主部署 codeRuntime 后零改动可用；`fanout_evaluate` 批量测量最受益 |
| `ctx.subagents` 真子 agent 扇出 | `plan_experts`/`fanout_evaluate` 仍是单 agent 并行 + 硬编码预测分 | 单独立项（持久化子 agent、seed/delegation 语义需重新设计择优） |

## 4. 验证

- 全仓 `pnpm build && pnpm test` 全绿（含本篇新增 5 个测试文件）。
- `scripts/install-local.mjs` 优先走官方 `dsh plugin --profile web add`（pnpm
  `ignore-workspace-root-check` 子进程内解锁），失败回退手搓路径；Release 路径
  SHA-256 fail-closed 语义不变。
