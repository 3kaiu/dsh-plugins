// @3kaiu/dsh-plugins-ui —— Typert host manifest(typert-loader 静态登记)
// 与官方 dsh-host-plugin-inventory 同模式:包导出 ./typert,typert-loader
// 在条目挂载时把端点登记进 ctx.typert 注册中心,gw claimsEndpoint 直接
// 命中(不依赖 SRC 收集的作用域可见性)。方法仍由 PluginManagerGateway
// 的 @Remote marker + SRC 实现体提供;此处只声明 wire 契约。
import { z } from "zod";

const str = { mode: "strict", typeSymbol: "string", schema: z.string() };
const any = { mode: "strict", typeSymbol: "PluginManagerResult", schema: z.any() };
const src = (file, line) => ({ file, line, column: 3 });

export const TYPERT = {
  package: "@3kaiu/dsh-plugins-ui",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "@3kaiu/dsh-plugins-ui#pluginManager/list",
      service: "pluginManager",
      namespace: "pluginManager",
      method: "list",
      invocation: { kind: "direct" },
      parameters: [],
      result: any,
      sourceLocation: src("packages/dsh-plugins-ui/src/index.ts", 275),
    },
    {
      id: "@3kaiu/dsh-plugins-ui#pluginManager/install",
      service: "pluginManager",
      namespace: "pluginManager",
      method: "install",
      invocation: { kind: "direct" },
      parameters: [{ name: "spec", wire: "spec", source: "json", codec: str }],
      result: any,
      sourceLocation: src("packages/dsh-plugins-ui/src/index.ts", 212),
    },
    {
      id: "@3kaiu/dsh-plugins-ui#pluginManager/uninstall",
      service: "pluginManager",
      namespace: "pluginManager",
      method: "uninstall",
      invocation: { kind: "direct" },
      parameters: [{ name: "pkg", wire: "pkg", source: "json", codec: str }],
      result: any,
      sourceLocation: src("packages/dsh-plugins-ui/src/index.ts", 239),
    },
    {
      id: "@3kaiu/dsh-plugins-ui#pluginManager/update",
      service: "pluginManager",
      namespace: "pluginManager",
      method: "update",
      invocation: { kind: "direct" },
      parameters: [{ name: "pkg", wire: "pkg", source: "json", codec: str }],
      result: any,
      sourceLocation: src("packages/dsh-plugins-ui/src/index.ts", 251),
    },
    {
      id: "@3kaiu/dsh-plugins-ui#pluginManager/restart",
      service: "pluginManager",
      namespace: "pluginManager",
      method: "restart",
      invocation: { kind: "direct" },
      parameters: [],
      result: any,
      sourceLocation: src("packages/dsh-plugins-ui/src/index.ts", 179),
    },
  ],
  model: { services: [], events: [], objects: [] },
};
