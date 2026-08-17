// Semaphore: 轻量并发信号量(插件通用)
//
// 槽位语义: active < max 直接占用;否则排队等待,队列空时 release 归还槽位。
// abort 支持:等待中的 waiter 可被 signal 取消并从队列移除。
// errorFactory 可注入,让调用方把取消错误包装成自己的错误类型
// (如 LlmError "ABORTED"),shared 本身不依赖任何 dsh 包。

export class Semaphore {
  max;
  active = 0;
  waiters = [];

  constructor(max, errorFactory = (message) => new Error(message)) {
    this.max = max;
    this.errorFactory = errorFactory;
  }

  acquire(signal) {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(this.errorFactory("cancelled while waiting for a concurrency slot"));
      }, { once: true });
    });
  }

  release() {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active -= 1;
  }
}
