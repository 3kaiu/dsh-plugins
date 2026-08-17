# 10 · DSH Console 前端组件级设计

> 状态:**已执行(basic.tsx 组件库 + 七个页面落地于 packages/dsh-console/src,实测见 11 篇 §22)** · v0.4 新增
> 目标:把 07 篇产品设计落到可实现的组件/数据流/文件清单。

## 1. 技术栈决策

| 选项 | 结论 | 理由 |
| --- | --- | --- |
| 框架 | **Preact + @preact/signals** | 3KB 级;signals 模型天然匹配"事件流 → 状态 → 视图" |
| 构建 | **Vite**(静态产物,由 dsh-runtime serve) | 零配置,产物小 |
| 样式 | 纯 CSS 变量 + 暗色主题,**不引组件库/Tailwind** | 页面是仪表盘,自绘更可控 |
| 语言 | TypeScript(strict) | schema 与 shared 包直接复用类型 |
| 路由 | hash 路由自写(#/dashboard 等) | 避免 SSR/历史 API 复杂度 |
| Service Worker | **不用** | 本地动态数据,缓存只会带来旧状态 |

对比否决:React 全家桶(重)、Vue/Svelte(无额外收益)、原生 DOM(状态同步手写成本高)。

## 2. 数据流(runtime client → store → view)

```text
runtimeClient
 ├─ REST 回放:打开页面 → GET /api/events?since=localStorage.seq → 灌入 store
 ├─ WS 订阅:families=[session,tool,error,test,completion] → 增量推送
 └─ 断线重连:REST 补齐(用最近 ack 的 seq)→ 重新订阅

eventStore(signals)
 ├─ events: Envelope[](滚动窗口 5000 条)
 ├─ seq / connected / lastSyncAt
 ├─ sessions: Map<id, {title, stats, timeline}>
 ├─ failures: 按 taxonomy×severity 聚合
 └─ health: /api/health/summary 轮询(30s)+ 手动刷新

视图组件订阅 signals,不做组件内请求。
```

## 3. 组件树(每页)

| 页面 | 组件 | 数据源 |
| --- | --- | --- |
| Dashboard | ActiveAgentsCard(运行中会话:tools/tokens/progress/phase)、HealthStrip、MorningReport | sessions + health |
| Sessions | SessionList、ActivityFeed(虚拟列表)、TimelineView(Plan 分支)、ReasonDrawer | events/session 过滤 |
| Tasks | TaskComposer(+New Task)、TaskList(本地+GitHub) | /api/tasks |
| Failures | FailureGroup(聚合列表)、FailureDetailDrawer(Inspect/Replay/Fix 按钮) | failures 聚合 |
| Health | ScoreCard 组、WeeklyStats、AttributionPanel(Phase 4 占位) | health.summary |
| Maintenance | AutopilotStatus、OvernightReport | github.summary |
| Settings | 表单:端口/保留期/repo/token/UA | 本地 config |

基础组件仅 6 个:Card、Drawer、ProgressBar、StatusDot、Tag、EmptyState。
**禁止为一次性样式建组件。**

## 4. 布局与路由

- 顶栏:●/○ 连接状态点 · 3080 跳转按钮("打开 Harness")· 刷新;
- 侧栏:7 页导航(hash);主体:单列内容,最大宽 1280;
- 路由:#/dashboard(默认)/sessions/tasks/failures/health/maintenance/settings。

## 5. manifest 与 PWA

```json
{ "id": "/", "name": "DSH Console", "short_name": "Console",
  "start_url": "/", "scope": "/", "display": "standalone",
  "icons": [ { "src": "/favicon.svg", "sizes": "any", "type": "image/svg+xml" } ] }
```

- 无 service worker(见 §1);图标复用 tools/gen-icon.mjs 的生成器改一版;
- Safari「添加到程序坞」后与官方 DeepSeek Harness 并存,互不影响。

## 6. 文件清单(MVP)

```text
packages/dsh-console/
├── src/
│   ├── main.tsx                 # 挂载 + 路由
│   ├── runtime/client.ts        # WS + REST(协议见 09 篇)
│   ├── stores/events.ts         # signals store
│   ├── stores/health.ts
│   ├── components/basic/*.tsx   # Card/Drawer/ProgressBar/StatusDot/Tag/EmptyState
│   ├── pages/dashboard.tsx · sessions.tsx · tasks.tsx · failures.tsx
│   │       health.tsx · maintenance.tsx · settings.tsx
│   └── styles.css               # CSS 变量 + 暗色主题
├── public/manifest.webmanifest · favicon.svg
├── vite.config.ts
└── package.json                 # deps: preact, @preact/signals;dev: vite, typescript
```

构建产物 `dist/` 由 dsh-runtime 内置 serve(3090),console 随 runtime 一起发布,
不单独部署。

## 7. MVP 明确不做

- 无 service worker、无登录界面(token 自动注入)、无图表库(纯 CSS 条)、
  无 i18n 框架(中文硬编码)、无 SSR、无拖拽布局;
- AttributionPanel / Agent Score 完整版留 Phase 4 占位组件;
- 不做移动端适配(桌面驾驶舱)。

## 8. 与官方 UI 的关系(重申)

仅顶栏一个 `http://127.0.0.1:3080` 的跳转链接;不注入、不 iframe、不读取
官方前端资源。两个 PWA 各自独立更新。
