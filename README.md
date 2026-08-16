# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件 monorepo:
三个互相独立的插件 + 一个公共能力包,基于 pnpm workspace,与官方仓库
(`packages/*` 各自独立 `@deepseek-ai/dsh-*` bundle)结构对齐。

## 包结构

| 包 | 版本 | 职责 |
| --- | --- | --- |
| `packages/llm-opencode-zen` | [@3kaiu/dsh-llm-opencode-zen](./packages/llm-opencode-zen) | **LLM 适配器** — 面向 OpenCode Zen 免费额度(`deepseek-v4-flash-free`)的弹性适配:429/402 感知、per-session 冷却隔离、主动 pacing、用量遥测、tool-call JSON 修复、reasoning_content 回传 |
| `packages/harness-updater` | [@3kaiu/dsh-harness-updater](./packages/harness-updater) | **更新器** — 每天一次 registry 检查 + npx 缓存预热;零运行时依赖 |
| `packages/layout-infer` | [@3kaiu/dsh-layout-infer](./packages/layout-infer) | **布局反推工具** — 把设计稿裸坐标反推为 flex 语义(`infer_layout` / `annotate_layout` 两个 dsh 工具) |
| `packages/shared` | [@3kaiu/dsh-plugin-kit](./packages/shared) | **公共能力(源码包)** — 配额跟踪、并发信号量、布局内核、测试助手;被各插件构建时 bundle 进各自 dist |

每个插件包都是独立的 npm 包,自带 `dsh.bundle` manifest(`cordis.patch.yml`),
可单独发布、单独安装、单独升级。公共能力抽到 `@3kaiu/dsh-plugin-kit`,
杜绝"三个插件耦合在一个包"和"同类逻辑重复造轮子"。

## 安装

要求 Node.js ≥ 20(开发环境使用 pnpm workspace)。

### 本地开发安装(未发布时)

```sh
pnpm install
pnpm install:local   # = pnpm build && node scripts/install-local.mjs
```

`install-local.mjs` 对 `$DSH_HOME/profiles/web`:
1. 用 `pnpm add file:<abs>` 把三个插件装进 profile 的 node_modules(与发布后
   `dsh plugin --profile web add <pkg>` 等效);
2. 把声明了 `dsh.bundle` 的依赖 reconcile 进 `dsh.profile.bundles`
   (即 `dsh plugin add` 在安装后自动做的那一步);
3. 清理 profile patch 中旧的插件条目(插件注册改由 bundle 层 patch 提供)。

重启 dsh(或等 HMR)后生效。

### 分发与安装(不需要 npm 账号)

发布到 npm **不是必须的**——仓库内置 GitHub Actions
(`.github/workflows/release.yml`),打 tag 即自动构建 + `pnpm pack` 并把
tarball 挂到 GitHub Release:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

安装 tarball(用户侧,无需构建授权、无需 npm):

```sh
dsh plugin --profile web add https://github.com/3kaiu/dsh-plugins/releases/latest/download/3kaiu-dsh-llm-opencode-zen-0.2.0.tgz
dsh plugin --profile web add https://github.com/3kaiu/dsh-plugins/releases/latest/download/3kaiu-dsh-harness-updater-0.1.0.tgz
dsh plugin --profile web add https://github.com/3kaiu/dsh-plugins/releases/latest/download/3kaiu-dsh-layout-infer-0.2.0.tgz
```

tarball 内已含构建产物(`dist/` + `cordis.patch.yml`),运行时依赖
(`@deepseek-ai/*`、`schemastery`、`eventsource-parser`)声明在
`dependencies` 中,安装时由 pnpm 装入 profile 的 store,插件 dist 的
external import 即可解析(已按此流程实测验证)。

> 说明:官方也支持 `dsh plugin add github:you/repo` 直接装 git 源码,但那会
> 安装**仓库根**且要求包的 `prepare` 脚本自包含——对 monorepo 不适用,
> 所以本仓库走"构建产物(tarball)"路线。等发布到 npm 后,安装可简化为
> `dsh plugin --profile web add @3kaiu/dsh-llm-opencode-zen`。

### 发布后安装

```sh
dsh plugin --profile web add @3kaiu/dsh-llm-opencode-zen
dsh plugin --profile web add @3kaiu/dsh-harness-updater
dsh plugin --profile web add @3kaiu/dsh-layout-infer
```

## 配置

`llm-opencode-zen` settings 区位于 `settings.yaml` 的 `llm-opencode-zen:` 下:

| Key | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `https://opencode.ai/zen/v1` | API endpoint(`OPENCODE_ZEN_BASE_URL` env 覆盖) |
| `apiKeyEnv` | `OPENCODE_ZEN_API_KEY` | 更高额度的 credential env;免费档用字面量 `public` |
| `thinking` / `reasoningEffort` | `enabled` / — | 推理支持与档位(`off`/`low`/`high`/`max`) |
| `maxConcurrentStreams` | `2` | 并发流上限 |
| `streamIdleTimeoutMs` | `300000` | 流停滞超时 |
| `pacing` | `{enabled:true, maxRequests:3, windowMs:20000, maxHoldMs:15000}` | 滚动窗口请求预算,触发服务端 402/429 **之前**先等待 |
| `retryPolicy` | bundled | `RATE_LIMITED`/`QUOTA`/`TIMEOUT`/`TRANSPORT`/`STREAM_CLOSED` 可重试,最长退避 60s |
| `models` | `deepseek-v4-flash-free` | 模型目录(context window、max tokens) |
| `locale` | `zh` | 错误消息语言:`zh` / `en` |
| `userAgent` | `opencode/1.18.18 …` | 发给 OpenCode Zen 的 User-Agent(默认模拟官方 CLI;服务端若校验 UA 可在此覆盖) |

## 开发

```sh
pnpm build   # 各包 esbuild minify -> dist/(@3kaiu/dsh-plugin-kit 被 bundle 进各插件 dist)
pnpm test    # 各包 build + 全部测试套件
```

测试套件(全部离线,mock fetch):

- `packages/shared/test/layout-core.test.mjs` — 布局内核边界(mode 众数语义、flex
  模拟公式、交叉轴对齐、网格容差聚类、降级路径),自包含。
- `packages/layout-infer/test/layout-infer.test.mjs` — 30 个真实设计稿 section 的
  回归(fixtures 已提交),黄金数字:132 节点 / 44 容器 / 16 flex / 28 absolute。
- `packages/layout-infer/test/plugin-register.test.mjs` — 工具注册冒烟测试(对 dist)。
- `packages/llm-opencode-zen/test/rate-limit.test.mjs`、`reasoning-echo.test.mjs` —
  配额(402/429)与 reasoning_content 回传回归。

## 版本兼容

所有插件按 **DSH 0.1.0-rc.6**(开发者预览版,API 可能破坏性变更)开发:
`@deepseek-ai/*` 运行时依赖固定 0.1.0-rc.6,声明在 `dependencies`
(安装时由 pnpm 装入 profile 的 store,与官方"内置包始终从 dsh 安装目录解析"
互不冲突,已实测验证);workspace 内测试用 `devDependencies` 固定同一版本。
升级 DSH 后如遇插件不兼容,优先检查依赖版本。

公共能力包 `@3kaiu/dsh-plugin-kit` 保持零运行时依赖(不 import 任何
`@deepseek-ai/*`),因此既可被插件 bundle,也可被外部工具(MasterGo 脚本等)
直接 import 源码。

## License

MIT
