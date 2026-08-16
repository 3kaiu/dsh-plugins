// events store:信号化事件窗口 + 会话聚合 + 失败聚合
import { signal, computed } from "@preact/signals";
import type { Envelope } from "../runtime/client";

export const events = signal<Envelope[]>([]);
export const seq = signal(0);
export const connected = signal(false);
export const lastSyncAt = signal<string | null>(null);

export interface SessionAgg {
  id: string;
  title: string;
  model: string;
  startedAt: string | null;
  completedAt: string | null;
  turns: number;
  tokens: { in: number; out: number };
  tools: number;
  reason: string;
}

export interface FailureAgg {
  key: string;
  taxonomy: string;
  severity: string;
  count: number;
  lastMessage: string;
  lastAt: string;
}

const MAX_WINDOW = 5000;
const sessionsMap = new Map<string, SessionAgg>();
const failuresMap = new Map<string, FailureAgg>();

function aggSession(e: Envelope): SessionAgg | undefined {
  const id = e.sessionId;
  if (!id) return undefined;
  let s = sessionsMap.get(id);
  if (!s) {
    s = { id, title: id.slice(0, 12), model: "", startedAt: null, completedAt: null, turns: 0, tokens: { in: 0, out: 0 }, tools: 0, reason: "" };
    sessionsMap.set(id, s);
  }
  const d = e.data as Record<string, any>;
  if (e.type === "session.started") {
    if (d.title) s.title = String(d.title);
    if (d.model) s.model = String(d.model);
    s.startedAt = e.at;
  } else if (e.type === "session.title") {
    if (d.title) s.title = String(d.title);
  } else if (e.type === "session.completed") {
    s.completedAt = e.at;
    s.turns = Number(d.turns) || s.turns;
    if (d.tokens) { s.tokens.in = Number((d.tokens as any).in) || 0; s.tokens.out = Number((d.tokens as any).out) || 0; }
    if (d.reason) s.reason = String(d.reason);
  } else if (e.type === "tool.started") {
    s.tools += 1;
  }
  return s;
}

function aggFailure(e: Envelope) {
  if (e.family !== "error" || e.type !== "error.recorded") return;
  const d = e.data as Record<string, any>;
  const taxonomy = String(d.taxonomy ?? "UNKNOWN");
  const severity = String(d.severity ?? "LOW");
  const key = taxonomy + "|" + severity;
  let f = failuresMap.get(key);
  if (!f) {
    f = { key, taxonomy, severity, count: 0, lastMessage: "", lastAt: e.at };
    failuresMap.set(key, f);
  }
  f.count += Number(d.occurrences) || 1;
  if (d.message) f.lastMessage = String(d.message);
  f.lastAt = e.at;
}

export function ingest(es: Envelope[]) {
  for (const e of es) {
    aggSession(e);
    aggFailure(e);
  }
  events.value = [...events.value, ...es].slice(-MAX_WINDOW);
  if (es.length) { seq.value = es[es.length - 1].seq; lastSyncAt.value = new Date().toISOString(); }
}

export const sessions = computed<SessionAgg[]>(() =>
  [...sessionsMap.values()].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")),
);
export const runningSessions = computed(() => sessions.value.filter((s) => !s.completedAt));
export const failures = computed<FailureAgg[]>(() =>
  [...failuresMap.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)),
);
export const recentEvents = computed(() => [...events.value].reverse().slice(0, 200));

export function resetStores() {
  sessionsMap.clear();
  failuresMap.clear();
  events.value = [];
  seq.value = 0;
}
