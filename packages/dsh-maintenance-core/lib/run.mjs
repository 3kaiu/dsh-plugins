// 子进程助手:安全捕获输出,不抛异常
import { spawnSync } from "node:child_process";

export function runCommand(command, { cwd, timeoutMs = 120000, env = {} } = {}) {
  const res = spawnSync(command, { cwd, shell: true, timeout: timeoutMs, env: { ...process.env, ...env }, encoding: "utf8" });
  return {
    exitCode: res.status,
    signal: res.signal ?? null,
    stdout: (res.stdout ?? "").slice(0, 8000),
    stderr: (res.stderr ?? "").slice(0, 4000),
    outputTail: ((res.stdout ?? "") + (res.stderr ?? "")).trim().slice(-2000),
  };
}
