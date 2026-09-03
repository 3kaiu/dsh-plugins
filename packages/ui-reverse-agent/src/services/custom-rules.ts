'use strict'
// custom-rules — 用户自定义设计系统 lint 规则引擎（Phase2/5 的可扩展校验）
// 输入：rules [{id, prop, test:(value)=>boolean, message}]，输出：violations

export function defineRule({ id, prop, test, message, severity = 'warning' }) {
  return { id, prop, test, message, severity }
}

export function checkCustomRules({ prop, value, path }, rules = []) {
  const violations = []
  for (const r of rules) {
    if (r.prop && r.prop !== prop && r.prop !== '*') continue
    try {
      const ok = r.test(value, { prop, path })
      if (!ok) violations.push({ rule: r.id, prop, value, path, message: r.message || `custom ${r.id}`, severity: r.severity })
    } catch (e) {
      violations.push({ rule: r.id, error: String(e), severity: 'error' })
    }
  }
  return { passed: violations.length === 0, violations, summary: violations.length ? `custom ${violations.length}` : 'custom pass' }
}

export const PRESET_RULES = {
  noMagicNumbers: defineRule({ id: 'no-magic', prop: '*', test: (v: any) => typeof v !== 'number' || v % 4 === 0, message: '数值应为 4 的倍数', severity: 'warning' }),
  maxWidth: defineRule({ id: 'max-width', prop: 'width', test: (v: any) => v <= 1440, message: '宽度不应超画布', severity: 'error' }),
}
