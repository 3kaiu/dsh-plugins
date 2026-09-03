// QuotaTracker: 限流/配额冷却跟踪与用量遥测(插件通用)
//
// 设计目标:
// - 任何"有限免费额度 + 服务端限流"的 API 适配器都可复用;
// - per-session 冷却隔离:新会话不被别的会话的冷却拖累;
// - 原子持久化(tmp + rename):崩溃/多实例并发写不会留下半写文件;
// - 主动 pacing:滚动窗口请求预算,在触发服务端 402/429 前先放慢节奏。

import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_COOLDOWN_MS = 60000;
export const PERSIST_DEBOUNCE_MS = 5000;

/** 会话 → 稳定不透明的 bucket key(sha256 哈希,避免明文 session id 外泄) */
export function sessionKeyOf(sessionId: any, projectId: any) {
  if (sessionId === void 0 || sessionId === null)
    return `ses_${createHash("sha256").update(`default:${projectId}`).digest("base64url").slice(0, 16)}`;
  return `ses_${createHash("sha256").update(String(sessionId)).digest("base64url").slice(0, 16)}`;
}

export class QuotaTracker {
  file;
  now;
  requests = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCacheReadTokens = 0;
  totalReasoningTokens = 0;
  rateLimited = 0;
  quotaExceeded = 0;
  sessionCooldowns: Record<string, any> = {};
  requestTimes: Record<string, any> = {};
  pacing = { enabled: true, maxRequests: 3, windowMs: 20000, maxHoldMs: 15000 };
  projectId = `proj_${randomBytes(12).toString("base64url")}`;
  lastPersistAt = 0;

  constructor(file: any, now: any = () => Date.now()) {
    this.file = file;
    this.now = now;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      this.requests = data.requests ?? 0;
      this.totalInputTokens = data.totalInputTokens ?? 0;
      this.totalOutputTokens = data.totalOutputTokens ?? 0;
      this.totalCacheReadTokens = data.totalCacheReadTokens ?? 0;
      this.totalReasoningTokens = data.totalReasoningTokens ?? 0;
      this.rateLimited = data.rateLimited ?? 0;
      this.quotaExceeded = data.quotaExceeded ?? 0;
      this.sessionCooldowns = data.sessionCooldowns ?? {};
      if (typeof this.sessionCooldowns !== "object" || this.sessionCooldowns === null)
        this.sessionCooldowns = {};
      if (typeof data.cooldownUntil === "number" && data.cooldownUntil > 0)
        this.sessionCooldowns["default"] = Math.max(this.sessionCooldowns["default"] ?? 0, data.cooldownUntil);
      this.projectId = data.projectId ?? this.projectId;
    } catch {
      // 文件缺失/损坏 → 从零开始
    }
  }

  configurePacing(pacing: any) {
    if (pacing !== void 0 && pacing !== null) this.pacing = pacing;
  }

  /** 记录一次请求时间戳(供 pacing 预算使用) */
  markRequest(sessionId: any) {
    const bucket = this.sessionBucket(sessionId);
    const now = this.now();
    const window = Math.max(this.pacing.windowMs * 2, 1000);
    const times = (this.requestTimes[bucket] ?? []).filter((t: any) => now - t < window);
    times.push(now);
    this.requestTimes[bucket] = times;
  }

  /** 发送前需要等待的毫秒数(0 = 立即发送);滚动窗口预算,避免触发服务端限流 */
  pacingDelayMs(sessionId: any) {
    if (!this.pacing.enabled) return 0;
    const bucket = this.sessionBucket(sessionId);
    const now = this.now();
    const window = Math.max(this.pacing.windowMs, 1000);
    const times = (this.requestTimes[bucket] ?? []).filter((t: any) => now - t < window);
    if (times.length < this.pacing.maxRequests) return 0;
    const oldest = Math.min(...times);
    const wait = Math.min(oldest + window - now, this.pacing.maxHoldMs);
    return Math.max(0, wait);
  }

  recordQuotaExceeded() {
    this.quotaExceeded += 1;
    this.persist(true);
  }

  recordUsage(usage: any) {
    this.requests += 1;
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    if (usage.cacheReadTokens !== void 0) this.totalCacheReadTokens += usage.cacheReadTokens;
    if (usage.reasoningTokens !== void 0) this.totalReasoningTokens += usage.reasoningTokens;
    this.persist();
  }

  recordLimit(retryAfterMs: any, sessionId: any) {
    this.rateLimited += 1;
    this.sessionCooldowns[this.sessionBucket(sessionId)] =
      this.now() + (retryAfterMs ?? DEFAULT_COOLDOWN_MS);
    this.pruneCooldowns();
    this.persist(true);
  }

  cooldownRemainingMs(sessionId: any) {
    this.pruneCooldowns();
    const until = this.sessionCooldowns[this.sessionBucket(sessionId)] ?? 0;
    return Math.max(0, until - this.now());
  }

  sessionBucket(sessionId: any) {
    if (sessionId === void 0 || sessionId === null) return "default";
    return sessionKeyOf(sessionId, this.projectId);
  }

  pruneCooldowns() {
    const now = this.now();
    for (const key of Object.keys(this.sessionCooldowns)) {
      if (this.sessionCooldowns[key] <= now) delete this.sessionCooldowns[key];
    }
  }

  cacheHitRate() {
    const billed = this.totalInputTokens + this.totalCacheReadTokens;
    return billed > 0 ? this.totalCacheReadTokens / billed : 0;
  }

  snapshot() {
    return {
      requests: this.requests,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalReasoningTokens: this.totalReasoningTokens,
      cacheHitRate: this.cacheHitRate(),
      rateLimited: this.rateLimited,
      quotaExceeded: this.quotaExceeded,
      sessionCooldowns: this.sessionCooldowns,
      projectId: this.projectId,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * 原子持久化: 写 tmp 再 rename,崩溃/并发不会留下半写 JSON。
   * 刻意保持同步写(审计结论): 触发点已防抖(force 仅在配额耗尽/限流等低频事件),
   * JSON 体量小(<几 KB), 同步写对事件循环的影响可忽略; 改异步需引入
   * 写队列防 tmp 交错/乱序 rename, 复杂度不值。
   */
  persist(force = false) {
    if (!force && this.now() - this.lastPersistAt < PERSIST_DEBOUNCE_MS) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
      renameSync(tmp, this.file);
      this.lastPersistAt = this.now();
    } catch {
      // 持久化失败不阻断请求路径
    }
  }
}

export function createQuotaTracker(file: any, now: any) {
  return new QuotaTracker(file, now);
}
