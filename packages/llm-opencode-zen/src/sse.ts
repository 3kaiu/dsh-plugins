import { CallId, EMPTY_RESPONSE_CODE, LlmError } from "@deepseek-ai/dsh-llm";
import { EventSourceParserStream } from "eventsource-parser/stream";

const DONE = "[DONE]";
const STREAM_IDLE_TIMEOUT_CODE = "STREAM_IDLE_TIMEOUT";
const MAX_REQUEST_ATTEMPTS = 2;

async function* parseSse(stream: any, onComment: any) {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }));
  for await (const { data } of events) {
    yield data;
    if (data === DONE) return;
  }
  throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}

function mapFinishReason(reason: any) {
  switch (reason) {
    case "stop": return { kind: "stop" };
    case "tool_calls": return { kind: "tool-calls" };
    case "length": return { kind: "max-tokens" };
    default: {
      const code = reason === "network_error" ? "TRANSPORT" : reason.toUpperCase();
      return {
        kind: "error",
        failure: { message: `model stopped: ${reason}`, code },
      };
    }
  }
}

function mapUsage(usage: any) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== void 0 ? { reasoningTokens: reasoning } : {},
  };
}

const TOOL_ARGS_MALFORMED_CODE = "TOOL_ARGS_MALFORMED";

function repairByClosure(text: string) {
  let result = "";
  let inString = false;
  let escaped = false;
  const stack = [];
  for (const ch of text) {
    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      result += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) stack.pop();
      result += ch;
      continue;
    }
    result += ch;
  }
  if (inString) result += '"';
  while (stack.length > 0) result += stack.pop();
  try {
    JSON.parse(result);
    return { ok: true, text: result };
  } catch {
    return { ok: false, text };
  }
}

function firstCompleteValue(text: string) {
  const start = text.search(/[{[]/);
  if (start < 0) return { ok: false, text };
  let inString = false;
  let escaped = false;
  const stack = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) stack.pop();
      if (stack.length === 0) {
        const candidate = text.slice(0, i + 1);
        try {
          JSON.parse(candidate);
          return { ok: true, text: candidate };
        } catch {}
        return { ok: false, text };
      }
    }
  }
  return { ok: false, text };
}

function repairToolArguments(text: string) {
  try {
    JSON.parse(text);
    return { ok: true, text };
  } catch {}
  const closed = repairByClosure(text);
  if (closed.ok) return closed;
  const prefix = firstCompleteValue(text);
  if (prefix.ok) return prefix;
  const maxBacktrack = Math.max(1, Math.min(Math.floor(text.length / 4), 512));
  for (let cut = text.length - 1; cut >= text.length - maxBacktrack; cut--) {
    const candidate = text.slice(0, cut);
    try {
      JSON.parse(candidate);
      return { ok: true, text: candidate };
    } catch {}
  }
  return { ok: false, text };
}

function isCjkChar(ch: string) {
  // 区间与 @3kaiu/dsh-plugin-kit cjk.CJK_WIDE_RE 正典保持一致(llm 刻意不依赖 kit, 独立内联)。
  // 2026-08-29 修复: 原 [3400-4DBF]+[4E00-9FFF] 漏假名(3040-30FF)/兼容表意(F900-FAFF)/
  // 全角形式(FF00-FFEF)/CJK 标点(3000-303F), 中日韩混合文本的 token 估算系统性偏低。
  const code = ch.codePointAt(0);
  return (
    (code! >= 0x2e80 && code! <= 0x9fff) ||
    (code! >= 0xf900 && code! <= 0xfaff) ||
    (code! >= 0xff00 && code! <= 0xffef) ||
    (code! >= 0x3000 && code! <= 0x303f)
  );
}

function estimateCharsToTokens(text: string) {
  let cjk = 0;
  for (const ch of text) {
    if (isCjkChar(ch)) cjk += 1;
  }
  return cjk + Math.floor((text.length - cjk) / 4);
}

function estimateUsage(inputText: any, outputText: any, reasoningText: any) {
  const usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number } = {
    inputTokens: estimateCharsToTokens(inputText),
    outputTokens: estimateCharsToTokens(outputText),
  };
  const reasoningTokens = estimateCharsToTokens(reasoningText);
  if (reasoningTokens > 0) usage.reasoningTokens = Math.min(reasoningTokens, usage.outputTokens);
  return usage;
}

function closeBlock(block: any) {
  switch (block.kind) {
    case "text": return { type: "text", text: block.text };
    case "reasoning": return { type: "reasoning", text: block.text };
    case "tool-call": return {
      type: "tool-call",
      id: CallId(block.callId ?? ""),
      name: block.name ?? "",
      arguments: block.text,
    };
  }
}

// estimateInput 是惰性估算闭包(() => number), 由 requestStream 传 `() => estimateInputText(messages)`
async function* translate(events: any, context: { estimateInput?: (() => number) | null } = {}) {
  const { estimateInput = null } = context;
  let nextIndex = 0;
  let textBlock: any;
  let reasoningBlock: any;
  const toolBlocks = new Map();
  const order: any[] = [];
  let pendingFinish;
  let pendingUsage;

  const open = (kind: any) => {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  };

  const estimate = () => {
    const inputText = estimateInput !== null ? estimateInput() : "";
    let outputText = textBlock?.text ?? "";
    for (const block of order)
      if (block.kind === "tool-call") outputText += block.text;
    const reasoningText = reasoningBlock?.text ?? "";
    return estimateUsage(inputText, outputText, reasoningText);
  };

  for await (const payload of events) {
    if (payload === DONE) {
      let malformed = false;
      for (const block of order) {
        if (block.kind === "tool-call") {
          const repair = repairToolArguments(block.text);
          if (repair.ok) {
            if (repair.text !== block.text) block.text = repair.text;
          } else {
            malformed = true;
          }
        }
        yield { type: "block-end", index: block.index, block: closeBlock(block) };
      }
      yield {
        type: "usage",
        usage: pendingUsage ?? estimate(),
      };
      let reason = pendingFinish ?? { kind: "stop" };
      if (malformed) {
        reason = {
          kind: "error",
          failure: {
            message: "OpenCode Zen returned tool arguments that are not valid JSON",
            code: TOOL_ARGS_MALFORMED_CODE,
          },
        };
      } else if (reason.kind === "stop" && order.length === 0) {
        reason = {
          kind: "error",
          failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE },
        };
      }
      yield { type: "finish", reason };
      return;
    }

    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;

      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }

      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id !== void 0 && call.id !== null) block.callId = call.id;
        if (call.function?.name !== void 0 && call.function?.name !== null) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: CallId(block.callId ?? ""),
          ...block.name !== void 0 ? { name: block.name } : {},
          argumentsDelta: fragment,
        };
      }

      if (typeof choice.finish_reason === "string") {
        pendingFinish = mapFinishReason(choice.finish_reason);
      }
    }

    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }

  throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}

export {
  DONE,
  STREAM_IDLE_TIMEOUT_CODE,
  MAX_REQUEST_ATTEMPTS,
  TOOL_ARGS_MALFORMED_CODE,
  parseSse,
  mapFinishReason,
  mapUsage,
  repairByClosure,
  firstCompleteValue,
  repairToolArguments,
  isCjkChar,
  estimateCharsToTokens,
  estimateUsage,
  closeBlock,
  translate,
};
