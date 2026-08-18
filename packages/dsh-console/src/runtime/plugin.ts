// @3kaiu/dsh-console —— dsh web 插件入口(Cordis)
// 随官方 dsh web 进程启动 Console 工作台(事件库 REST/WS + 前端,默认 3090)。
// 安装:dsh plugin --profile <name> add @3kaiu/dsh-console(或 install-local)
// 之后重启 dsh web 即生效,无需单独进程。
import { createConsoleServer } from "./server.ts";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

const name = "dsh-console";
const NS = settingsNamespace("dsh-console");
// 声明 settings 服务注入(供「插件配置」面板的 settings.describe/mutate 代理)
const inject = ["settings"];

const Config = z.object({
  port: z.number().min(1024).max(65535).default(3090),
});

function apply(ctx, config) {
  let lastGood;
  const current = () => {
    try {
      const next = Config(config ?? {});
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      ctx.logger?.error("[dsh-console] keeping the last good configuration");
      ctx.logger?.error(error);
      return lastGood;
    }
  };
  // Cordis 语义:ctx.effect(fn) 的 fn 立即执行(插件激活期),返回值 = 卸载时清理。
  ctx.effect(() => {
    const { server, port } = createConsoleServer({ port: current().port, logger: (m) => ctx.logger.info(m), settings: ctx.settings });
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

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { config = source; },
    onChange: () => {},
  });
}

export { Config, apply, name, inject };
