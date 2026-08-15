import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
];

for (const target of targets) {
  const distPath = join(target.pluginDir, "dist");
  mkdirSync(distPath, { recursive: true });
  copyFileSync(target.bundle, join(distPath, target.distFile));
  console.log(`installed ${target.patchId} -> ${distPath}/${target.distFile}`);
}

const patchPath = join(DSH_HOME, "profiles", "web", "cordis.patch.yml");
try {
  const patch = readFileSync(patchPath, "utf8");
  const updated = patch.replace(
    /name: \.\.\/\.\.\/plugins\/(dsh-(?:llm-opencode-zen|harness-updater))\/lib\/index\.js/g,
    "name: ../../plugins/$1/dist/index.js",
  );
  if (updated !== patch) {
    writeFileSync(patchPath, updated);
    console.log(`patch updated: ${patchPath}`);
  } else {
    console.log("patch already points at dist");
  }
} catch {
  console.log(`no patch at ${patchPath}; skipping`);
}