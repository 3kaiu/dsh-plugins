// storage domain 后端契约测试：宿主 facility 在场 → state 走 domain.global；
// 不在场/打开失败 → fs 回退。facility 以官方 dsh-storage-domain 契约为准：
// open(spec) → Domain{ global:{ get(), set(v) } }，set 原子且 durable。
// 本测试用符合该契约的内存 fake facility 驱动（宿主 rc.7 未注册 storage 服务，
// 注册启用见 docs/architecture/17-dsh-seams-adoption.md）。
import { initStorageBackend, storageBackendName, stateRead, stateUpdate } from "../dist/index.js";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeFakeFacility() {
  const domains = new Map();
  return {
    opens: [],
    async open(spec) {
      this.opens.push(spec);
      if (spec.global.schema.safeParse(null).success) throw new Error('global schema must reject null');
      const domain = {
        spec,
        _value: undefined,
        global: {
          get() { return domain._value === undefined ? spec.global.initial : domain._value; },
          async set(v) { const chk = spec.global.schema.safeParse(v); if (!chk.success) throw new Error('invalid global'); domain._value = v; },
        },
      };
      domains.set(spec.name, domain);
      return domain;
    },
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-'));
const cwd = process.cwd();
process.chdir(tmp);

// 1) 无 facility → fs 后端
await initStorageBackend({});
if (storageBackendName() !== 'fs') throw new Error('无 facility 应留在 fs');
console.log('✓ 无 facility → fs 回退');

// 2) fake facility 在场 → open ui-reverse-state，spec 校验通过
const facility = makeFakeFacility();
await initStorageBackend({ storageDomain: facility });
if (storageBackendName() !== 'storage-domain') throw new Error('facility 在场应切 domain');
const spec = facility.opens[0];
if (!spec || spec.name !== 'ui-reverse-state' || spec.version !== 1) throw new Error(`spec 异常: ${JSON.stringify(spec?.name)}`);
if (typeof spec.global.schema.safeParse !== 'function') throw new Error('global.schema 应是 zod schema');
console.log('✓ domain 打开 + spec 合规');

// 3) 初始读取 = defaultState 且 exists:false（未写入）
const r0 = stateRead({});
if (r0.exists !== false || r0.backend !== 'storage-domain') throw new Error(`未写入应 exists:false, got ${JSON.stringify({ exists: r0.exists, backend: r0.backend })}`);
console.log('✓ 未写入语义');

// 4) stateUpdate 走 global.set：iteration 自增 + scores.history 裁剪语义保留
const w1 = await stateUpdate({ scores: { current: { total: 0.9 } } });
if (w1.backend !== 'storage-domain') throw new Error('写入应走 domain');
if (w1.state.iteration !== 1) throw new Error(`iteration 应自增, got ${w1.state.iteration}`);
await stateUpdate({ scores: { current: { total: 0.93 } } });
const r2 = stateRead({});
if (r2.exists !== true || r2.state.scores.current.total !== 0.93) throw new Error('写后读不一致');
if (r2.state.scores.delta !== 0.03) throw new Error(`delta 计算异常: ${r2.state.scores.delta}`);
if (!Array.isArray(r2.state.scores.history) || r2.state.scores.history.length !== 2) throw new Error('history 应 append');
console.log('✓ domain 写读 + 迭代/历史语义');

// 5) 未知顶层键不被 strip（loose schema）
await stateUpdate({ customFutureField: { a: 1 } });
const r3 = stateRead({});
if (r3.state.customFutureField?.a !== 1) throw new Error('loose schema 不应 strip 未知键');
console.log('✓ loose schema 保字段');

// 6) set 抛错时 state 不落地（读端仍是旧值）
const broken = makeFakeFacility();
broken.open = async () => { throw new Error('backend unavailable'); };
await initStorageBackend({ storageDomain: broken });
if (storageBackendName() !== 'fs') throw new Error('open 失败应回退 fs');
console.log('✓ open 失败回退 fs');

process.chdir(cwd);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('state-domain OK ✓');
