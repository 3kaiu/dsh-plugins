// opentype.js v2 无自带类型且 DT 声明针对 1.x; 本仓仅动态 import 后 parse 字体缓冲, 类型经此垫片引入
declare module 'opentype.js' {
  export function parse(data: ArrayBuffer): any;
}
