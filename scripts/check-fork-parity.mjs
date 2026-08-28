// 分叉哨兵(doc19 §2.2 批2 乙方案): 锁定 kit 冻结版与 ui-restore v2 正本的输出形状关系。
//
// 不变量: 同一输入下, v2 输出键集 ⊇ kit 冻结版输出键集(超集兼容 ——
// layout-infer/ura 消费的字段, v2 正本必须都能给)。键漂移(任一侧删公共字段)在此炸出。
// 批3 归一后本哨兵改判"完全一致"或随分叉声明一起删除。
import { inferLayout, cleanToStandardDsl } from '../packages/shared/dist/index.js'
import { inferLayout as inferLayoutV2, cleanToStandardDsl as cleanToStandardDslV2 } from '../packages/ui-restore/dist/index.js'

let failed = 0
const check = (label, ok) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failed++ }

const keySet = (o, prefix = '', acc = new Set()) => {
  for (const [k, v] of Object.entries(o || {})) {
    const p = prefix ? `${prefix}.${k}` : k
    acc.add(p)
    if (v && typeof v === 'object' && !Array.isArray(v)) keySet(v, p, acc)
  }
  return acc
}

const container = { width: 375, height: 100 }
const children = [
  { id: 'a', x: 0, y: 0, width: 100, height: 40 },
  { id: 'b', x: 120, y: 0, width: 100, height: 40 },
]

const frozen = inferLayout({ container, children })
const v2 = inferLayoutV2({ container, children })
check('inferLayout 两侧可调用(同一 {container, children} 签名)', !!frozen && !!v2)
const missing = [...keySet(frozen)].filter((k) => !keySet(v2).has(k))
check(`inferLayout 输出形状超集兼容(v2 ⊇ 冻结)${missing.length ? ' —— 缺: ' + missing.join(', ') : ''}`, missing.length === 0)

// cleanToStandardDsl 契约: 两侧行为必须一致 —— 都成功或都拒绝, 不允许单侧抛错(签名/形态漂移信号)
const dsl = { nodes: [{ type: 'TEXT', id: 't1', name: '文本', x: 10, y: 10, width: 80, height: 20, text: 'hi' }] }
const attempt = (fn) => { try { return { ok: !!fn(dsl) } } catch (e) { return { err: e.message } } }
const a1 = attempt(cleanToStandardDsl)
const a2 = attempt(cleanToStandardDslV2)
check(`cleanToStandardDsl 行为一致(kit=${a1.ok ? 'ok' : 'reject'} / v2=${a2.ok ? 'ok' : 'reject'})`, !!a1.ok === !!a2.ok)

if (failed) { console.error(`fork-parity: ${failed} 项失败 ✗`); process.exit(1) }
console.log('fork-parity OK ✓')
