import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// DSH Console —— 静态产物由 dsh-console server.mjs 托管(3090)
// 固定产物文件名:pnpm file: 安装是硬链接快照,哈希名新文件不会同步进 profile,
// 会 404 导致空白页;固定名后每次构建写同名文件,硬链接自动跟随。
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/console.js",
        chunkFileNames: "assets/console-[name].js",
        assetFileNames: "assets/console-[name][extname]",
      },
    },
  },
  server: { port: 5173 },
});
