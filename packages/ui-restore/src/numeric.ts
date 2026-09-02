// numeric — 数值舍入单一来源(收敛自 ui-restore 内 8 处同名拷贝)
//
// 历史陷阱(批2 收敛时查明): 8 处拷贝都名叫 round1, 实为【两位小数】舍入(/100);
// 而 kit layout-core 的 round1 是【一位小数】(/10) —— 同名不同义, 盲目按名合并会改数值输出。
// 正名约定: round1 = 一位小数(布局引擎坐标语义, 正本在 @3kaiu/dsh-plugin-kit,
// 本包经 kit 再导出, 批3 后本地不再定义); round2 = 两位小数(指标/落盘语义)。

/** 一位小数舍入(布局坐标; 正本 = @3kaiu/dsh-plugin-kit cluster.round1) */
export { round1 } from '@3kaiu/dsh-plugin-kit'

/** 两位小数舍入(指标/diffRatio/token 数值; null/undefined 归 0) */
export const round2 = (n: any) => Math.round((n || 0) * 100) / 100
