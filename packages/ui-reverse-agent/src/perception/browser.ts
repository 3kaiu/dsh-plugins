'use strict'
// Playwright 封装：单例浏览器 + 每任务一个 context
// 工具与浏览器通过此 service 交互；未安装 chromium 时优雅降级（返回 mock）

let browserInstance = null
let contextInstance = null
let pageInstance = null

async function getPlaywright() {
  try {
    const pw = await import('playwright')
    return pw
  } catch (e) {
    return null
  }
}

// exec.signal 契约(官方 "Honor exec.signal"): 调用方取消时在途工作必须中止。
// page.evaluate 无原生 signal 选项，用 race 包装; 其余 Playwright API 原生透传。
function raceAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new Error('aborted before dispatch'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

export async function browserStart({ url, headless = true, viewport, signal } = {}) {
  if (signal?.aborted) return { error: 'aborted', mock: true }
  const pw = await getPlaywright()
  if (!pw) return { error: 'playwright not installed', url: url || 'http://localhost:3000', mock: true }
  const { chromium } = pw
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless })
  }
  contextInstance = await browserInstance.newContext({
    viewport: viewport || { width: 1440, height: 900 },
    deviceScaleFactor: viewport?.dpr || 2,
  })
  pageInstance = await contextInstance.newPage()
  if (url) {
    try { await pageInstance.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000, signal }) } catch (e) { /* ignore */ }
  }
  return { url: url || 'about:blank', viewport: viewport || { width: 1440, height: 900 }, launched: true }
}

export async function browserViewport({ width, height, dpr } = {}) {
  const vp = { width: width || 1440, height: height || 900, dpr: dpr || 2 }
  if (pageInstance) {
    try { await pageInstance.setViewportSize({ width: vp.width, height: vp.height }) } catch {}
  } else if (contextInstance) {
    // 需重建 context 时由调用方重新 start
  }
  return vp
}

export async function browserNavigate({ url, signal }) {
  if (!pageInstance) return { error: 'browser not started', url }
  try {
    await pageInstance.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000, signal })
    return { url, ok: true }
  } catch (e) {
    return { url, ok: false, error: String(e) }
  }
}

export async function browserScreenshot({ path: outPath, fullPage = true, selector, signal } = {}) {
  if (!pageInstance) return { error: 'browser not started', path: outPath || null, mock: true }
  const p = outPath || `.ui-reverse/artifacts/current-${Date.now()}.png`
  try {
    if (selector) {
      const loc = pageInstance.locator(selector)
      await loc.screenshot({ path: p, signal })
    } else {
      await pageInstance.screenshot({ path: p, fullPage, signal })
    }
    return { path: p, fullPage, ok: true }
  } catch (e) {
    return { error: String(e), path: null }
  }
}

export async function browserDomDump({ selector = 'body', includeComputed = true, signal } = {}) {
  if (!pageInstance) return { error: 'browser not started', viewport: { width: 1440, height: 900, dpr: 2 }, tree: [], mock: true }

  // 在页面内执行结构化 dump
  try {
    const dump = await raceAbort(pageInstance.evaluate(({ selector, includeComputed }) => {
      let uid = 0 // 每次 dump 的确定性序号：同 DOM 两次 dump 的 id 一致（Math.random 会破坏配对）
      function getRect(el) {
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      }
      function getComputed(el) {
        if (!includeComputed) return {}
        const cs = getComputedStyle(el)
        const pick = {}
        for (const k of ['display','flexDirection','flexWrap','alignItems','justifyContent','gap','rowGap','columnGap','padding','paddingTop','paddingRight','paddingBottom','paddingLeft','position','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','borderRadius','opacity','transform']) {
          pick[k] = cs[k]
        }
        return pick
      }
      function visible(el) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') return false
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        return true
      }
      function build(el, depth=0) {
        if (depth > 12) return null
        if (!visible(el)) return null
        const tag = el.tagName.toLowerCase()
        const rect = getRect(el)
        const computed = getComputed(el)
        const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 ? el.textContent.trim().slice(0,200) : ''
        const children = []
        for (const ch of el.children) {
          const c = build(ch, depth+1)
          if (c) children.push(c)
        }
        return {
          id: el.id || `${tag}-${(++uid).toString(36)}`,
          tag, selector: tag, role: el.getAttribute('role') || '',
          rect, text, visible: true, children, computed
        }
      }
      const root = selector ? document.querySelector(selector) : document.body
      if (!root) return { viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }, tree: [], issues: ['selector not found'] }
      // build 只跑一次：双重调用既浪费一次整树遍历，也让计数器序号漂移
      const rootTree = build(root)
      const tree = rootTree ? [rootTree] : []
      const issues=[]
      // 字体加载检查
      if (document.fonts) {
        for (const f of document.fonts) {
          if (f.status !== 'loaded') issues.push(`font '${f.family}' not loaded (${f.status})`)
        }
      }
      return { viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }, tree, issues }
    }, { selector, includeComputed }), signal)
    return dump
  } catch (e) {
    if (signal?.aborted) return { error: 'aborted', viewport: { width: 1440, height: 900, dpr: 2 }, tree: [] }
    return { error: String(e), viewport: { width: 1440, height: 900, dpr: 2 }, tree: [] }
  }
}

export async function browserStateTrigger({ state, selector, signal } = {}) {
  // state: hover | active | focus | disabled | checked
  if (!pageInstance) return { error: 'browser not started', mock: true }
  try {
    if (state === 'hover' && selector) {
      await pageInstance.hover(selector, { timeout: 3000, signal })
    } else if (state === 'focus' && selector) {
      await pageInstance.focus(selector)
    } else if (state === 'active' && selector) {
      // mouse down
      const loc = pageInstance.locator(selector)
      await loc.click({ timeout: 3000, signal })
    }
    // 截图
    const p = `.ui-reverse/artifacts/state-${state}-${Date.now()}.png`
    await pageInstance.screenshot({ path: p, fullPage: true, signal })
    return { state, selector, path: p, ok: true }
  } catch (e) {
    return { state, selector, error: String(e) }
  }
}

export async function browserConsole() {
  if (!pageInstance) return { error: 'browser not started', logs: [], mock: true }
  // 简化：返回最近的 console 错误（需监听）
  return { logs: [], issues: [] }
}

export async function browserStop() {
  try { await pageInstance?.close() } catch {}
  try { await contextInstance?.close() } catch {}
  // 保留 browserInstance 复用，进程结束时再关闭
  pageInstance = null
  contextInstance = null
  return { stopped: true }
}

export async function browserClose() {
  try { await pageInstance?.close() } catch {}
  try { await contextInstance?.close() } catch {}
  try { await browserInstance?.close() } catch {}
  browserInstance = null
  pageInstance = null
  contextInstance = null
  return { closed: true }
}
