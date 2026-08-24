// network_error 收流回归测试:OpenCode Zen 网关到上游中断时以
// finish_reason="network_error" 正常收流(HTTP 200)。必须映射为 TRANSPORT
// 以接入内外两层重试;此前透传为 NETWORK_ERROR 导致一次抖动终止整轮零重试。
import { translate } from "../dist/index.js";

async function* sse(chunks) {
  for (const c of chunks) yield typeof c === "string" ? c : JSON.stringify(c);
  yield "[DONE]";
}
function chunk(finish) {
  return { choices: [{ index: 0, finish_reason: finish, delta: {} }] };
}

async function collectFinish(chunks) {
  let finish;
  for await (const ev of translate(sse(chunks))) if (ev.type === "finish") finish = ev.reason;
  return finish;
}

// 1) network_error → TRANSPORT(内外两层均可重试)
{
  const r = await collectFinish([chunk("network_error")]);
  if (r.kind !== "error" || r.failure.code !== "TRANSPORT")
    throw new Error(`network_error 应映射为 TRANSPORT, got ${JSON.stringify(r)}`);
  if (!r.failure.message.includes("network_error")) throw new Error("原文应保留在 message");
  console.log("✓ finish_reason=network_error → TRANSPORT(接入两级重试)");
}

// 2) 先出内容再断流,同样映射 TRANSPORT(外层策略可整轮重跑)
{
  const r = await collectFinish([
    { choices: [{ index: 0, finish_reason: null, delta: { content: "部分输出" } }] },
    chunk("network_error"),
  ]);
  if (r.failure?.code !== "TRANSPORT") throw new Error(`部分输出后断流应仍为 TRANSPORT, got ${JSON.stringify(r)}`);
  console.log("✓ 部分输出后再断流同样映射 TRANSPORT");
}

// 3) 其余未知 reason 保持原有大写透传(不误伤)
{
  const r = await collectFinish([chunk("some_future_reason")]);
  if (r.failure?.code !== "SOME_FUTURE_REASON") throw new Error(`未知 reason 应原样大写, got ${JSON.stringify(r)}`);
  console.log("✓ 其他未知 finish_reason 保持原样透传");
}

console.log("全部通过 ✓");
