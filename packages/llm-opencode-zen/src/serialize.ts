import { LlmError, contentHasImage } from "@deepseek-ai/dsh-llm";

function reasoningEffort(effort) {
  if (effort === "off" || effort === "low" || effort === "high" || effort === "max") return effort;
  throw new LlmError(`OpenCode Zen does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}

function resolveThinking(options, defaults) {
  if (options.purpose === "session-title") return "off";
  const effort = options.reasoningEffort === void 0 ? defaults.reasoningEffort : reasoningEffort(options.reasoningEffort);
  if (defaults.thinking === "disabled" && effort !== void 0 && effort !== "off")
    throw new LlmError(`OpenCode Zen deployment does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
  return effort;
}

function flattenText(blocks) {
  return blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function assertTextOnly(blocks) {
  if (contentHasImage(blocks))
    throw new LlmError("The OpenCode Zen adapter does not support image content.", "UNSUPPORTED_CONTENT");
}

function serializeAssistant(message) {
  const text = flattenText(message.content);
  const reasoning = message.content.filter((b) => b.type === "reasoning").map((b) => b.text).join("");
  const toolCalls = message.content.filter((b) => b.type === "tool-call").map((b) => ({
    id: b.id,
    type: "function",
    function: { name: b.name, arguments: b.arguments },
  }));
  return {
    role: "assistant",
    content: text,
    ...(reasoning.length > 0 || toolCalls.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function serializeMessages(messages) {
  const wire = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((b) => b.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0)
      wire.push({ role: "user", content: text });
    for (const result of toolResults)
      wire.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || "(no output)",
      });
  }
  return wire;
}

function serializeTools(tools) {
  if (tools === void 0 || tools.length === 0) return void 0;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function buildWireRequest(messages, options, tools, reasoning) {
  const maxTokens = options.purpose === "session-title"
    ? Math.min(options.maxTokens, 64)
    : options.maxTokens;
  return JSON.stringify({
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    top_p: 0.95,
    ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
    ...options.stop !== void 0 && options.stop.length > 0 ? { stop: options.stop } : {},
    ...tools !== void 0 ? { tools, tool_choice: "auto" } : {},
    ...reasoning !== "off" ? { reasoning_effort: reasoning } : {},
  });
}

export {
  reasoningEffort,
  resolveThinking,
  flattenText,
  assertTextOnly,
  serializeAssistant,
  serializeMessages,
  serializeTools,
  buildWireRequest,
};
