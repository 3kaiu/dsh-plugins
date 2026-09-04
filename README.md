# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件 monorepo:LLM 适配器、UI 还原/逆向能力包与公共能力包,基于 pnpm workspace。

## 包结构

| 包 | 版本 | 职责 |
| --- | --- | --- |
| `packages/llm-opencode-zen` | [@3kaiu/dsh-llm-opencode-zen](./packages/llm-opencode-zen) | **LLM 适配器** — OpenCode Zen 免费模型(动态目录 + 设置页一键获取,默认不锁定单一模型 id):429/402 感知、per-session 冷却隔离、主动 pacing、用量遥测、tool-call JSON 修复、reasoning_content 回传 |
| `packages/layout-infer` | [@3kaiu/dsh-layout-infer](./packages/layout-infer) | **布局反推** — 裸坐标反推 flex 语义 + 还原决策分类,6 个 dsh 工具:`infer_layout` / `annotate_layout` / `clean_layout` / `classify_design` / `page_layout_tree` / `compare_layouts`(算法文档见 [docs/architecture/12-ui-restore-algorithm.md](./docs/architecture/12-ui-restore-algorithm.md)) |
| `packages/shared` | [@3kaiu/dsh-plugin-kit](./packages/shared) | **公共能力(源码包)** — 布局内核(坐标反推 flex/层级重建/清洗)、配额跟踪、并发信号量、测试助手;构建时被各插件 bundle 进各自 dist,零运行时依赖 |
| `packages/ui-restore` | [@ui-restore/core](./packages/ui-restore) | **UI 还原核心(零宿主依赖)** — 设计稿 DSL → 中立蓝图 → 多重门禁(契约/几何/样式/Yoga 真值) → 受限代码生成(React/Vue/Flutter/小程序/Tailwind);附 CLI、MCP Server 与收敛循环适配器 |
| `packages/ui-reverse-agent` | [@3kaiu/dsh-ui-reverse-agent](./packages/ui-reverse-agent) | **视觉逆向还原 Agent 插件** — 28 个 dsh 工具(参考摄取、浏览器闭环、五层对比/评分、反 hack、状态记忆、扇出择优、CI 门禁)+ persona/preset/skill;摄取/对比/CI 管线以 `@ui-restore/core` 正典蓝图为验证内核 |

> 注:`packages/shared` 中仍保留一份旧 UI 内核(供 `layout-infer` 消费),但**蓝图构建弱轨已退役** ——
> 蓝图正典在 `packages/ui-restore`(generateCodeBlueprint 组合管线),`ui-reverse-agent` 等消费方
> 一律 import 其 dist 导出;详见 [docs/architecture/16-generic-ui-restore-architecture.md](./docs/architecture/16-generic-ui-restore-architecture.md) §1/§6。

## 无头还原 Agent

设计稿 → 1:1 还原 → 验证的全自动闭环(编排器见 [scripts/run-restore-agent.mjs](./scripts/run-restore-agent.mjs),引擎能力全部来自 `@ui-restore/core` / `ui-reverse-agent` 的 dist 导出):

```sh
node scripts/run-restore-agent.mjs <design.json> [--dir out] [--inject] [--truth png] [--max 8] [--repair snapshot|llm|llm-dry] [--model <id>]
```

链路:`analyze`(四闸蓝图)→ `generate`(受限代码生成)→ truth 截图(含确定性回声校验)→ 收敛自环(渲染 → verifyOnce → 门禁 → 修复)→ `ui-reverse-agent` CI 报告(`S ≥ 0.96` + 四闸摘要),退出码即门禁结果。`--inject` 注入实现偏差(色值/位移)以验证检出-修复回路:iter1 检出 FAIL → 修复 → iter2 PASS。

修复通过 `runConvergeLoop` 的 `repairFn` 注入点接入,`--repair` 三模式:

- `snapshot`(默认, 确定性)—— 允许文件整体回滚 pristine 快照;`--inject` 场景撤销扰动即真修复
- `llm` —— 真 LLM 受限修复(OpenCode Zen 免费层, 默认 `mimo-v2.5-free`, `--model`/`RESTORE_AGENT_MODEL` 可覆盖):loop 受限 prompt + allowedNodes 开标签 + 蓝图真值(父相对 offset 坐标)→ 模型输出有界 `{edits:[{find,replace}]}` → 本地精确应用(find 必须逐字唯一命中, 解析器容错思维链混排/代码围栏)→ 交 loop validator(变更限值 + 回归回滚兜底)
- `llm-dry` —— llm 全链路但不出网(验证 prompt 构造/响应归一/validator 管道)

每个插件是独立 npm 包,自带 `dsh.bundle` manifest,可单独发布/安装/升级。

## 安装

要求 Node.js ≥ 20。插件随 dsh web profile 安装:`~/.dsh/profiles/web`。

### 一键安装(推荐)

GitHub Actions 云端构建产物并挂到 Release(tarball + SHA256SUMS),免 npm 发布、免提交 dist:

```sh
curl -fsSL https://raw.githubusercontent.com/3kaiu/dsh-plugins/main/scripts/install.sh | bash
#   从 Release 下载 tarball + SHA256SUMS,逐文件 SHA-256 校验后装进 web profile,
#   自动 reconcile dsh.profile.bundles;更新 = 重跑同一命令
#   指定版本: ... | bash -s -- --tag v0.3.0
#   只装部分: ... | bash -s -- --only layout-infer,llm-opencode-zen
```

### 源码开发

```sh
git clone https://github.com/3kaiu/dsh-plugins.git && cd dsh-plugins
pnpm install
node scripts/install-local.mjs   # pnpm build → dsh plugin add(回退 pnpm add file:)→ reconcile bundles
```

发布(可选):打任意 `v*` tag 并推送即触发 Actions → 自动 build + pack 2 个 tarball → Release(tag 名自动编码两包版本:`v<llm>+li<layout>`)。

## 配置

`llm-opencode-zen` 配置位于 `settings.yaml` 的 `llm-opencode-zen:` 下。

**模型目录(0.3.0 起)**:默认 `catalog: auto` —— 从 OpenCode 拉取免费模型目录(models.dev 元数据 ∩ `{baseURL}/models` 在服模型,1 小时缓存),不写死任何模型 id。`dsh` 侧把 `agent-default-model.model` 指到目录里任意免费 id 即可切换;`defaultModel` 只影响模型列表排序置顶。拉取失败时回退到静态 `models` 目录并告警一次。

**设置页一键获取(0.4.0 起)**:dsh web → 设置 → 插件 → **OpenCode Zen 模型** tab —— 自动列出当前可用的免费模型(名称/上下文窗口/输出上限,deprecated 标注),勾选后「应用到配置」即写入 `settings.yaml`(catalog=custom + models 全量字段,经官方 settings 服务校验持久化,配置卡即时刷新);要恢复自动跟随,把配置卡里 `catalog` 改回 `auto`。后端为插件自带的 `zenModels` Typert remote(`listFree` / `applyFree`)。

| Key | Default | Meaning |
| --- | --- | --- |
| `catalog` | `auto` | `auto` = 动态免费模型目录;`custom` = 使用下方 `models` 静态目录 |
| `defaultModel` | — | 首选模型 id,目录排序置顶 |
| `catalogRefreshMs` | `3600000` | auto 模式目录刷新间隔(≥60000) |
| `models` | `[]` | 静态目录(catalog=custom 生效;auto 失败时兜底) |
| `baseURL` | `https://opencode.ai/zen/v1` | API endpoint(`OPENCODE_ZEN_BASE_URL` env 覆盖) |
| `apiKeyEnv` | `OPENCODE_ZEN_API_KEY` | credential env;免费档用字面量 `public` |
| `thinking` / `reasoningEffort` | `enabled` / — | 推理支持与档位(`off`/`low`/`high`/`max`) |
| `maxConcurrentStreams` | `2` | 并发流上限 |
| `streamIdleTimeoutMs` | `300000` | 流停滞超时 |
| `pacing` | `{enabled:true, maxRequests:3, windowMs:20000, maxHoldMs:15000}` | 滚动窗口请求预算,在服务端 402/429 之前先等待 |
| `retryPolicy` | bundled | `RATE_LIMITED`/`QUOTA`/`TIMEOUT`/`TRANSPORT`/`STREAM_CLOSED` 可重试,最长退避 60s |
| `locale` | `zh` | 错误消息语言:`zh` / `en` |
| `userAgent` | `opencode/1.18.18 …` | 发给 OpenCode Zen 的 User-Agent |

## 开发

```sh
pnpm build   # 各包 esbuild minify -> dist/
pnpm test    # 各包 build + 全部测试套件(离线,mock fetch) + fork-parity 哨兵
npx tsc --noEmit    # 类型门禁(CI 阻塞, 必须 0 错误)
node scripts/run-benchmarks.mjs   # benchmark 3 案例回归(好例 diffRatio<0.02+区域归零, 坏例注入必检出)
```

- **fork-parity 哨兵**(`scripts/check-fork-parity.mjs`) — 引擎归一后校验 kit 与 ui-restore 对同一输入产出完全一致(inferLayout 双侧可调用/输出形状超集兼容/clean 行为一致),防止两处引擎漂移
- `layout-infer` — 布局内核边界、30 个真实设计稿 section 回归、还原决策分类(含真实 MasterGo DSL fixture)、工具注册冒烟
- `llm-opencode-zen` — 配额(402/429)与 reasoning_content 回传回归、动态免费模型目录(交集过滤/缓存/回降)

## 版本兼容

按 **DSH 0.1.0-rc.x+**(开发者预览版,API 可能破坏性变更)开发:所有 `@deepseek-ai/*` 包均为 **可选 peerDependencies(范围 `*`,不锁版本)** —— 运行时一律由宿主 dsh 提供,插件 tarball 不携带、不锁定任何 dsh 版本,dsh 升级后无需重装插件;若 API 发生破坏性变更导致不兼容,升级插件包即可。本地开发通过 `devDependencies`(npm dist-tag `next`)解析类型与测试环境,自动跟随上游最新 rc。`@3kaiu/dsh-plugin-kit` 保持零运行时依赖,可被插件 bundle,也可被外部工具直接 import 源码。

## License

MIT
