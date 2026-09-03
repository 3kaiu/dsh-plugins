// args — CLI 参数解析单一来源(收敛自 adapters 内 5 份拷贝)
//
// 原两族语义已分叉: cli 版会识别"值以 -- 开头"防误吞旗标, screenshot/restore/loop/dom-blocks
// 四版盲取下一 argv —— 统一取 cli 版的守卫语义(对畸形输入返回 null 触发用法提示, 而非把旗标当值)。
// 带不带 `--` 前缀都接受(历史两种调用约定); 不 splice, 保持 args 数组纯净(避免 --help 场景误改参数表)。

const norm = (name: any) => (name.startsWith('--') ? name : `--${name}`)

/** 读 `--name value` 的值; 旗标不存在、缺值或值以 -- 开头(即下一旗标)时返回 dflt。 */
export function flag(args: any, name: any, dflt = null) {
  const i = args.indexOf(norm(name))
  if (i < 0) return dflt
  const v = args[i + 1]
  return v == null || String(v).startsWith('--') ? dflt : String(v)
}

/** 布尔开关: `--name` 出现即为 true(不消费值, 缺值也算开)。 */
export function hasFlag(args: any, name: any) {
  return args.indexOf(norm(name)) >= 0
}
