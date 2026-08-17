// @3kaiu/dsh-llm-opencode-zen 构建: bundle @3kaiu/dsh-plugin-kit 进 dist,
// @deepseek-ai/* 运行时依赖保持 external(由宿主 profile 的 node_modules 解析)
import { buildBundle, DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";

await buildBundle("src/index.ts", "dist/index.js", DSH_EXTERNALS);
