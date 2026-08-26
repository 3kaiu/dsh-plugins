// @ui-restore/core 构建: bundle src/index.ts → dist/index.js(压缩)
// CJS 依赖(pngjs/opentype.js)经 esbuild-common 的 createRequire banner 解析
import { buildBundle } from "../../scripts/esbuild-common.mjs";

await buildBundle("src/index.ts", "dist/index.js");
