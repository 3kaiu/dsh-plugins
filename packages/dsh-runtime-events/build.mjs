// @3kaiu/dsh-runtime-events 构建: 仅外部化 @deepseek-ai/*(由宿主 profile 解析)
import { buildBundle, DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";
await buildBundle("src/index.ts", "dist/index.js", DSH_EXTERNALS);
