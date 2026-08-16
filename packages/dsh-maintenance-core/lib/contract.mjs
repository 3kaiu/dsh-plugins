// contract:读取 .dsh/autopilot.yml,提供 budget 与权限白/黑名单
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseMiniYaml } from "./yaml-mini.mjs";

export const DEFAULT_CONTRACT = {
  budget: { maxRunsPerDay: 3, maxAttemptsPerIssue: 3, maxChangedFiles: 15, maxDiffLines: 500, maxRuntimeMin: 15 },
  allow: ["packages/**", "tests/**", "fixtures/**", ".dsh/knowledge/**", "docs/**"],
  deny: [".github/workflows/release.yml", ".dsh/autopilot.yml", "LICENSE", "**/package.json"],
};

export function loadContract(repoRoot = process.cwd()) {
  const p = join(repoRoot, ".dsh", "autopilot.yml");
  if (!existsSync(p)) return DEFAULT_CONTRACT;
  const y = parseMiniYaml(readFileSync(p, "utf8"));
  const budget = y.budget ?? {};
  return {
    budget: {
      maxRunsPerDay: budget.max_runs_per_day ?? DEFAULT_CONTRACT.budget.maxRunsPerDay,
      maxAttemptsPerIssue: budget.max_attempts_per_issue ?? DEFAULT_CONTRACT.budget.maxAttemptsPerIssue,
      maxChangedFiles: budget.max_changed_files ?? DEFAULT_CONTRACT.budget.maxChangedFiles,
      maxDiffLines: budget.max_diff_lines ?? DEFAULT_CONTRACT.budget.maxDiffLines,
      maxRuntimeMin: budget.max_runtime?.replace?.(/m$/, "") ?? DEFAULT_CONTRACT.budget.maxRuntimeMin,
    },
    allow: (y.permissions?.allow ?? DEFAULT_CONTRACT.allow).map(String),
    deny: (y.permissions?.deny ?? DEFAULT_CONTRACT.deny).map(String),
  };
}

function matchGlob(pattern, path) {
  if (pattern === path) return true;
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return path === base || path.startsWith(base + "/");
  }
  if (pattern.startsWith("**/")) return path.endsWith(pattern.slice(3));
  return false;
}

export function checkDiff(files, contract, root = process.cwd()) {
  const checks = [];
  const changedFiles = files.filter((f) => f.length > 0);
  const forbidden = changedFiles.filter((f) => contract.deny.some((p) => matchGlob(p, f)));
  checks.push({ name: "no_forbidden_paths", result: forbidden.length === 0 ? "pass" : "fail", detail: forbidden.join(", ") || undefined });
  checks.push({ name: "max_changed_files", result: changedFiles.length <= contract.budget.maxChangedFiles ? "pass" : "fail", detail: changedFiles.length + "/" + contract.budget.maxChangedFiles });
  return { checks, changedFiles };
}
