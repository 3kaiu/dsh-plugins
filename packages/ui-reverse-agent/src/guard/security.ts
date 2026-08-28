'use strict'
// security — DSL 净化与资源校验（输入侧守卫，与 anti_hack 输出侧互补）
// 输入：MasterGo DSL / 中立树 / screenshotPaths 的外部资源（text/URL/svg）
// 输出：{passed, violations, sanitized}

const ALLOWED_URL_PREFIXES = ['https://image-resource.mastergo.com/', 'https://cdn.', 'data:image/']
const BLOCKED_PATTERNS = [/<script/i, /javascript:/i, /on\w+\s*=/i, /data:text\/html/i]

export function sanitizeText(text) {
  if (typeof text !== 'string') return text
  let out = text
  // 去除控制字符，保留 \n
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  // 截断超长（10k）
  if (out.length > 10000) out = out.slice(0, 10000)
  return out
}

export function isAllowedUrl(url) {
  if (!url || typeof url !== 'string') return false
  if (url.startsWith('data:image/')) return true
  return ALLOWED_URL_PREFIXES.some(p => url.startsWith(p)) || url.startsWith('assets/') || url.startsWith('./assets/') || url.startsWith('/assets/')
}

export function checkDslSecurity(dsl) {
  const violations = []
  const warnings = []

  const texts = []
  const urls = []
  const svgs = []
  function walk(n) {
    if (!n || typeof n !== 'object') return
    if (typeof n.text === 'string') texts.push(n.text)
    if (Array.isArray(n.text)) for (const t of n.text) if (t?.text) texts.push(t.text)
    if (typeof n.fill === 'string' && (n.fill.startsWith('http') || n.fill.startsWith('data:'))) urls.push(n.fill)
    if (n.fill?.url) urls.push(n.fill.url)
    if (n.svg || n.svgShortKey || n.svgKey) svgs.push(n.svg || '')
    if (Array.isArray(n.children)) for (const c of n.children) walk(c)
    if (Array.isArray(n.nodes)) for (const c of n.nodes) walk(c)
  }
  walk(dsl)

  for (const t of texts) {
    for (const pat of BLOCKED_PATTERNS) {
      if (pat.test(t)) violations.push({ rule: 'xss-text', text: t.slice(0, 80), pattern: String(pat), reason: '文本含可执行脚本模式' })
    }
  }
  for (const u of urls) {
    if (!isAllowedUrl(u)) warnings.push({ rule: 'untrusted-url', url: u.slice(0, 120), reason: 'URL 非 allowlist，建议本地化或校验' })
    for (const pat of BLOCKED_PATTERNS) {
      if (pat.test(u)) violations.push({ rule: 'xss-url', url: u.slice(0, 80), reason: 'URL 含脚本模式' })
    }
  }
  for (const s of svgs) {
    if (typeof s === 'string' && BLOCKED_PATTERNS.some(p => p.test(s))) {
      violations.push({ rule: 'xss-svg', reason: 'SVG 含脚本模式' })
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    warnings,
    summary: violations.length ? `violations: ${violations.map(v=>v.rule).join(',')}` : warnings.length ? `warnings: ${warnings.length}` : 'security pass',
  }
}

export function sanitizeDsl(dsl) {
  const clone = JSON.parse(JSON.stringify(dsl))
  function walk(n) {
    if (!n || typeof n !== 'object') return
    if (typeof n.text === 'string') n.text = sanitizeText(n.text)
    if (Array.isArray(n.text)) for (const t of n.text) if (t?.text) t.text = sanitizeText(t.text)
    if (Array.isArray(n.children)) for (const c of n.children) walk(c)
    if (Array.isArray(n.nodes)) for (const c of n.nodes) walk(c)
  }
  walk(clone)
  return clone
}
