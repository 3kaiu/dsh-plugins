// health store:30s 轮询 /api/health/summary
import { signal } from "@preact/signals";

export interface HealthSummary {
  seq: number;
  count: number;
  families: Record<string, number>;
  eventsDir: string;
  server: string;
  at: string;
}

export const health = signal<HealthSummary | null>(null);
export const healthError = signal<string | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;

export async function refreshHealth() {
  try {
    const res = await fetch("/api/health/summary");
    if (!res.ok) throw new Error("health failed");
    health.value = await res.json();
    healthError.value = null;
  } catch (err) {
    healthError.value = String(err);
  }
}

export function startHealthPolling(ms = 30000) {
  refreshHealth();
  if (timer) clearInterval(timer);
  timer = setInterval(refreshHealth, ms);
}
