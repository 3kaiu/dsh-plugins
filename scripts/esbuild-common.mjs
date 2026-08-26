// 各插件包共用的 esbuild 配置
import { build } from "esbuild";

export const BASE = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  legalComments: "none",
  // CJS 依赖(如 pngjs)在 ESM 输出里运行时 require node 内置模块:
  // 注入 createRequire 使 typeof require === 'function', 由 Node 解析内置模块
  banner: {
    js: "import { createRequire as __cR } from 'node:module'; const require = __cR(import.meta.url);",
  },
};

/** 宿主 profile 提供的运行时依赖,构建时保持 external(从 node_modules 解析) */
export const DSH_EXTERNALS = [
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-launch-environment",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-timeout",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/schemastery",
  "eventsource-parser",
];

export async function buildBundle(entry, outfile, external = []) {
  await build({ ...BASE, entryPoints: [entry], outfile, external });
  console.log(`built ${outfile}`);
}
