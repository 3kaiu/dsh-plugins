# AGENTS.md — 仓库导航(任何 Agent 会话从这里开始)

DeepSeek Harness 插件 monorepo: OpenCode Zen LLM 适配器、布局推断、UI 还原核心(@ui-restore/core)、视觉逆向 Agent、共享插件 kit。

## 包地图

| 包 | 职责 | 产物 |
|----|------|------|
| `packages/shared` (@3kaiu/dsh-plugin-kit) | 公共能力正典: 纯布局引擎(inferLayout/simulateFlex/聚类)、dsl-clean、classify、repeat、url-guard、CJK、semaphore、test-utils | bundle 进各插件 dist |
| `packages/layout-infer` (@3kaiu/dsh-layout-infer) | 布局推断壳包(classify 自 kit 再导出) | dist/index.js |
| `packages/llm-opencode-zen` (@3kaiu/dsh-llm-opencode-zen) | OpenCode Zen LLM 适配器(node+browser 双半) | dist/index.js + dist/client.js |
| `packages/ui-restore` (@ui-restore/core) | UI 1:1 还原核心: 设计稿 → 中立蓝图 → 验证 → 受限生成 | dist/ 多入口(cli/mcp-server/pipeline/restore/loop/screenshot/dom-blocks) |
| `packages/ui-reverse-agent` (@3kaiu/dsh-ui-reverse-agent) | 视觉逆向 Agent(28 工具面): 摄取/对比/CI 管线已切 @ui-restore/core 正典蓝图, kit 不再持有蓝图构建(弱轨退役) | dist/index.js |

## 命令(全部从仓库根)

```bash
pnpm build                 # 全仓构建(esbuild 压缩产物; ui-restore 为多入口 splitting)
pnpm test                  # 全仓测试 + scripts/check-fork-parity.mjs 哨兵
npx tsc --noEmit           # 类型门禁(CI 阻塞, 必须 0 错误 —— 新代码必须过)
node scripts/run-benchmarks.mjs            # benchmark 3 案例回归(好例收敛 + 坏例必检出)
node scripts/run-restore-agent.mjs <design.json> [--dir out] [--inject] [--max 8]   # 无头还原 Agent 自环: analyze→generate→渲染→收敛→CI 报告(exit code 即门禁)
node scripts/install-local.mjs             # 装进本地 dsh web profile(dsh CLI 优先)
DSH_HOME=$(mktemp -d) node scripts/install-local.mjs   # 隔离验证(不碰真实 profile)
```

## 门禁清单(改任何代码前知道会撞上什么)

1. **类型 0 错误**(阻塞 CI): 无类型 JS 风格需补 `Record<string, any>` 级注解; 配方见 `git log --grep "类型清零"`。
2. **全仓测试**(~456 断言): 含 ui-restore 引擎/门禁/收容、MCP 工具面集成 29 断言(spawn 真实 server)、安装双路径隔离验证不可跑 CI(需 dsh CLI)。
3. **fork-parity 哨兵**: 引擎归一后校验 kit 与 ui-restore 输出同一性。
4. **benchmark 3 案例**: `benchmarks/case-*`(好例 diffRatio<0.02+区域归零; 坏例注入必检出)。**新案例先入 benchmarks 再改算法**。
5. **四闸**(ui-restore 管线内): 契约/几何守恒/样式守恒/Yoga 真值 —— 任一 FAIL = 蓝图失真。

## 非协商约定

- **Design Truth > LLM Assumption**: 蓝图数值是设计稿测量事实, 禁止取整/"合理化"
- **消费压缩产物**: 一切按 `dist/*.js` 使用(源码仅开发); 改源码后必须 `pnpm build`
- **单一来源纪律**: 引擎/聚类/round1/url-guard 等正典在 kit —— 不要在别处重写同名函数; 新公共能力进 kit 并导出; **蓝图正典在 @ui-restore/core**(kit 弱轨已退役) —— ura 等消费方一律 import 其 dist 导出, 禁止重写管线逻辑
- **角色词表是几何语义**(doc19 批3): status-bar/nav-bar/grid-row/card-deck/segmented-bar/feature-card/sticker-card 等; 语言绑定的 learn-card/content-tabs 已退役
- **供应链**: 新插件进入 harness 必须在 `scripts/install-shared.mjs` 的 TRUSTED_BUNDLES 显式登记; 第三方 action 一律 SHA 钉死

## 文档索引(docs/architecture/)

| 文档 | 内容 |
|------|------|
| doc12 | ui-restore 算法(clean/flex 反推/角色) |
| doc14/15 | 排版/DSL 渲染 |
| doc16/17 | 通用还原架构/实施计划 |
| doc18 | DSH seams 采纳矩阵(部分项待宿主 0.1.1+) |
| doc19 | 收敛内聚与模块复用(已执行完毕, 含全部真 bug 留痕) |
| AGENT-LOOP.md | 无头 Agent 自环运行记录 |

## Agent 消费入口

- UI 还原工作流: `packages/ui-restore/skill/SKILL.md`(六段工作流 + MCP 10 工具消费指南)
- UI Restore Agent 使命/工具映射: `agents/ui-restore/AGENT.md`
- 视觉逆向: `packages/ui-reverse-agent/skills/ui-restore/SKILL.md`
