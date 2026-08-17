// @3kaiu/dsh-console —— dsh web 插件入口(Cordis)
// 随官方 dsh web 进程启动 Console 工作台(事件库 REST/WS + 前端,默认 3090)。
// 安装:dsh plugin --profile <name> add @3kaiu/dsh-console(或 install-local)
// 之后重启 dsh web 即生效,无需单独进程。
import { createConsoleServer } from "./server.mjs";

const name = "dsh-console";

function apply(ctx) {
  // Cordis 语义:ctx.effect(fn) 的 fn 立即执行(插件激活期),返回值 = 卸载时清理。
  ctx.effect(() => {
    const { server, port } = createConsoleServer({ logger: (m) => ctx.logger.info(m) });
    server.listen(port, "127.0.0.1", () => {
      ctx.logger.info("[dsh-console] Console 工作台 http://127.0.0.1:" + port);
    });
    server.on("error", (err) => {
      ctx.logger.error("[dsh-console] " + String(err?.message ?? err));
    });
    return () => {
      try { server.close(); } catch {}
    };
  });
}

export { apply, name };
