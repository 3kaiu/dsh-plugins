import { build } from "esbuild";

const SHARED = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  legalComments: "none",
  external: [
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-credentials",
    "@deepseek-ai/dsh-launch-environment",
    "@deepseek-ai/dsh-settings",
    "@deepseek-ai/dsh-timeout",
    "@deepseek-ai/dsh-tools",
    "@deepseek-ai/schemastery",
    "eventsource-parser",
  ],
};

const entries = [
  ["src/index.js", "dist/llm-opencode-zen.js", SHARED.external],
  ["src/updater.js", "dist/harness-updater.js", SHARED.external],
  ["src/layout-infer/index.js", "dist/layout-infer.js", SHARED.external],
];

for (const [entry, outfile, external] of entries) {
  await build({ ...SHARED, entryPoints: [entry], outfile, external });
}

console.log(`built ${entries.length} bundles`);