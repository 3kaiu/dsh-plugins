// emit/html.ts — 静态 preview serializer(离线渲染验证入口)
//
// 与 react.ts 消费同一 Strategy IR —— preview.html 是 React 交付物的渲染代理:
// 样式 1:1 同源(同一份 camelCase style 对象经同一序列化器), 结构同构,
// data-restore-node 属性一致。验证循环(screenshot/dom-blocks/verify)渲染本文件,
// 避免为 V1 引入 React 构建链; 修复循环的 Patch 同时作用于两份(同源所以等价)。
import { buildElementTree, styleToCssDeclarations } from './style-ir.ts'
import { sanitizeSvg } from '../target/svg-sanitize.ts'
import { esc } from './escape.ts'

/**
 * 生成 preview.html(自包含单文件, 无网络依赖)。
 * @returns {{files:{path,content}[], map}} map 与 react 版同构(selector 一致)
 */
export function emitPreviewHtml(bp, plan, assets, profile, opts: Record<string, any> = {}) {
  const ctx = {
    contractById: plan.byId,
    assetByNode: new Map((assets?.assets || []).filter((a: any) => a.status === 'resolved').flatMap((a: any) => [[a.id, a], [a.key, a]])),
    fontStack: (profile?.fonts?.fallbackStack || ['sans-serif']).map((f: any) => `'${f}'`).join(', '),
  }
  const roots = buildElementTree(bp, ctx)
  const mapEntries = []
  const body = []
  const render = (el: any, indent: any) => {
    const pad = ' '.repeat(indent)
    const decl = styleToCssDeclarations(el.style)
    const attrs = [`data-restore-node="${el.nodeId}"`]
    if (el.assetMissing) attrs.push(`data-asset-missing="${esc(el.assetMissing)}"`)
    const style = decl ? ` style="${esc(decl)}"` : ''
    const selfText = el.text != null && !el.textRuns?.length ? esc(el.text) : ''
    if (selfText) {
      body.push(`${pad}<div ${attrs.join(' ')}${style}>${selfText}</div>`)
      mapEntries.push({ nodeId: el.nodeId, file: 'preview.html', selector: `[data-restore-node="${el.nodeId}"]`, line: body.length })
      return
    }
    body.push(`${pad}<div ${attrs.join(' ')}${style}>`)
    mapEntries.push({ nodeId: el.nodeId, file: 'preview.html', selector: `[data-restore-node="${el.nodeId}"]`, line: body.length })
    if (el.rawSvg) {
      // 内联矢量: 外层容器定尺寸, svg 100% 填充（经白名单消毒）
      const clean = sanitizeSvg(el.rawSvg)
      body.push(`${pad}  <div style="width:100%;height:100%">${clean}</div>`)
    }
    if (el.textRuns?.length) {
      for (const r of el.textRuns) {
        const rs = styleToCssDeclarations(r.style)
        body.push(`${pad}  <span${rs ? ` style="${esc(rs)}"` : ''}>${esc(r.text)}</span>`)
      }
    }
    for (const c of el.children) render(c, indent + 2)
    body.push(`${pad}</div>`)
  }
  for (const el of roots) render(el, 4)
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>restore-preview ${bp.canvas.width}x${bp.canvas.height}</title>`,
    '<style>*{box-sizing:border-box}html,body{margin:0;padding:0}</style>',
    '</head><body>',
    `  <div data-restore-root style="position:relative;width:${bp.canvas.width}px;height:${bp.canvas.height}px;overflow:hidden;background:#FFFFFF;font-family:${esc(ctx.fontStack)}">`,
    ...body,
    '  </div>',
    '</body></html>',
  ].join('\n')
  return {
    files: [{ path: 'preview.html', content: html }],
    map: { version: 1, canvas: bp.canvas, entries: mapEntries },
  }
}
