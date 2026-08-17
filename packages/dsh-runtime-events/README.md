# @3kaiu/dsh-runtime-events

DeepSeek Harness 插件:**运行时事件桥(runtime event bridge)** v0.1.0。

官方运行时没有公开的事件总线 API,但 cordis 事件面暴露了可订阅的 firehose。
本插件零耦合订阅该 firehose,把官方 session 事件归一化为 **09 篇协议的五族事件**
(`session` / `tool` / `error` / `test` / `completion`),以 JSONL 追加写入
`DSH_HOME/state/events/`(每族一个文件 + `all.jsonl`),`seq` 单调递增并持久化,
供 Console / GitHub 侧消费。实测记录见
[docs/architecture/11-poc-results.md §6](../../docs/architecture/11-poc-results.md),
事件 schema 单一事实源见
[docs/architecture/09-interfaces.md §3](../../docs/architecture/09-interfaces.md)。

## 五族事件

| 家族 | 类型 | 来源映射 |
| --- | --- | --- |
| `session` | `session.started` / `session.title` / `session.completed` | firehose 的 `session/title`、`request/context`、`session/disposed` 与退出兜底 |
| `tool` | `tool.started` / `tool.completed` / `tool.failed` | `tool/call` + `tool/result`(`isError` 派生 `exitCode=0/1`) |
| `error` | `error.recorded` | `llm/retry`(LLM_RETRY/LOW)+ 用量文件增量(RATE_LIMITED / QUOTA_EXCEEDED) |
| `test` | `test.completed` | 保留,由 GitHub 侧(`source=github`)填充 |
| `completion` | `completion.proposed` / `completion.verdict` | 保留,由 GitHub 侧(`source=github`)填充 |

每条包络(envelope)格式(`schema=1`):

```json
{ "schema": 1, "seq": 1, "eventId": "evt_<ulid26>", "family": "session",
  "type": "session.started", "at": "2026-08-17T00:00:00.000Z",
  "sessionId": "session-…", "source": "harness", "data": { "title": "…" } }
```

## 订阅面与映射

插件在 `apply(ctx)` 内订阅:

- `session/created` / `session/disposed` —— 会话生命周期(`disposed` 仅 web 会话触发);
- `session/event` —— firehose,每追加一条会话事件回调 `(session, event)`,
  `event = { type, seq, time, data }`;构造期种子事件不发布。

| 官方 type | 归一化输出 | 要点 |
| --- | --- | --- |
| `session/title` | `session.started`(首条时)+ `session.title` | title 直通 |
| `request/context` | `session.started`(首条时) | model/provider 累计进 started |
| `turn/start` / `turn/end` | 计入 `session.completed` | turns 计数;reason 取最后 turn/end 真实结果 |
| `assistant/chunk`(usage 段) | 累计进 `session.completed` | inputTokens/outputTokens |
| `tool/call` | `tool.started` | tool 名 + `inputSummary`(截断) |
| `tool/result` | `tool.completed` / `tool.failed` | `exitCode=0/1` 由 `isError` 派生;`latencyMs` = call→result 时间差;`stdoutTail` 截断 |
| `llm/retry` | `error.recorded` | taxonomy=LLM_RETRY,severity=LOW |
| 用量文件增量 | `error.recorded` | rateLimited → RATE_LIMITED/LOW;quotaExceeded → QUOTA_EXCEEDED/MEDIUM;`occurrences`=增量 |

## Headless 退出语义(实测坑)

headless 跑完即进程退出——不触发 cordis dispose、不触发 `session/disposed`,
且退出前有约 4 分钟 quiescence 等待期。插件两层兜底:

1. `turn/end` 后空闲 `idleCompleteMs`(默认 10s,续轮自动取消)即补发
   `session.completed`,让 Console 实时看到"完成";
2. `process.once("exit")` 兜底最终补发 + 落盘 `events/seq`;`seq` 每 25 条周期落盘,
   降低 headless 随时退出的丢失窗口。

## 输出

`DSH_HOME` 缺省 `~/.dsh`(可用环境变量覆盖),事件目录缺省
`$DSH_HOME/state/events/`:

- `all.jsonl` + `session.jsonl` / `tool.jsonl` / `error.jsonl` / `test.jsonl` / `completion.jsonl`;
- `seq` —— 全局单调序号,重启后继续(追加式事件库,只增不改)。

## 配置(settings 区 `runtime-events:`)

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | 插件开关 |
| `eventsDir` | `$DSH_HOME/state/events` | 事件 JSONL 输出目录 |
| `usagePollMs` | `5000` | 用量文件轮询间隔(1000–3600000) |
| `inputSummaryMax` | `200` | `tool.started.inputSummary` 截断长度 |
| `stdoutTailMax` | `500` | `tool.completed.stdoutTail` / `tool.failed.message` 截断长度 |
| `idleCompleteMs` | `10000` | turn/end 后空闲多久补发 `session.completed`(0=关闭) |
| `usageFile` | `$DSH_HOME/storages/llm-opencode-zen-usage.json` | 用量增量文件路径 |

## 开发

```sh
pnpm --filter @3kaiu/dsh-runtime-events build   # esbuild → dist/
pnpm --filter @3kaiu/dsh-runtime-events test    # build + 单测(test/events.test.mjs)
```

单测基于 2026-08-17 实证抓取的真实 firehose 形状(隔离 home,deepseek-v4-flash-free),
覆盖映射、interrupted 补发、ulid 形状、sink 追加/续 seq、空闲补发不重复。

## License

MIT