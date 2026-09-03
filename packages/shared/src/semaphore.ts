// Semaphore: 轻量并发信号量(插件通用)
//
// 槽位语义: active < max 直接占用;否则排队等待,队列空时 release 归还槽位。
// abort 支持:等待中的 waiter 可被 signal 取消并从队列移除。
// errorFactory 可注入,让调用方把取消错误包装成自己的错误类型
// (如 LlmError "ABORTED"),shared 本身不依赖任何 dsh 包。

export class Semaphore {
  max;
  errorFactory;
  active = 0;
  waiters: any[] = [];

  constructor(max: any, errorFactory: any = (message: any) => new Error(message)) {
    this.max = max;
    this.errorFactory = errorFactory;
  }

  acquire(signal: any) {
    // 已中止的 signal 两个分支都必须拒绝：
    // - 快路径会白占槽位去做必败工作；
    // - 入队后 abort 事件已发、监听永不触发 → promise 永不 settle、槽位永久泄漏。
    if (signal?.aborted) {
      return Promise.reject(this.errorFactory("cancelled before acquiring a concurrency slot"));
    }
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    return new Promise((resolve, reject) => {
      const waiter: any = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(this.errorFactory("cancelled while waiting for a concurrency slot"));
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      // resolve 后清理 abort 监听，避免监听器滞留到 signal 被 GC
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      next.resolve();
    } else {
      this.active -= 1;
    }
  }
}
