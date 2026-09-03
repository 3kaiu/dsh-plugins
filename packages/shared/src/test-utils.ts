// 测试助手: 插件测试共用的 mock 设施
//
// 用法示例:
//   import { mockFetch, mockCtx } from "@3kaiu/dsh-plugin-kit/test-utils";

/** 注入一个固定的 fetch mock;返回原 fetch 以便恢复 */
export function mockFetch(status: any, body: any, contentType: any = "application/json"): any {
  const original = globalThis.fetch;
  // mock 返回的是 Response 的鸭子形态(status/ok/headers/text), 非真实 Response 实例 —— 显式断言
  globalThis.fetch = (async () => ({
    status,
    ok: false,
    headers: new Map([["content-type", contentType]]),
    text: async () => body,
  })) as any;
  return original;
}

/** 最小可用的 Cordis ctx: 记录工具注册,logger 静默,可按名取服务 */
export function mockCtx(overrides: Record<string, any> = {}) {
  const registered: any[] = [];
  const ctx: any = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(def: any) {
        registered.push(def);
        return () => {};
      },
    },
    get(name: any) {
      return overrides.services?.[name];
    },
    ...overrides,
  };
  ctx.__registeredTools = registered;
  return ctx;
}

/** 断言辅助: 收集失败,最后统一退出非零 */
export function createChecker() {
  let failures = 0;
  const check = (label: any, actual: any, expected: any) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
      failures++;
      console.error(`✗ ${label}\n    期望: ${e}\n    实际: ${a}`);
    } else {
      console.log(`✓ ${label}`);
    }
  };
  const finish = (title = "测试") => {
    if (failures > 0) {
      console.error(`\n${failures} 项失败 ✗`);
      process.exit(1);
    }
    console.log(`\n${title}全部通过 ✓`);
  };
  return { check, finish };
}
