// @3kaiu/dsh-plugins-ui browser half
// 设置弹窗「插件」tab 的卡片:对每个已注册 settings namespace 贡献一张
// schema 驱动的配置卡(与官方 AgentLoop/Bash/WebSearch 卡同 slot 并列)。
// 打包为 closure-factory bundle(dist/client.js),经 package.json 的
// dsh.client 声明被 host 自动注入 __DSH_BOOT__ 并服务 /plugins/<id>/client.js。
// 依赖全部走 loader module table(react 等平台模块 external),零自持依赖。

import { SchemaCard } from "./schema-card.tsx";

const LOCALE_NS = "dsh-plugins-ui";

interface CardSpec {
  ns: string;
  title: string;
  description: string;
}

const CARDS: CardSpec[] = [
  { ns: "llm-opencode-zen", title: "OpenCode Zen 模型", description: "并发、节奏、重试与模型列表" },
  { ns: "github-sync", title: "GitHub 同步", description: "轮询、仓库、超时与批上限" },
  { ns: "runtime-events", title: "运行时事件", description: "事件采集与用量记录" },
  { ns: "harness-updater", title: "运行时更新", description: "版本检查间隔" },
  { ns: "dsh-console", title: "事件控制台", description: "工作台服务端口(重启生效)" },
];

// browser cordis 插件:注入 slots / locale / connection / settingsScope
export const inject = ["slots", "locale", "connection", "settingsScope"];

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.locale.register(LOCALE_NS, {
        zh: { title: "插件设置" },
        en: { title: "Plugin settings" },
      }),
    "dsh-plugins-ui.locale",
  );
  const connection = ctx.get("connection");
  const scopeBinder = ctx.get("settingsScope");
  const describeAll = () => connection.api.settings.describe({ redactSecrets: true });

  ctx.slots.inject("settings.plugin.item", function* () {
    for (const spec of CARDS) {
      const scope = scopeBinder.bind({ namespace: spec.ns });
      yield ctx.slots.register(
        {
          name: "settings.plugin.item",
          key: spec.ns,
          locale: LOCALE_NS,
          inject: () => ({ hooks: { card: { spec, scope, describeAll } } }),
        },
        SchemaCard,
      );
    }
  });
}
