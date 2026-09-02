// system-chrome.ts - 系统元素(设备界面)识别
// 设计稿中常包含状态栏(时间/电量)、Home Indicator、刘海等系统 UI。
// 真实代码中它们由运行环境(安全区/系统)提供,生成代码时应剔除,不渲染。
// 识别为独立 kind 'system-chrome',sizing 语义归类 'environment'
// (尺寸由环境决定,区别于 auto/fixed)。

const CHROME_NAME = /home\s*indicator|状态栏|status\s*bar|notch|刘海|灵动岛|dynamic\s*island/i
const TIME_TEXT = /^\d{1,2}:\d{2}$/

/**
 * 判断节点是否为系统元素(状态栏/Home Indicator 等)。
 * @param {object} node DSL 节点
 * @param {number} [absY] 节点画布绝对 Y(时间文本需位于顶部)
 * @returns {{kind:'system-chrome', confidence:number, reason:string[]}|null}
 */
export function systemChromeOf(node: any, absY: any) {
  const name = node.name || ''
  if (CHROME_NAME.test(name)) {
    return { kind: 'system-chrome', confidence: 1, reason: [`命名含系统元素语义:"${name}"`] }
  }
  let text = ''
  if (typeof node.text === 'string') text = node.text
  else if (Array.isArray(node.text)) text = node.text.map((t: any) => (t && t.text) || '').join('')
  if (node.type === 'TEXT' && TIME_TEXT.test(text.trim()) && (absY == null || absY < 100)) {
    return { kind: 'system-chrome', confidence: 0.9, reason: [`顶部时间文本"${text.trim()}"(状态栏内容)`] }
  }
  return null
}
