// ws 为 CDP 裸连接专用(dom-blocks: WebSocket 构造/事件/close), 类型经此垫片引入
declare module 'ws' {
  export class WebSocket {
    constructor(url: string, protocols?: string | string[]);
    addEventListener(type: string, listener: (ev: any) => void, options?: any): void;
    removeEventListener(type: string, listener: (ev: any) => void): void;
    close(code?: number, reason?: string): void;
    send(data: any, cb?: (err?: Error) => void): void;
    [key: string]: any;
  }
}
