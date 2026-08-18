// @3kaiu/dsh-plugins-ui browser half
// 设置弹窗「插件」tab:管理(安装/卸载/升级/重启)。
// 配置卡已收敛:模型类设置 → 官方「模型」tab(llm.providers 目录已含
// OpenCode Zen);运行参数 → Console(3090)「设置 → 插件配置」。
// 打包为 closure-factory bundle(dist/client.js),经 package.json 的
// dsh.client 声明被 host 自动注入 __DSH_BOOT__ 并服务 /plugins/<id>/client.js。
// 依赖全部走 loader module table(react 等平台模块 external),零自持依赖。

import { ManageTab } from "./manage.tsx";

const LOCALE_NS = "dsh-plugins-ui";

// browser cordis 插件:注入 slots / locale / connection / settingsScope
export const inject = ["slots", "locale"];

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.locale.register(LOCALE_NS, {
        zh: { title: "插件设置", manageTab: "管理" },
        en: { title: "Plugin settings", manageTab: "Manage" },
      }),
    "dsh-plugins-ui.locale",
  );

  // 「插件 → 管理」tab:安装 / 卸载 / 升级 / 重启(后端 = PluginManager remote)
  const t = ctx.locale.bind(LOCALE_NS);
  ctx.slots.inject("settings.plugins.tab", () =>
    ctx.slots.register(
      {
        name: "settings.plugins.tab",
        id: "manage",
        order: 20,
        label: () => t("manageTab"),
        locale: LOCALE_NS,
        inject: () => ({}),
      },
      ManageTab,
    ),
  );
}
