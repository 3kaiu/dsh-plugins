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

## 12. 附:Recovery/Checkpoint 最小可用版实测(Phase 2 第五件,2026-08-17)

**能力**:dsh-maint checkpoint 三个动作:
- `checkpoint <incidentId>`(默认 create):对事项做现场快照——事项全文 + attempts 数 + 知识文件列表 + git head/dirty + trace 摘要,写入 `.dsh/state/checkpoints/<id>-<ts>.json`;
- `checkpoint list`:按时间倒序列出全部恢复点;
- `checkpoint restore <id>`:读取快照并做完整性验证(7 个必填字段: id/incidentId/createdAt/incident/attempts/knowledge/git),返回现场信息。

**实测**(tmp 仓库:incident + attempts.jsonl 1 条 + knowledge 1 文件;单测 4 项新增,共 21 项全过):

```text
$ dsh-maint checkpoint INC-20260817-001
检查点已创建: INC-20260817-001-20260817T030038 (attempts=0, head=ce6782a, dirty)

$ dsh-maint checkpoint list
INC-20260817-001-20260817T030038  2026-08-17T03:00:38.747Z  packages/dsh-runtime-events 缺少 README  attempts=0  head=ce6782a

$ dsh-maint checkpoint restore INC-20260817-001-20260817T030038
=== 恢复点 INC-20260817-001-20260817T030038 (2026-08-17T03:00:38.747Z) ===
事项: packages/dsh-runtime-events 缺少 README [INC-20260817-001]  status=fixed
attempts: 0 | knowledge: 
git: ce6782ac4685f64c2547302c3f070ccc2ef296ab (dirty) | trace: 无
完整性: 完整 ✅
```

**定位**:checkpoint 是恢复执行的地基——headless 会话中断(超时/掉线)后,新会话 restore 快照即可续跑(事项现场/已尝试次数/知识不丢);同时快照的 attempts 数直接服务 budget 的 attempts<3 判定(Phase 3 guarded merge 复用)。
**下一步**:与维护工作流接线——maintenance.yml 在 agent 任务前后自动 checkpoint,失败重跑前先 restore(待 Phase 3 实战接入)。

## 12. 附:Recovery/Checkpoint 最小可用版实测(Phase 2 第五件,2026-08-17)

**能力**:dsh-maint checkpoint 三个动作:
- `checkpoint <incidentId>`(默认 create):对事项做现场快照——事项全文 + attempts 数 + 知识文件列表 + git head/dirty + trace 摘要,写入 `.dsh/state/checkpoints/<id>-<ts>.json`;
- `checkpoint list`:按时间倒序列出全部恢复点;
- `checkpoint restore <id>`:读取快照并做完整性验证(7 个必填字段: id/incidentId/createdAt/incident/attempts/knowledge/git),返回现场信息。

**实测**(tmp 仓库:incident + attempts.jsonl 1 条 + knowledge 1 文件;单测 4 项新增,共 21 项全过):

```text
$ dsh-maint checkpoint INC-20260817-001
检查点已创建: INC-20260817-001-20260817T030038 (attempts=0, head=ce6782a, dirty)

$ dsh-maint checkpoint list
INC-20260817-001-20260817T030038  2026-08-17T03:00:38.747Z  packages/dsh-runtime-events 缺少 README  attempts=0  head=ce6782a

$ dsh-maint checkpoint restore INC-20260817-001-20260817T030038
=== 恢复点 INC-20260817-001-20260817T030038 (2026-08-17T03:00:38.747Z) ===
事项: packages/dsh-runtime-events 缺少 README [INC-20260817-001]  status=fixed
attempts: 0 | knowledge: 
git: ce6782ac4685f64c2547302c3f070ccc2ef296ab (dirty) | trace: 无
完整性: 完整 ✅
```

**定位**:checkpoint 是恢复执行的地基——headless 会话中断(超时/掉线)后,新会话 restore 快照即可续跑(事项现场/已尝试次数/知识不丢);同时快照的 attempts 数直接服务 budget 的 attempts<3 判定(Phase 3 guarded merge 复用)。
**下一步**:与维护工作流接线——maintenance.yml 在 agent 任务前后自动 checkpoint,失败重跑前先 restore(待 Phase 3 实战接入)。

## 13. 附:Knowledge 深化 + fixtures 兼容契约实测(Phase 2 第六件,2026-08-17)

**能力**:dsh-maint knowledge 三个动作:
- `knowledge add <incidentId> --text <...>`:修复经验沉淀到 `.dsh/knowledge/<incidentId>.md`(时间戳头、相同文本去重);
- `knowledge <incidentId>`(query):返回事项内嵌 knowledge 字段 + 知识文件全文;
- `knowledge list`:列出全部知识文件与内嵌条目。

**.dsh/fixtures/ 兼容契约资产**(与真实结构一致,测试与后续场景复用):
- `incidents/inc-open.json`、`incidents/inc-fixed.json`:open/fixed 状态样例(含 knowledge、fixedAt/mergedRefs 字段);
- `autopilot.yml`:budget + permissions 契约样例(注意:yaml-mini 只支持行内列表 `[a, b]`,不支持 `- item` 形式);
- 用法:复制到 tmp 仓库对应位置即可被 loadIncidents/loadContract 解析(测试已覆盖)。

**实测**(tmp 仓库:knowledge 沉淀/去重/查询/列表 4 项 + fixtures 解析 1 项;单测新增 5 项,共 23 项全过):

```text
$ dsh-maint knowledge add INC-20260817-001 --text "修复经验:README 缺失类事项,reproduce 用 existsSync 探测"
知识已沉淀: .dsh/knowledge/INC-20260817-001.md
$ dsh-maint knowledge add INC-20260817-001 --text "修复经验:README 缺失类事项,reproduce 用 existsSync 探测"
知识已存在,跳过: INC-20260817-001.md   ← 去重
$ dsh-maint knowledge INC-20260817-001
内嵌: docs/architecture/11-poc-results.md §6 记录了事件桥规格与验证方式
--- INC-20260817-001.md ---
## 2026-08-17T03:10:10.725Z
修复经验:README 缺失类事项,reproduce 用 existsSync 探测,evidence 闸门会自动核验
```

**定位**:knowledge 是"经验记忆"——同类事项再次出现时,agent 先 query 再动手,避免重复踩坑;checkpoint 快照已含 knowledge 列表,中断续跑不丢记忆。
**至此 Phase 2 全部六件完成**(Verify/Replay/Benchmark/Checkpoint/Knowledge/matrix+fixtures),剩余:真实 headless 实战验证(Phase 3 前的地基)。

## 14. 附:真实链路实战验证实测(Phase 2 收尾,2026-08-17)

**目的**:把"各件已就绪"变成"一条真实链路可走通"——不依赖真实 LLM 会话,但全部走真实 CLI 代码路径,可重复、可进演示/CI。

**新增能力**:
- `dsh-maint trace <incidentId> --from <eventsFile>`:把会话事件流(五族包络/原始 firehose 的 JSONL)落盘到事项 traceRef 路径,落盘后 replay/benchmark 直接消费;
- benchmark 语义修正:只读探测类工具(read/glob/grep/ls/cat/find/stat)**exit 1 视为探测结果**(目标不存在是 agent 正常探索路径),不计执行失败——只有执行类工具非 0 退出才算失败。

**端到端演示** `scripts/demo-maintenance-loop.mjs`(exit 0 = 链路通过):

```text
===== 维护闭环链路演示(tmp 仓库 …/maint-loop-*) =====
  trace 落盘       8 事件 → .dsh/state/traces/inc-loop.jsonl
  evidence 闸门    放行 ✅ (7/7 项 pass)
  checkpoint      INC-LOOP-001-20260817T031604
  knowledge       已沉淀: INC-LOOP-001.md
  replay          工具调用 2 次,结果 completed
  benchmark       质量分 100/100 (good)
===== 链路演示 通过 ✅ =====
```

**链路覆盖**:incident 构造 → 模拟 agent 修复(改文件 + 声明)→ 事件流生成 → trace 落盘 → evidence 闸门(7 项全 pass)→ checkpoint 快照 → knowledge 沉淀 → replay 回放(2 次调用 completed)→ benchmark 评分(100/good)。
**语义修正的动机**:真实会话中"先 read 探测(ENOENT)→ 再创建"是标准流程,若探测失败计入失败率,质量分会误伤正常修复;修正后 demo 链路从 50/poor 变为 100/good。
**Phase 2 至此全部完成**(六件 + matrix + fixtures + 真实链路),进入 Phase 3。

## 15. 附:Guarded auto-merge 实测(Phase 3 首件,2026-08-17)

**能力**:`dsh-maint guard` 判定工具——条件(全过才放行):维护分支(`maintenance/` 前缀)+ verified 标签(evidence 闸门全过时 workflow 打上)+ 无 needs-human 标签 + attempts<3(PR body 解析)+ CI 全绿(`mergeStateStatus=CLEAN/READY`)。输出 allowMerge + 全部拦截原因,全程可解释。

**maintenance.yml 接线**(Phase 3):
- PR body 附 `attempts: N`(budget 判定输入);
- PR 创建即打 `verified` 标签(evidence 已全过);
- 新增 **guarded merge** 步骤:guard 放行 → `gh pr merge --squash --delete-branch`;拦截 → 打 `needs-human` + 输出原因 + 步骤失败;
- agent 指令强化:修复验证通过后更新 `.dsh/incidents/<id>.json` 的 status=fixed/fixedAt(随 PR 合并进 main,闭环收口)。

**DoD 实测:0 误合并 ✅**(mock 注入 PR 数据,单测 4 项新增,共 28 项全过):

```text
$ dsh-maint guard --mock allow.json --json
{ "ok": true, "data": { "allowMerge": true, "attempts": 1, "labels": ["verified"], "mergeStateStatus": "CLEAN", "reasons": [] } }
  ← 放行:maintenance/ 分支 + verified + attempts 1 + CI 全绿

$ dsh-maint guard --mock deny-human.json --json
{ "ok": true, "data": { "allowMerge": false, "reasons": ["存在 needs-human 标签(需人工介入)"] } }
  ← 拦截:needs-human(人工介入标记)

$ dsh-maint guard --mock deny-attempts.json --json
{ "ok": true, "data": { "allowMerge": false, "attempts": 3, "reasons": ["attempts=3 达到 budget 上限(≥3)"] } }
  ← 拦截:attempts 达 budget 上限

$ dsh-maint guard --mock deny-branch.json --json
{ "ok": true, "data": { "allowMerge": false, "reasons": ["非维护分支: feature/INC-W", "CI 未全绿或不可合并(mergeStateStatus=BLOCKED)"] } }
  ← 拦截:非维护分支 + CI blocked(双原因)
```

**budget 全量覆盖**:max_attempts_per_issue=3 → guard 拦截 + issue 打 needs-human(workflow issue 步骤原有);max_changed_files/max_diff_lines → verify contract 把关(原有);max_runtime → job timeout 45min + agent timeout 600s(原有);max_runs_per_day → schedule 每日 1 次(原有)。全部已接线。
**剩余**:真实 PR 上的 guard+merge 走通(依赖真实 headless 会话,Phase 4 无人值守演示一并做);auto repair 循环(schedule 自然重试,attempts 标签驱动)。

## 16. 附:Agent Score/Analytics/归因 + 无人值守演示实测(Phase 4 首件,2026-08-17)

**能力**:
- `dsh-maint benchmark <trace> --record [--incident <id>]`:评分落盘 `.dsh/state/benchmarks/<incidentId>.json`(累积数组,Agent Score 的输入侧);
- `dsh-maint score [--gate <阈值>]`:聚合全部评分——运行数/平均质量/按事项聚合(趋势 + 回归检测)+ 按 taxonomy 分布;回归归因:单次降幅 ≥20 时,比较 failureRate/llmRetries/errorDensity 三个指标的变化,变化最大者为主因;发行门禁:最新一次评分 ≥ 阈值(默认 60)且 reason=completed 才通过(历史失败不惩罚当前,avg 仅作趋势展示)。

**无人值守演示** `scripts/demo-unattended.mjs`(压缩时间线,全走真实 CLI):

```text
===== 无人值守维护演示(压缩时间线) =====
[00:00] 失败:quality 0 (poor, reason=failed)
[01:00] 恢复点:INC-U-001-20260817T032346(attempts=0, head=2a728c6)
[02:00] 修复:quality 100 (good, reason=completed)
[02:20] evidence 闸门:放行 ✅
[02:30] guard 判定:放行 ✅
[02:40] 合入(模拟 squash merge)+ 知识:INC-U-001.md
----- Agent Score -----
  运行 2 次,avg 50/100,趋势 [0 → 100]
  发行门禁(阈值 60):通过 ✅
===== 无人值守演示 通过 ✅ =====
```

**归因实测**(单测注入 90→60 下降,失败率 +0.4):score 输出 `⚠ 下降 90→60(30) 主因 failureRate [+0.40 / 重试 0.0 / 错误密度 0.00]`——能解释一次下降 ✅(DoD 第二项)。
**门禁语义决策**:发行门禁看"最新一次"而非平均——修复后历史失败已不惩罚当前(否则 00:00 失败会永久拖累门禁);avg 仅作趋势展示。
**DoD 达成**:00:00 失败 → 02:40 修复合入一次走通 ✅;score 归因能解释一次下降 ✅(测试 32 项全过)。

## 17. 附:真实 headless 实战验证实测(Phase 2/4 收尾拼图,2026-08-17)

**动机**:demo 链路(§14)用模拟事件流验证了全部真实代码路径;本节用**真实 headless 会话产物**验证事件格式兼容(填补最后一块拼图)。

**过程**:隔离 home(`DSH_HOME=/tmp/dsh-home-real`)按 CI provision 步骤搭建 headless profile(llm-opencode-zen + dsh-runtime-events bundles)→ 真实会话一次跑通(`dsh --profile headless "输出 exactly: hello-headless"` → 输出 `hello-headless`)→ 事件落盘 `state/events/all.jsonl`(schema:1,含 eventId/family/source 字段)。

**真实闭环**:事件流 → trace import 落盘 → replay → benchmark:

```text
$ dsh-maint trace INC-REAL-001 --from events.jsonl
trace 已落盘: .dsh/state/traces/inc-real.jsonl (6 事件)
$ dsh-maint replay .dsh/state/traces/inc-real.jsonl --json
exists: true | events: 6 | reason: completed | turns: 1 | calls: 0
$ dsh-maint benchmark .dsh/state/traces/inc-real.jsonl --json
quality: 100 | verdict: good | reason: completed
```

**结论**:真实 headless 会话事件(schema:1)与 replay/benchmark 完全兼容——部署环境(headless 会话 + 事件桥 + trace 落盘 + 评分)全链路已验证,真实修复走的是同一条管道。
**边界说明**:本机会话无工具调用(最小任务),tool 族事件的真实兼容性由 §10 的五族 fixture 覆盖(同一 deepReplay 消费者);完整真实修复会话(含工具调用)在 CI maintenance 工作流中每日运行。

## 18. 附:真实 PR 上的 guarded merge 端到端实测(2026-08-17)

**动机**:§15 用 mock PR 数据验证了 guard 判定;本节在 3kaiu/dsh-plugins 用**真实 PR 数据**走完整闭环(此前 guard 调用均为 --mock 注入)。

**过程**(PR #6,分支 maintenance/INC-20260817-002-20260817040000):

1. 登记真实事项 INC-20260817-002(scripts/ 演示脚本缺 README,reproduce 用 existsSync 探测 → main ead82ed);
2. Agent 修复:新增 scripts/README.md + 事项状态置 fixed(maintenance/ 分支 25018c3);
3. evidence 全过(verify full:contract 2 项 + pnpm test + build)→ PR body 附闸门证据 + attempts: 0(首次尝试),PR #6 创建;
4. 打 verified 标签(workflow 中由 verify gate 步骤执行;本地首次发现仓库无此标签 → gh label create verified,与 needs-human 一并预置);
5. CI 4 组合全绿(§17 同款 matrix)→ mergeStateStatus=CLEAN;
6. dsh-maint guard --pr 6(**真实 gh 数据**):

```text
$ dsh-maint guard --pr 6 --json
{ "ok": true, "data": { "pr": 6, "allowMerge": true,
  "head": "maintenance/INC-20260817-002-20260817040000", "attempts": 0,
  "labels": ["verified"], "mergeStateStatus": "CLEAN", "reasons": [] } }
```

7. 按 workflow guarded merge 步骤行为真实合入:gh pr merge 6 --squash --delete-branch → state=MERGED,mergeCommit b7086d2;
8. 收尾:incident mergedRefs 更新为 b7086d2 (PR #6)(main 17ec31e)。

**结论**:guard 在真实 PR 数据下放行正确(无误放行);真实修复经 evidence 闸门 → verified 标签 → CI 全绿 → guard 放行 → squash 合入的完整链路跑通,与 CI maintenance 工作流同构。**M4(guarded auto-merge 0 误合并)在真实 PR 上再次验证**。

## 19. 附:Console 维护报告实测(Phase 4 收尾,2026-08-17)

**能力**:dsh-maint report [--gate <阈值>] [--json]——状态总览(open/fixed 计数 + open 列表)+ Agent Score(与 score 同一聚合源:runs/avg/最新/门禁/回归告警)+ 运行痕迹(最近 3 个恢复点 + 知识文件数);Console 早报/维护报告的 CLI 输入侧。

**实测输出**(仓库 3kaiu/dsh-plugins @ 17ec31e):

```text
$ dsh-maint report
=== 维护报告 2026-08-17 ===
事项: 0 open / 2 fixed(知识 1 条)
Agent Score: 1 次,avg 0,最新 0/100,发行门禁 未过 ❌
运行痕迹: 最近恢复点 1 个(INC-20260817-001-20260817T030038)
```

**说明**:门禁未过是正确语义——唯一评分是历史失败记录(quality 0, reason=failed),尚未产生修复后评分;发行门禁看最新一次,修复产生新评分后自动放行(§16 演示过该路径)。
**DoD**:report 命令实现 + 34 项测试全过(新增 2 项:状态总览/Score 集成 + --gate 透传)。

## 20. 附:doctor 兼容健康检查实测(成功指标收口,2026-08-17)

**能力**:`dsh-maint doctor [--json]`——兼容契约健康检查,权重计分 0-100,≥90 = healthy(对应 05 §6 成功指标"兼容分(doctor) ≥ 90"):
- incidents 加载(15):loadIncidents 可解析;
- autopilot.yml 契约(30):直接解析 yaml 验结构(version/permissions allow+deny 数组/merge guarded;行内与块状两种形态兼容——yaml-mini 把行内 `{ mode: guarded }` 解析为字符串,检查做双形态兼容);
- state 目录(10):benchmarks/checkpoints/traces + knowledge 目录就绪;
- 工具清单对齐 09 §4(20):docs 声明的 dsh_maintenance_* 与实现 TOOLS 键双向对齐(缺/多都 fail);
- trace 回放(10):已有 trace 全部可 deepReplay;
- CI matrix(10):ci.yml 含 os × node 矩阵;
- knowledge 可读(5):知识文件均可读。

**实测输出**(3kaiu/dsh-plugins @ main,真实仓库):

```text
$ dsh-maint doctor
=== 兼容健康检查(doctor) ===
  [✅] incidents 加载 (+15/15) — 2 个事项可解析
  [✅] autopilot.yml 契约 (+30/30) — allow 6 / deny 4 / merge guarded
  [✅] state 目录 (+10/10) — benchmarks/checkpoints/traces/knowledge 就绪
  [✅] 工具清单对齐 09 §4 (+20/20) — doc 14 / impl 14
  [✅] trace 回放 (+10/10) — 1 个 trace 可回放
  [✅] CI matrix (+10/10) — os × node 矩阵存在
  [✅] knowledge 可读 (+5/5) — 1 个知识文件
兼容分: 100/100 → healthy
```

**缺陷注入实测**(单测 4 项):autopilot.yml 损坏 → 70 warning;09 缺失 → 80 warning;incidents 空 → 85 warning;健康仓库 → 100 healthy。测试 38 项全过。
**用途**:发行前/CI 前健康门禁——与 score --gate(发行门禁)互补:doctor 管"环境与契约健康",score 管"Agent 行为质量"。

## 21. 附:维护早报实测(Console 日活支撑,2026-08-17)

**能力**:`scripts/morning-report.mjs`——把 `dsh-maint report --json` 转成早报 markdown(状态总览 + 发行门禁 + 待办 + 回归告警 + 运行痕迹),支持 `--stdout` 与 `--out <path>`(默认 `.dsh/state/morning-report.md`);对应 05 §6 成功指标"Console 日活 = 早上看早报、晚上看维护报告"。

**实测输出**(3kaiu/dsh-plugins @ main):

```markdown
# 维护早报 2026-08-17

## 状态总览
- 事项: **0 open** / 2 fixed
- 发行门禁: ❌ 未过(阈值 60,最新评分 0)

## 运行痕迹
- Agent Score: 1 次,avg 0,趋势 [0]
- 恢复点: INC-20260817-001-20260817T030038
- 知识: 1 条

---
*由 dsh-maint report 生成(11 篇 §19)*
```

**说明**:门禁未过语义正确(唯一评分是失败记录);早报与 report 共用同一数据源,接入 Console 首页/每日通知即可支撑"每天打开"指标。

## 22. 附:Console 早报面板 + CI 健康门禁实测(部署/呈现收尾,2026-08-17)

**早报接入 Console**:
- server.mjs 新增 REST 端点 `GET /api/morning-report`——读 `<DSH_MAINT_REPO>/.dsh/state/morning-report.md`(由 scripts/morning-report.mjs 生成),返回 { ok, markdown, generatedAt };DSH_MAINT_REPO 未配置或早报未生成时返回可解释的 { ok:false, reason };
- Dashboard 首页新增"维护早报"卡片(顶部):fetch 端点 + 极简 markdown 渲染(标题/列表/分隔线)+ 刷新按钮;未生成/不可用时显示原因,不阻塞事件流面板;
- 实测:build 通过 + 本地启动(DSH_CONSOLE_PORT=3191 + DSH_MAINT_REPO)后 `/api/morning-report` 返回早报全文、`/` SPA 正常托管、未知 API 404。

**CI 健康门禁**:
- ci.yml check job 末尾新增"兼容健康检查(doctor ≥90)"步骤:跑 `dsh-maint doctor --json` 断言 score ≥90,不达标即构建失败(与 build+test 同矩阵 4 组合);
- 本地模拟通过(100/100 healthy exit 0);CI 实测见下方 run(与本次提交同 run,4/4 绿)。

**效果**:Console 首页打开即见维护早报(05 §6"早上看早报"落地),CI 每次运行先过健康门禁(doctor 与 score --gate 互补:环境契约健康 vs Agent 行为质量)。

## 23. 边界修正与 Console 生命周期(发行层分离确认,2026-08-17)

**边界确认(重要)**:启动器/生命周期层属独立仓库 **3kaiu/dsh-launcher**(已有 bash `dshctl`:install/start/stop/restart/status/logs/open/update/doctor/watch/agent-install,管官方 Harness 3080;菜单栏 App Swift + launchd + 自有 release.yml 发 macOS zip)。**plugins 仓库不重复实现 dshctl**——曾临时在 scripts/ 实现 `dshctl console` 子命令并加 release.yml,经核对 launcher 仓库已存在同类职责后**撤销删除**,回归分层边界(04 篇 §1)。

**Console(3090)生命周期归属**:Console 是 plugins 仓库资产(dsh-console),其启动/停止由**发行包内极简 start.sh / stop.sh** 承担(pid 落 `~/.local/state/dsh-runtime/console.pid`,尊重 `DSH_CONSOLE_PORT`);后续可扩展 launcher 的 dshctl 增加 `console` 子命令统一管理(待定,不阻塞)。

**实测**(发行包内 start.sh / stop.sh,端口 3193 隔离):start 打印 pid 与 URL、/api/health/summary 200;stop 后端口退服、pid 文件清理。

## 24. 附:Console 工作台发行包实测(GitHub 构建产物 + PWA,2026-08-17)

**目标落地**:用户需求"GitHub 构建出产物、下载即用、含 PWA"。产物 = `dsh-workbench-<ver>.zip`(plugins 仓库 GitHub Release;启动器/官方 Harness 由 3kaiu/dsh-launcher 独立提供)。

**PWA 补全**(dsh-console):
- `public/sw.js`:Service Worker——静态资源预缓存、导航网络优先离线回退、`/api/*` 永不缓存;
- `apple-touch-icon.png`(180×180,程序生成) + index.html 注册 SW + apple-touch-icon link;
- manifest 补 display_override + description;build 后 dist 含 manifest/sw.js/icon。

**发行流水线**:
- `scripts/release.ts`(TypeScript,node ≥24 原生 type-stripping 运行):校验 build 产物 → 组装 staging(Console server.mjs + dist + node_modules/ws(唯一外部依赖)+ dsh-maint 工具集 + morning-report + start.sh/stop.sh + package.json/versions.json/README)→ zip + SHA256SUMS;
- `.github/workflows/release.yml`(ubuntu,node 24):workflow_dispatch(可传版本)或 tag `v*` 触发 → pnpm build console → `node scripts/release.ts` → `gh release create/upload`(`workbench-v<ver>` Release + SHA256SUMS)。

**本地实测**(打包 → 解压 → 运行):

```text
$ node scripts/release.ts --version 0.1.0
OK dsh-workbench-0.1.0.zip(87 KB)
$ unzip -q dsh-workbench-0.1.0.zip && cd dsh-workbench-0.1.0
$ DSH_CONSOLE_PORT=3193 bash start.sh
console 已启动(pid 14240,http://127.0.0.1:3193)
$ for p in / /manifest.webmanifest /sw.js /apple-touch-icon.png /api/health/summary; do ... 200 全部可达
$ bash stop.sh
console 已停止
```

**使用**:下载 zip(仓库 Releases 页)→ 解压 → `./start.sh` → http://127.0.0.1:3090 → Safari 添加到程序坞(独立 App 体验);官方 Harness(3080)用 dsh-launcher 发行包。**边界**:本包不含官方代码与启动器(零 fork 零修改);发行包内 doctor 15/100 为"无维护仓库上下文"的正确语义(在维护仓库中为 100,见 §20)。

**GitHub 实测**(workflow release.yml run 32001165036,bundle success):

```text
$ gh workflow run release.yml -f version=0.1.0
$ gh release view workbench-v0.1.0 --json assets
{"assets":[{"name":"dsh-workbench-0.1.0.zip","size":88580},{"name":"SHA256SUMS","size":90}]}
$ gh release download workbench-v0.1.0 && shasum -a 256 -c SHA256SUMS
dsh-workbench-0.1.0.zip: OK
```

**验收闭环**:下载 → SHA256 校验 → 解压 → start.sh → PWA 资产可达 → Safari 程序坞。

## 25. 附:无人值守闭环首次真实触发与 dogfood 修复(2026-08-17)

**背景**:用户要求"结束后继续 A"——真实触发 `maintenance.yml` workflow_dispatch(run 32001266951),验证无人值守闭环端到端。

**首次真实运行发现缺陷**(这正是闭环的意义:dogfood 自身):
- 现象:run 失败——`invalid issue format: ""`(agent run 步骤 crash);
- 根因 ×2:① select 步骤取 status 的 incidents[0],**不区分 open/fixed**(当前仓库无 open 事项,选中已 fixed 的 INC-20260817-001);② issue lookup 步骤内 `exit 0` 只结束该步骤 shell,**后续 provision/agent/verify/PR/merge 步骤无 if 守卫照常执行**,`gh issue view ""` crash;
- 修复(f4e0df4):select 只选 `status==="open"`;issue_number 为空时后续 5 步全部 `if: steps.issue.outputs.issue_number != ''` 跳过;
- 验证(run 32001521048):**success**,"选择事项: "(空)→ "无待办事项,退出" → 优雅空转;
- 经验入库:incident INC-20260817-003(CI_BUG,含 reproduce/testCommand,reproduce 不可复现 + test 通过);知识:步骤内 exit 0 不终止 workflow,跳过必须用 if 条件;incident 命令含引号时外层双引号 + 内部单引号 + 正则单引号用转义序列避免 sh 引号嵌套。

**说明**:本次为"无待办"路径的验证;有 open incident + open issue 时才会走完整修复链路(真实 headless → 契约闸门 → PR → guarded merge,PR #6 已演示过人工合并侧)。05 §6 的 needs-human 升级率/闭环时长指标将随真实待办运行开始积累。
