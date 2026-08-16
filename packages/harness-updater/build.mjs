// @3kaiu/dsh-harness-updater 构建: 零外部依赖,纯 node 内置
import { buildBundle } from "../../scripts/esbuild-common.mjs";

await buildBundle("src/index.js", "dist/index.js");
