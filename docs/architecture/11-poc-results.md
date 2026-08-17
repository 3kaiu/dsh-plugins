# 11 · Phase 0.5 实测记录(OpenCode Zen 无头探测)

> 状态:**实测完成(2026-08-16)** · v0.4 新增
> 位置:dsh-plugins 分支 poc/phase05-zen-probe(PR #1)

## 1. 三个经验问题的实证答案

| 问题 | 答案 | 证据 |
| --- | --- | --- |
| 出网可达性 | ✅ 可达 | GET /models → 200(~1.1~1.4s) |
| Bearer public 认证 | ✅ 认证成功 | 裸请求 → 429(非 401);指纹齐全 → 200 |
| 429 行为 | **网关按客户端指纹分流** | 同 IP 同时刻:裸 curl → 429;伪造 opencode 客户端 → 200 |

**结论(修正此前假设)**:之前把 429 归因于"免费额度耗尽"是**错的**——
同一时刻、同一出口,裸请求 429 而指纹请求 200,证明 429 由**请求形态**触发。
免费层对"非 opencode 客户端形态"的流量直接拒绝。这**实证了插件模拟客户端
做法是免费层可用性的前提**;插件源码的脆弱性声明也得到印证:服务端确实校验
客户端形态,只是当前是软校验(UA + headers 即可通过,无签名)。

## 2. 指纹规格(Phase 1 直接使用;与 llm-opencode-zen 同构)

```text
User-Agent: opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
x-opencode-client: cli
x-opencode-project: proj_<12B base64url>          # 按安装持久化(quota 文件)
x-opencode-session: ses_<sha256("default:"+projectId) base64url 前16字符>
x-opencode-request: msg_<12B base64url>           # 每请求新生成
Authorization: Bearer public                      # 免费层;OPENCODE_ZEN_API_KEY 提额
Content-Type: application/json
```

```json
// body(必须 stream:true,真实客户端恒流式;响应 SSE 至 [DONE])
{ "model": "deepseek-v4-flash-free",
  "messages": [ { "role": "user", "content": "…" } ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 256, "top_p": 0.95 }
```

wire 要点(实测踩坑):
- **reasoning_effort 仅在非 off 时发送**;wire 枚举为
  none/minimal/low/medium/high/xhigh/max,内部枚举(off/low/high/max)≠ wire 枚举;
  off → **省略字段**(发送 "off" 会 400,已实测);
- 上游为 sglang OpenAI 兼容端点(400 错误体暴露 /sgl-workspace/... 栈);
- 行为表:无指纹 → 429 FreeUsageLimitError;指纹+非法 body → 400(透出上游校验);
  指纹+合法 body → 200 SSE。

## 3. 对 Phase 1 的工程含义

1. agent-loop / autopilot 的大脑调用**必须复用插件形态**(走 dsh + llm-opencode-zen
   全栈,或复制本指纹),**禁止裸调**;
2. pacing 仍必要:指纹解决"形态识别",不解决"频率"(插件注释:服务端约每 3 次
   成功请求后按窗口限流);
3. 免费额度真耗尽时错误形态为 402(插件已处理);429 优先怀疑形态而非额度;
4. CI 验证完成(2026-08-16,run 31953638701):ubuntu + macos 双 runner 均出网可达
   (models 200,132/197ms)且 chat 首试即 200(POC_OK,1149/1453ms),
   GitHub 出口 IP 无额外 429,指纹形态在 CI 同样成立;
5. OPENCODE_ZEN_API_KEY 提额路径待配置 secret 后验证(当前 key_variant=no)。

## 4. 原始数据(飞行记录)

- 本地三组:裸 429×3(40/80s 退避内不恢复)→ 指纹 400(reasoning_effort:"off")
  → 指纹 200 + POC_OK(2225ms,SSE [DONE],task_passed=yes);
- 完整原始响应保留于各次运行的 out_dir(result.json/summary.txt/chat.N.*);
  CI 侧 artifact 保留 7 天;
- CI(run 31953638701,workflow poc-headless-zen):ubuntu-latest chat 200/1149ms
  task_passed=yes;macos-latest chat 200/1453ms task_passed=yes;均 sse_done=yes,
  fingerprint 各 runner 独立持久化。

## 5. 附:agent-loop 最小闭环实测(Phase 1 首件,2026-08-16)

workflow agent-loop(main 上,手动触发)复刻本地全栈配方并一次跑通:

1. CI 内 npm i -g @deepseek-ai/dsh@0.1.0-rc.6 + 仓库本地构建插件
   (cd packages/llm-opencode-zen && node build.mjs,入口相对 CWD,需在包目录执行);
2. dsh plugin 转发 pnpm 不传 -w,需 pnpm add -w file:... + 手动 reconcile
   bundles(install-local.mjs 已记录此坑);
3. agent-default-model: {provider: opencode-zen, model: deepseek-v4-flash-free}
   (DSH_HOME/settings.yaml)——与本地/桌面完全同一形态;
4. dsh --profile headless "<task>" 真实跑通:Agent 运行测试(rate-limit.test.mjs
   全绿)→ 写 docs/architecture/AGENT-LOOP.md → 输出 VERDICT: pass,
   全程约 40-60s,零凭证;
5. 提交 + 推分支 ✅(远端 agent-loop/<ts> 分支,含记录文件);
6. PR 创建被仓库设置拦截(GitHub Actions is not permitted to create or approve
   pull requests),工作流已降级为打印 PR 链接并成功退出;勾选仓库
   Settings → Actions → General → Allow GitHub Actions to create and approve
   pull requests 后即自动开 PR(人工 merge 不变)。

工程含义:Phase 1 的 agent-loop/autopilot 直接复用此配方;Agent 工具行为有 LLM
方差(有的轮次自行 git commit),PR 步骤以 origin/main 为 diff 基准兜底。

## 6. 附:dsh-runtime 事件桥实测(Phase 1 第二件,2026-08-17)

结论先行:官方运行时**没有公开的事件总线 API**,但 cordis 事件面暴露了可订阅的
firehose——插件零耦合接入,无需 tail 磁盘日志(会话 JSONL 为 zstd,且 headless
下实测只有 header 行,不承载事件;事件仅在进程内 firehose 上实时发布)。

**订阅面**(插件 apply 内 ctx.on):
- `session/created` / `session/disposed`(生命周期,disposed 仅 web 会话触发)
- `session/event`(firehose:每追加一条会话事件回调 (session, event),
  event = { type, seq, time, data };构造期种子事件不发布)

**实证事件形状**(真实工具调用会话,deepseek-v4-flash-free,headless):

| 官方 type | data 要点 | 用途 |
| --- | --- | --- |
| permission/preset, sandbox/mode, approval/policy | preset/mode/policy | 会话环境(暂不转发) |
| agent/inbox/spliced | target/start/inserted | 消息拼接(暂不转发) |
| turn/start, turn/end | turn;reason.kind=completed/error | 轮次计数、完成原因 |
| step/start, step/end | turn/step | 步进(暂不转发) |
| user/message | content/role/id | 输入(暂不转发) |
| session/title | title/messageSeqs/source | session.title |
| request/context | provider/model/contextWindow | session.started 的 model |
| session/title-llm-request | titleProvider/messages | 标题 LLM 请求(暂不转发) |
| assistant/chunk | chunk.type=block-start/reasoning-delta/tool-call-delta/block-end/usage/finish | 流式;usage 段累计 tokens |
| assistant/message | message+usage | 完成消息(暂不转发) |
| **tool/call** | callId/name/arguments | **tool.started** |
| **tool/result** | message.content[].tool-result{isError,text} | **tool.completed / tool.failed** |
| llm/retry | error | **error.recorded(LLM_RETRY)** |

**映射到 09 协议**(packages/dsh-runtime-events v0.1.0,零依赖官方内部模块):

- session.started ← 首个 {session/title 或 request/context} 时发射(带已积累的
  title/model/provider);session.title ← session/title;
  session.completed ← session/disposed 或退出兜底(turns + 全程 token 累计 +
  reason 取最后 turn/end 真实结果;durationMs 按最后活动时间,避免被
  headless quiescence 等待期拉长);
- tool.started/completed/failed ← tool/call + tool/result(isError;
  exitCode=0/1 由 isError 派生,latencyMs=call→result 时间差,stdoutTail 截断);
- error.recorded ← llm/retry(LLM_RETRY/LOW)+ 用量文件增量(rateLimited →
  RATE_LIMITED/LOW,quotaExceeded → QUOTA_EXCEEDED/MEDIUM,occurrences=增量);
- test/completion 两族保留,由 GitHub 侧(source=github)填充。

**headless 退出语义(实测坑)**:headless 跑完即进程退出——不触发 cordis
dispose、不触发 session/disposed,且退出前有约 4 分钟 quiescence 等待期。
插件两层兜底:① turn/end 后空闲 10s(idleCompleteMs,续轮自动取消)即补发
session.completed——让 Console 实时看到"完成";② process.once("exit")
兜底最终补发 + 落盘 events/seq;seq 每 25 条周期落盘降低丢失窗口。

**验证**(隔离 home,headless 任务 "Run 'uname -s' …")产出 5 条包络,
events/seq=5,家族文件 session.jsonl + tool.jsonl + all.jsonl:

```
{"seq":1,...,"type":"session.started","data":{"title":"Run 'uname -s' and reply"}}
{"seq":2,...,"type":"session.title","data":{"title":"Run 'uname -s' and reply"}}
{"seq":3,...,"type":"tool.started","data":{"tool":"bash","inputSummary":"{\"command\": \"uname -s\"..."}}
{"seq":4,...,"type":"tool.completed","data":{"tool":"bash","exitCode":0,"latencyMs":186,"stdoutTail":"Darwin\n"}}
{"seq":5,...,"type":"session.completed","data":{"turns":1,"durationMs":...,"tokens":{"in":8321,"out":128},"reason":"completed"}}
```

工程含义:Phase 1 的 dsh-runtime ② 已落地一半——事件源(session/tool/error)
真实可用,WS/事件库消费侧随 Console 实现;五族协议对 harness 侧实现者即本插件,
对 github/console 侧消费方以 JSONL 为准(09 篇 §2 事件库规格)。

## 7. 附:GitHub 维护闭环实测(Phase 1 第四件,2026-08-16)

目标:一个真实 failure 走完「事件 → issue → Agent 修复 → 闸门 → PR → 人工 merge」。
本次用确定性演示事项 INC-20260817-001(packages/dsh-runtime-events 缺 README,
reproduce 退出 0=缺陷可复现,testCommand 校验 README 内容)实测闭环 4 轮:

| 轮次 | 结果 | 问题与修复 |
| --- | --- | --- |
| run 1 | agent 2 分钟完成修复(建 README、reproduce 转不可复现、test 过、contract 合规),但 **dsh headless 完成后不退出**,挂到 job 30min 超时被取消,变更随 runner 销毁 | 本地复现证明非必然(本地 1 分钟正常退出)——疑似免费网关在最终消息后触发无输出的 LLM 重试循环。修复:**agent 步骤套 timeout 600s 护栏**,agent 工作已完成即视为成功继续(124 处理) |
| run 2 | 护栏生效(dsh_rc=124 后继续);verify 通过;但 **PR 未创建**:「No commits between main and branch」 | 根因:verify 步 git add -A 静默失败(2>/dev/null 吞错,疑 agent git 遗留 index.lock),commit -am 无物可提交,push 空分支,pr create 又被兜底吞掉。修复:commit+PR 步重写(显式 add、无暂存变更走「agent 已自行提交」分支、PR 失败显式报错);verify 闸门升级为机器验证(reproduce 转不可复现 + test 通过,不再只看 diff 形状) |
| run 3 | 闸门(含机器验证)通过;commit 失败 | 根因:**runner 未配置 git identity**(Author identity unknown)。修复:commit 前 git config user.name/email(bot 身份) |
| run 4 | **全绿**:select → guards → provision → agent(2-3min 工作 + 600s 护栏)→ verify gate(contract 1/15 文件、83/500 行 + reproduce 不可复现 + test 通过)→ commit → **PR #4 创建** → issue #3 回评 | — |

关键实证:

- **六工具**(dsh-maint status/inspect/reproduce/test/replay/verify)真实可用;
  inspect 输出进 agent 任务上下文,reproduce/test 被 agent 与闸门双侧使用。
- **contract 闸门**双向生效:agent 遵守 allow 路径;闸门机器验证防「假完成」。
- **attempt 标签机制**生效:run 3 失败后 issue #3 自动挂 auto-attempt-1(上限 3 → needs-human)。
- **已知限制**(Phase 2 处理):
  1) bot(GITHUB_TOKEN)建的 PR 不触发 ci.yml 检查(GitHub 安全规则)——维护 PR 的闸门
     即 maintenance 工作流内的 verify gate;ci.yml 仍是人工 PR 的闸门;
  2) 修复被人工 merge 后,该事项不再可复现,下次运行会「无变更跳过」——需自动关闭
     fixed 事项(Phase 2 的 regression 闭环);
  3) headless 完成后的挂起属官方运行时行为(0 fork 不修),靠 timeout 护栏兜底。
- 基础设施清单(maintenance.yml):选 top-1(dsh-maint status)、issue 守卫
  (needs-human/attempts)、headless profile 配方(pnpm add -w + bundles reconcile +
  settings)、agent 任务模板、verify gate、commit+PR、issue 回评、attempt 标签。

## 8. 附:假完成拦截实测(Phase 2 首件,2026-08-17)

"假完成"定义:agent 声称修复完成,但磁盘事实不支持(三种形态):

| 形态 | 演示 | 闸门拦截点 |
| --- | --- | --- |
| A 谎报完成 | 只输出 SUMMARY,磁盘无修改 | claimed_files_in_diff(声明文件不在 diff) |
| B 改错对象 | 改了别的文件,缺陷仍在 | reproduce_not_reproducible(仍可复现) |
| C 测试未过 | 目标文件已改,但回归命令不过 | test_passed(测试失败) |

**dsh-maint verify evidence** 把 agent 声明(claim.json:incidentId/changedFiles/summary)与磁盘事实逐一比对:
summary 非空、声明文件全部真实出现在 diff、diff 无未声明文件、reproduce 转不可复现、test 通过、契约合规(禁止路径/文件数)。
任一 fail 即整体拒绝——不放行任何"嘴上完成"。

**实测**:临时仓库构造 4 场景,脚本 scripts/demo-fake-completion.mjs 一键演示,结果 3 拦 1 放;
同一套核验已接入 .github/workflows/maintenance.yml 的 verify gate(agent 三行输出 CHANGED_FILES/TEST_RESULT/SUMMARY 解析为 claim.json),
PR body 自动附带"闸门证据"逐项清单,人工 merge 前可直接核对。

**工程含义**:Phase 2 DoD 的"gate 拦截一次假完成"达成;
验证从"看 diff 形状"升级为"核验声明与事实一致",闸门对 agent 行为形成真实约束
(任务模板明示:CHANGED_FILES 必须与实际修改一一对应,闸门会逐文件核验)。
剩余 DoD:兼容 matrix ≥3 组合 CI 自动跑(下一件)。

## 9. 附:兼容 matrix 实测(Phase 2 第二件,2026-08-17)

**设计**:ci.yml 用 strategy.matrix 跑 os(ubuntu-latest/macos-latest)× node(20/24)= **4 组合**,
fail-fast: false(单组合失败不取消其他)。组合语义 = 该平台+Node 版本上 install/build/test 全绿。
DoD"matrix ≥3 组合 CI 自动跑"达成(run 31988172463,4/4 success)。

**连踩 4 个真实坑**(都已在 main 修复,记录供复用):

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | setup-node 后 "Unable to locate executable file: pnpm" | setup-node 的 cache: pnpm 在**步骤内部**先定位 pnpm(算缓存 key);无 packageManager 字段时不走 corepack 自动激活 | package.json 加 packageManager: pnpm@9.15.0;或去掉 cache: pnpm + npm i -g pnpm。corepack 在 node 26 已移除,不可依赖 |
| 2 | maintenance-core 测试 ENOENT /bin/sh | 测试硬编码本地路径 /Users/seeu/... 作 cwd,CI 上不存在 → spawn 失败 | 改为 import.meta.url 动态推导(fileURLToPath(new URL("../../../", import.meta.url));注意 URL 相对解析是文件级,目录语义要带尾斜杠) |
| 3 | 测试内 git commit 失败 "author identity unknown" | CI runner 无全局 git 身份(与维护闭环 run 3 同款) | 临时仓库内 git config user.email/name 后 commit |
| 4 | stacked-restore 测试 "does not provide an export named ROLES" | 测试依赖 layout-core.js 层级重建内核(reconstructHierarchy/ROLES)——本地 WIP 未合入 main;本地被 WIP 掩盖,CI 暴露 | 测试改条件跳过(检测导出缺失时 SKIP 并 exit 0);WIP 合入 main 后自动恢复执行 |

**工程含义**:matrix 让"本地能过、CI 挂"的隐藏耦合(硬编码路径、依赖未合入 API、git 身份)全部显性化;
后续每次 PR/push 都在 4 组合上自动验证,官方 breaking changes 也更早暴露(风险对策表"官方 breaking changes"行)。


## 10. 附:Trace/Replay 深度回放实测(Phase 2 第三件,2026-08-17)

**能力**:dsh-maint replay 从"摘要"升级为完整会话回放,三种用法:
- `replay <traceRef> [--json]`:单 trace 深度回放——会话元数据(标题/模型/turns/tokens/结果)、工具调用序列(与 tool.started→completed 配对:tool/input/exitCode/latencyMs/output)、错误聚合(taxonomy/severity/occurrences)、llmRetries、人类可读 timeline;
- `replay --before <ref> --after <ref> [--json]`:修复前后行为对比——工具序列差异(added/removed/changed)、同工具 exitCode 变化、错误总数 before→after、会话结果变化(failed→completed);
- traceRef 解析:仓库 .dsh/state/traces/<ref>.jsonl、仓库内相对路径、绝对路径;事件**两种形态兼容**:五族包络(tool.started/completed/failed、error.recorded、llm/retry、session.*)与原始 firehose(tool/call+tool/result、turn/start|end、request/context)。

**实测**(构造 fixture:修复前=五族包络失败现场,修复后=原始形态成功现场,单测 4 项新增,共 13 项全过):

```text
$ dsh-maint replay before.jsonl
=== 回放: .../before.jsonl (8 事件) ===
会话: 修复 README 缺失 | 模型: deepseek-chat | turns: 3 | tokens: 1200/340 | 结果: failed
03:00:00 session 开始 · 修复 README 缺失
03:00:01 请求上下文: deepseek / deepseek-chat (window 131072)
03:00:02 turn 开始
03:00:03 → bash ls docs exit=1 (512ms) 「README 缺失」
03:00:05 错误: REPRODUCE_FAILED (LOW ×2)
03:00:06 LLM 重试: rate limited
03:00:10 session 完成: failed turns=3 tokens=1200/340

$ dsh-maint replay --before before.jsonl --after after.jsonl
=== 回放对比: before.jsonl (修复前) vs after.jsonl (修复后) ===
工具序列 A: bash
工具序列 B: bash
  [1] 结果变化: bash exit 1 → 0
错误: 2 → 0 (failed → completed)
```

**发现**:当前 .dsh/incidents 的 traceRef 指向文件从未写入(维护闭环还没落 trace)——深度回放已就绪,待 headless 会话接入 trace 落盘后即可对真实修复做 before/after 对比。
**工程含义**:回放是"复盘"能力的地基:假完成拦截管"修没修对",回放管"过程怎么走的";后续 Agent Benchmark 可直接消费 trace 计算行为指标(工具调用效率、重试率、错误密度)。

## 11. 附:Agent Benchmark 实测(Phase 2 第四件,2026-08-17)

**能力**:dsh-maint benchmark 消费 trace(与 replay 同源)计算行为指标,三种用法:
- `benchmark <traceRef> [--json]`:单 trace 评分——metrics(turns/toolCalls/toolKinds/avgLatencyMs/failedCalls/failureRate/llmRetries/errors/errorDensity/reason)+ quality 分 + verdict(good≥80/ok≥60/poor);
- `benchmark --before <ref> --after <ref> [--json]`:修复前后对比——每项指标 delta + 改善项列表 + 判定变化;
- 质量分公式全可解释:`100 - 失败率×100 - 0.15×重试数 - 0.1×错误密度`(封底 0),无黑盒模型。

**实测**(构造 fixture:失败现场 2 次调用 1 败 + 2 重试 + 2 次错误;成功现场 2 次调用全 0 退出;单测 4 项新增,共 17 项全过):

```text
$ dsh-maint benchmark before.jsonl
=== Benchmark: .../before.jsonl (8 事件) ===
  turns          3
  toolCalls      1 (种类 1)
  failedCalls    1 (失败率 100%)
  llmRetries     1
  errors         REPRODUCE_FAILED ×2
  avgLatency     512ms
  reason         failed
  quality        0/100 (poor)

$ dsh-maint benchmark --before before.jsonl --after after.jsonl
=== Benchmark 对比: before.jsonl (修复前) vs after.jsonl (修复后) ===
  failureRate    1.000 → 0.000 ↓
  llmRetries     1.000 → 0.000 ↓
  errorDensity   2.000 → 0.000 ↓
  quality        0.000 → 100.000 ↑
  verdict        poor → good (改善: failureRate, llmRetries, errorDensity, quality)
```

**定位**:benchmark 是"复盘 + 门禁"双用途——复盘:每次修复后看失败率/重试/错误密度是否真的降(与 replay 的过程还原互补);门禁:Phase 3 的 guarded auto-merge 可把"修复后 benchmark ≥ 阈值"纳入放行条件(如 quality ≥ 60 且 reason=completed)。
**待接入**:真实 headless 会话的 trace 落盘后,benchmark 即可对真实修复打分(当前与 replay 一样,先以 fixture 验证语义)。
