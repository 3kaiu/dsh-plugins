// @3kaiu/dsh-layout-infer 构建: bundle @3kaiu/dsh-plugin-kit(layout-core)进 dist,
// @deepseek-ai/dsh-tools 保持 external
import { buildBundle, DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";

const externals = DSH_EXTERNALS.filter((name) => name === "@deepseek-ai/dsh-tools");
await buildBundle("src/index.ts", "dist/index.js", externals);
