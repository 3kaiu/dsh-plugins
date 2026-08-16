// incidents 加载与排序:严重度权重 × 频率
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const SEVERITY_WEIGHT = { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 };

export function incidentsDir(repoRoot = process.cwd()) {
  return join(repoRoot, ".dsh", "incidents");
}

export function loadIncidents(repoRoot = process.cwd()) {
  const dir = incidentsDir(repoRoot);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const inc = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (inc && inc.id) out.push({ file: f, ...inc });
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

export function scoreOf(inc) {
  const w = SEVERITY_WEIGHT[inc.severity] ?? 1;
  const f = Math.max(1, Number(inc.frequency) || 1);
  return w * f;
}

export function sortIncidents(incs) {
  return [...incs].sort((a, b) => scoreOf(b) - scoreOf(a));
}

export function findByPrefix(incs, prefix) {
  return incs.find((i) => i.id === prefix || i.id.startsWith(prefix));
}
