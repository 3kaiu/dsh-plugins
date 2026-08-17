import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// DSH Console —— 静态产物由 dsh-console server.mjs 托管(3090)
export default defineConfig({
  plugins: [preact()],
  build: { outDir: "dist", target: "es2022", sourcemap: false, emptyOutDir: false },
  server: { port: 5173 },
});
