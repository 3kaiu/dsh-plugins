// playwright 为可选 peerDependency(未装则运行时给出安装提示), 类型经此垫片引入
declare module 'playwright' {
  export const chromium: any;
}
