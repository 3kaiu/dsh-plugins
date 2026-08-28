// @3kaiu/dsh-ui-reverse-agent 构建
import { buildBundle, DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";
const externals = [...DSH_EXTERNALS.filter((n) => n === "@deepseek-ai/dsh-tools"), "playwright", "playwright-core"];
await buildBundle("src/index.ts", "dist/index.js", externals);
