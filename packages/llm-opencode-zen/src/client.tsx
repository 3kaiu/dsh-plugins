// @3kaiu/dsh-llm-opencode-zen browser half
// 设置弹窗「插件 → OpenCode Zen 模型」tab:获取免费模型 → 勾选 → 一键写入配置。
// 后端 = node half 的 zenModels remote(斜杠 RPC 通道,POST /api/zenModels/<method>,
// 与官方 pluginInventory 同一协议)。写回走官方 settings 服务(schema 校验 +
// yaml 持久化 + 变更广播),配置卡即时刷新,无需重启。
// 打包为 closure-factory bundle(dist/client.js),经 package.json 的
// dsh.client 声明被 host 自动注入;依赖全部走 loader module table,零自持依赖。

import { createElement as h, useCallback, useEffect, useState } from "react";

const LOCALE_NS = "llm-opencode-zen-ui";

//#region RPC 通道
async function rpc(method: string, args = {}) {
  const body = {
    type: "client-request",
    rpcId: crypto.randomUUID(),
    method: `zenModels/${method}`,
    payload: { args },
  };
  const res = await fetch(`/api/zenModels/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`请求失败 (HTTP ${res.status})${text ? ": " + text.slice(0, 160) : ""}`);
  }
  const env = await res.json();
  if (!env.result) throw new Error("响应格式异常");
  if (!env.result.ok) throw new Error(env.result.error?.message ?? "调用失败");
  return env.result.value;
}
//#endregion

//#region 样式(沿用 schema-card 的 CSS 变量内联方案)
const panelStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
} as const;
const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
} as const;
const listStyle = {
  display: "flex",
  flexDirection: "column",
  border: "1px solid var(--border-strong, rgba(255,255,255,0.14))",
  borderRadius: 8,
  overflow: "auto",
  maxHeight: 320,
} as const;
const itemStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "7px 12px",
  borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
  cursor: "pointer",
} as const;
const idStyle = {
  fontSize: 13,
  color: "var(--text, #e8eaed)",
  fontFamily: "monospace",
} as const;
const metaStyle = {
  fontSize: 11,
  color: "var(--text-secondary, #8a8f98)",
  marginLeft: "auto",
  whiteSpace: "nowrap",
} as const;
const buttonStyle = {
  background: "var(--primary, #4f8cff)",
  border: "none",
  borderRadius: 6,
  color: "#fff",
  fontSize: 13,
  padding: "7px 14px",
  cursor: "pointer",
} as const;
const ghostButtonStyle = {
  ...buttonStyle,
  background: "transparent",
  border: "1px solid var(--border-strong, rgba(255,255,255,0.2))",
  color: "var(--text, #e8eaed)",
} as const;
const noteStyle = {
  fontSize: 12,
  color: "var(--text-secondary, #8a8f98)",
} as const;
const errorStyle = {
  fontSize: 12,
  color: "var(--danger, #ff6b6b)",
  whiteSpace: "pre-wrap",
} as const;
const okStyle = {
  fontSize: 12,
  color: "var(--success, #4ade80)",
} as const;
//#endregion

function formatTokens(n: any) {
  if (n === void 0 || n === null) return "?";
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

export function ZenModelsTab() {
  const [models, setModels] = useState<any[]>([]);
  const [checked, setChecked] = useState<any>({});
  const [mode, setMode] = useState<any>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [okNote, setOkNote] = useState<string>("");

  const fetchList = useCallback(async () => {
    setBusy(true);
    setError("");
    setOkNote("");
    try {
      const result = await rpc("listFree");
      setModels(result.models ?? []);
      setMode(result.catalogMode ?? null);
      const all = {};
      for (const m of result.models ?? []) (all as any)[m.id] = true;
      setChecked(all);
      if ((result.models ?? []).length === 0)
        setError("目录为空:免费模型拉取失败或网络不可用,可检查后重试");
    } catch (e) {
      setError(String((e as any)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);

  const apply = useCallback(async () => {
    const picked = models.filter((m) => checked[m.id]);
    if (picked.length === 0) { setError("请至少勾选一个模型"); return; }
    setBusy(true);
    setError("");
    setOkNote("");
    try {
      const result = await rpc("applyFree", { models: picked });
      setOkNote(`已写入 ${result.applied} 个免费模型到配置(catalog=custom),配置卡已刷新`);
      setMode("custom");
    } catch (e) {
      setError(String((e as any)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [models, checked]);

  const checkedCount = models.filter((m) => checked[m.id]).length;

  return h("div", { style: panelStyle },
    h("div", { style: rowStyle },
      h("button", { style: ghostButtonStyle, onClick: fetchList, disabled: busy },
        busy ? "获取中…" : "↻ 获取免费模型"),
      h("button", { style: buttonStyle, onClick: apply, disabled: busy || models.length === 0 },
        `应用选中的 ${checkedCount} 个到配置`),
      mode !== null && h("span", { style: noteStyle },
        mode === "custom"
          ? "当前:custom(固定列表)"
          : "当前:auto(自动跟随免费目录)"),
    ),
    okNote && h("div", { style: okStyle }, "✓ " + okNote),
    error && h("div", { style: errorStyle }, error),
    models.length > 0 && h("div", { style: listStyle },
      models.map((m) =>
        h("label", { key: m.id, style: itemStyle },
          h("input", {
            type: "checkbox",
            checked: checked[m.id] === true,
            onChange: (ev) => setChecked((prev: any) => ({ ...prev, [m.id]: ev.target.checked })),
          }),
          h("span", { style: idStyle }, m.id),
          m.deprecated && h("span", { style: noteStyle }, "deprecated"),
          h("span", { style: metaStyle },
            [m.name, `ctx ${formatTokens(m.contextWindow)}`, `out ${formatTokens(m.maxTokens)}`]
              .filter(Boolean).join(" · ")),
        )),
    ),
    models.length === 0 && !error && h("div", { style: noteStyle }, "尚未获取到模型目录"),
    h("div", { style: noteStyle },
      "「应用」会把勾选的免费模型写入 settings.yaml(catalog=custom);恢复自动跟随请在下方配置卡把 catalog 改回 auto。"),
  );
}

// browser cordis 插件:注入 locale + 设置弹窗顶级分区「OpenCode Zen 免费模型」
// (与官方「模型」「插件」同级的 settings.section slot,左侧导航直接可见)
export const inject = ["slots", "locale"];

export function apply(ctx: any) {
  ctx.effect(
    () =>
      ctx.locale.register(LOCALE_NS, {
        zh: { section: "OpenCode Zen 模型" },
        en: { section: "OpenCode Zen Models" },
      }),
    "llm-opencode-zen.ui.locale",
  );

  const t = ctx.locale.bind(LOCALE_NS);
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "zen-models",
        order: 15,
        label: () => t("section"),
        locale: LOCALE_NS,
        inject: () => ({}),
      },
      ZenModelsTab,
    ),
  );
}
