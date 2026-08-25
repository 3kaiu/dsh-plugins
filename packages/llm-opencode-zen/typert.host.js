// @3kaiu/dsh-llm-opencode-zen —— Typert host manifest(typert-loader 静态登记)
// 与官方 dsh-host-plugin-inventory 同模式:包导出 ./typert,typert-loader
// 在条目挂载时把端点登记进 ctx.typert 注册中心,gw claimsEndpoint 直接
// 命中(不依赖 SRC 收集的作用域可见性)。方法仍由 ZenModelsGateway
// 的 @Remote marker + SRC 实现体提供;此处只声明 wire 契约。
import { z } from "zod";

const str = { mode: "strict", typeSymbol: "string", schema: z.string() };
const any = { mode: "strict", typeSymbol: "ZenModelsResult", schema: z.any() };
// sourceLocation 仅为信息性元数据:typert-loader 只校验其形状(string file +
// 正整数 line/column),不读取源码、不影响 wire 行为,行号随 index.ts 演进漂移无副作用。
const src = (file, line) => ({ file, line, column: 3 });

export const TYPERT = {
  package: "@3kaiu/dsh-llm-opencode-zen",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "@3kaiu/dsh-llm-opencode-zen#zenModels/listFree",
      service: "zenModels",
      namespace: "zenModels",
      method: "listFree",
      invocation: { kind: "direct" },
      parameters: [],
      result: any,
      sourceLocation: src("packages/llm-opencode-zen/src/index.ts", 918),
    },
    {
      id: "@3kaiu/dsh-llm-opencode-zen#zenModels/applyFree",
      service: "zenModels",
      namespace: "zenModels",
      method: "applyFree",
      invocation: { kind: "direct" },
      parameters: [{ name: "models", wire: "models", source: "json", codec: any }],
      result: any,
      sourceLocation: src("packages/llm-opencode-zen/src/index.ts", 937),
    },
  ],
  model: { services: [], events: [], objects: [] },
};
