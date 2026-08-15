// reasoning_content 回传回归测试: 多轮对话中 assistant 消息带推理时必须回传 reasoning_content
import { OpenCodeZenAdapter } from "../dist/llm-opencode-zen.js";

let capturedBody = null;

function sseResponse(chunks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return {
    status: 200,
    ok: true,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: stream,
    text: async () => "",
  };
}

function completionChunk(content, finish) {
  return {
    id: "x",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-v4-flash-free",
    choices: [{ index: 0, finish_reason: finish, delta: { content, role: "assistant" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

const adapter = new OpenCodeZenAdapter(
  {
    options: () => ({
      models: [], maxTokens: 100, defaultContextWindow: 100, streamIdleTimeoutMs: 5000,
      maxConcurrentStreams: 2, retryPolicy: { mode: "none" },
      defaults: { thinking: "enabled", reasoningEffort: "max" },
    }),
    resolveApiKey: async () => "public",
  },
  { acquire: async () => {}, release: () => {} },
);

global.fetch = async (url, init) => {
  capturedBody = JSON.parse(init.body);
  return sseResponse([completionChunk("ok", "stop"), completionChunk(null, "stop")]);
};

// 场景: 历史中有"带推理但无工具调用"的 assistant 消息 (纯文字回复)
await (async () => {
  for await (const _ of adapter.stream({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "先分析一下" },
          { type: "text", text: "这是上一个纯文字回复" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "继续" }] },
    ],
    sessionId: "t-reasoning-echo",
  })) {}
})();

const asst = capturedBody.messages.find((m) => m.role === "assistant");
if (!asst) throw new Error("请求中应有 assistant 消息");
if (asst.reasoning_content !== "先分析一下")
  throw new Error(`应回传 reasoning_content, got: ${JSON.stringify(asst)}`);
console.log("✓ 纯文字回复(带推理)正确回传 reasoning_content");

// 场景2: 带工具调用的 assistant 消息也必须回传 reasoning_content
await (async () => {
  for await (const _ of adapter.stream({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "需要调用工具" },
          {
            type: "tool-call",
            id: "call_1",
            name: "bash",
            arguments: '{"command":"ls"}',
            toolCallId: "call_1",
          },
          { type: "text", text: "" },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "out" }] },
      { role: "user", content: [{ type: "text", text: "继续" }] },
    ],
    sessionId: "t-reasoning-echo-tool",
  })) {}
})();

const asst2 = capturedBody.messages.find((m) => m.role === "assistant");
if (asst2.reasoning_content !== "需要调用工具")
  throw new Error(`工具调用场景应回传 reasoning_content, got: ${JSON.stringify(asst2)}`);
console.log("✓ 工具调用场景正确回传 reasoning_content");

// 场景3: 无推理的消息不应带 reasoning_content 字段
await (async () => {
  for await (const _ of adapter.stream({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    sessionId: "t-reasoning-none",
  })) {}
})();
if (capturedBody.messages.some((m) => m.role === "assistant" && m.reasoning_content !== undefined))
  throw new Error("无推理消息不应带 reasoning_content");
console.log("✓ 无推理消息不带 reasoning_content");

console.log("全部通过 ✓");