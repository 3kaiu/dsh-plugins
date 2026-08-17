// @3kaiu/dsh-console 服务端构建: esbuild 打包 src/runtime → dist(压缩混淆)
// 顺序注意: 先 esbuild 后 vite(vite emptyOutDir:false,不清 esbuild 产物)
import { buildBundle, DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";

// 插件入口: bundle 内联 server 逻辑(自包含,经 cordis 加载)
await buildBundle("src/runtime/plugin.ts", "dist/plugin.mjs", [...DSH_EXTERNALS, "ws"]);
// 独立运行形态(bin dsh-console / workbench server.mjs)
await buildBundle("src/runtime/server.ts", "dist/server.mjs", ["ws"]);