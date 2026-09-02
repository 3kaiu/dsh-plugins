// escape — HTML 转义单一来源(收敛自 5 份 emit 拷贝: html/react/tailwind/vue/miniprogram)
//
// escAttr 此前只在 vue.ts 存在且只转义双引号 —— 统一为强转义(补单引号),
// 对齐注入面更严的 ui-reverse-agent 适配器变体。

/** 文本/属性通用的 HTML 实体转义(& < > ") */
export const esc = (s: any) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 属性值转义: 在 esc 基础上补单引号(属性也可能被单引号包裹)。 */
export const escAttr = (s: any) => esc(s).replace(/'/g, '&#39;')
