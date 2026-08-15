import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const DSH_HOME = process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
const here = process.cwd();

const targets = [
  {
    bundle: join(here, "dist", "llm-opencode-zen.js"),
    pluginDir: join(DSH_HOME, "plugins", "dsh-llm-opencode-zen"),
    distFile: "index.js",
    patchId: "llm-opencode-zen",
  },
  {
    bundle: join(here, "dist", "harness-updater.js"),
    pluginDir: join(DSH_HOME, "plugins", "dsh-harness-updater"),
    distFile: "index.js",
    patchId: "dsh-harness-updater",
  },
  {
    bundle: join(here, "dist", "layout-infer.js"),
    pluginDir: join(DSH_HOME, "plugins", "dsh-layout-infer"),
    distFile: "index.js",
    patchId: "dsh-layout-infer",
    installDeps: { "@deepseek-ai/dsh-tools": "0.1.0-rc.6" },
  },
];

for (const target of targets) {
  const distPath = join(target.pluginDir, "dist");
  mkdirSync(distPath, { recursive: true });
  copyFileSync(target.bundle, join(distPath, target.distFile));
  console.log(`installed ${target.patchId} -> ${distPath}/${target.distFile}`);
  if (target.installDeps) {
    const marker = join(target.pluginDir, "node_modules", "@deepseek-ai", "dsh-tools");
    if (!existsSync(marker)) {
      const pkg = {
        name: `dsh-${target.patchId}`,
        version: "0.1.0",
        private: true,
        type: "module",
        dependencies: target.installDeps,
      };
      writeFileSync(join(target.pluginDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
      execSync(`npm install --prefix ${target.pluginDir} --no-package-lock --no-audit --no-fund`, {
        stdio: "inherit",
      });
      console.log(`deps installed for ${target.patchId}`);
    }
  }
}

const patchPath = join(DSH_HOME, "profiles", "web", "cordis.patch.yml");
try {
  let patch = readFileSync(patchPath, "utf8");
  patch = patch.replace(
    /name: \.\.\/\.\.\/plugins\/(dsh-[a-z-]+)\/lib\/index\.js/g,
    "name: ../../plugins/$1/dist/index.js",
  );
  for (const target of targets) {
    const pluginName = basename(target.pluginDir);
    const entry = `\n- insert:\n    - id: ${target.patchId}\n      name: ../../plugins/${pluginName}/dist/index.js`;
    if (!new RegExp(`id: ${target.patchId}`).test(patch)) {
      patch += entry;
      console.log(`registered ${target.patchId}`);
    }
  }
  if (patch !== readFileSync(patchPath, "utf8")) {
    writeFileSync(patchPath, patch);
    console.log(`patch updated: ${patchPath}`);
  } else {
    console.log("patch already up to date");
  }
} catch {
  console.log(`no patch at ${patchPath}; skipping`);
}