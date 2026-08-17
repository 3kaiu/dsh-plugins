// @3kaiu/dsh-harness-updater 构建: @deepseek-ai/* 由宿主 profile 解析(与 llm/runtime-events 一致)
import { buildBundle, DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";

await buildBundle("src/index.ts", "dist/index.js", DSH_EXTERNALS);
