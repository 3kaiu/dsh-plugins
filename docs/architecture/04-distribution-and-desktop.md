# 04 · 发行层与桌面集成(Distribution & Desktop)

> 状态:**设计定稿(未执行)** · v0.3 重写
> v0.3 变更:桌面侧从"一个 PWA"升级为**两个 Web App**——官方 Harness Web
> (聊天/Agent 工作,零修改)与 DSH Console(驾驶舱,自建 PWA)。

## 1. 发行架构(分层,不揉成一个项目)

```text
macOS 用户
   │
   ├─▶ Dock 图标 1:DSH Console(3090,自建 PWA)
   │     驾驶舱:Dashboard/Sessions/Tasks/Failures/Health/Maintenance(07 篇)
   │
   ├─▶ Dock 图标 2:DeepSeek Harness(3080,官方 Web App,可选)
   │     聊天/会话/Agent 工作(官方 manifest,添加到程序坞即可)
   │
   ▼
dshctl / DShLauncher.app               生命周期层(✅ v0.1.0)
   │  install / start / stop / console / health / logs / update-gate
   ▼
dsh --profile personal web             官方 Core(固定版本,零修改)
   │
   ├── dsh-runtime                     感知层:事件采集 + WS + GitHub sync(08 篇)
   └── Profile 层:profiles/personal(稳定)+ profiles/dev(实验)
        └── 插件来自 3kaiu/dsh-plugins(dsh.bundle 注册)
```

## 2. Distribution Manifest(版本唯一事实来源)

```yaml
# versions.yaml(随 dsh-plugins 维护;dshctl 安装/升级时读取)
runtime:
  harness: 0.1.0-rc.6
  node: 24.19.0
profile: personal
console:
  port: 3090                 # DSH_RT_CONSOLE_PORT 可覆盖
plugins:
  "@3kaiu/dsh-llm-opencode-zen": 0.3.1
  "@3kaiu/dsh-runtime":           0.1.0
  "@3kaiu/dsh-reliability-core":  0.1.0
  "@3kaiu/dsh-layout-infer":      0.2.0
  "@3kaiu/dsh-harness-updater":   0.1.2
compatibilitySnapshot: matrix-2026-08-16
```

## 3. 目录约定(与底座对齐)

```text
~/.local/share/dsh-runtime/          # 已有:隔离 Node + 官方 dsh
~/.local/state/dsh-runtime/          # 已有:PID、日志
    └── events/… · token             # 新:事件库 + console 鉴权(08 篇)
~/.dsh/profiles/{personal,dev}       # 官方 DSH_HOME 的 profile 目录
~/.dsh/state/reliability/            # 规划:traces/findings/fixtures/matrix
```

## 4. personal 与 dev 双 Profile(不变,略)

personal(日常稳定组合)/ dev(实验调试组合),互不污染;升级仅走 manifest + matrix gate。

## 5. harness-updater 改造(不变,略)

只检查 + 通知 + matrix gate + 人工确认 + health check + rollback;不自动升级。

## 6. dsh-launcher 增量计划(Phase 1/4)

1. `dshctl console start|stop|status` —— 管理 dsh-runtime + console(3090);
2. `dshctl profile install personal` —— 按 manifest 装 profile + 插件;
3. `dshctl pin check` / `dshctl matrix` —— 版本校验与兼容性显示;
4. 菜单栏 App:增加 reliability/维护状态摘要;
5. `dshctl open` 默认打开 DSH Console(有则优先),官方 UI 用 `dshctl open-harness`。

## 7. 两个 PWA 的分工与原则(修订)

| | 官方 Harness Web | DSH Console |
| --- | --- | --- |
| 端口 | 3080 | 3090(仅 127.0.0.1 + token) |
| 代码 | 官方,零修改 | 自建 dsh-console(自带 manifest,display standalone) |
| 用途 | 聊天 / Agent 交互 | 感知 / 控制 / 分析 |
| Dock | 可选 | 默认(日常入口) |

原则:
- **不 iframe、不注入官方前端**;Console 与官方 UI 之间只放一个跳转按钮;
- 第一阶段**不做原生壳**(Pake/Tauri),直接 Safari 添加到程序坞,
  `⌘+Space → DSH Console` 已是独立 App 体验;等真有系统通知/菜单栏需求再评估;
- "为了像 App 而做 App"是禁止项。

## 8. 安全边界

- 3080/3090 均只绑定 127.0.0.1;console 另加首启生成 bearer token(0600);
- secrets 不进事件库(scrub 前置);
- 更新一律 https + SHA-256 校验;
- Developer/Production Agent 与网络出口策略分离(03/06 篇)。
