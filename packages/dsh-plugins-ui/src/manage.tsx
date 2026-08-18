// @3kaiu/dsh-plugins-ui —— 设置弹窗「插件 → 管理」tab
// 浏览器侧管理界面:安装(快捷名 / tarball 地址 / 本地路径)、卸载、升级、
// 重启 dsh web。全部调用走 node half 的 PluginManager remote(斜杠 RPC 通道,
// POST /api/pluginManager/<method>,与官方 pluginInventory 同一协议),不依赖
// connection.api 的静态方法表。样式沿用 schema-card 的 CSS 变量内联方案。

import { createElement as h, useCallback, useEffect, useMemo, useState } from "react";

//#region RPC 通道
async function rpc<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const body = {
    type: "client-request",
    rpcId: crypto.randomUUID(),
    method: `pluginManager/${method}`,
    payload: { args },
  };
  const res = await fetch(`/api/pluginManager/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`请求失败 (HTTP ${res.status})${text ? ": " + text.slice(0, 160) : ""}`);
  }
  const env = (await res.json()) as {
    result?: { ok: boolean; value?: T; error?: { code: string; message: string } };
  };
  if (!env.result) throw new Error("响应格式异常");
  if (!env.result.ok) throw new Error(env.result.error?.message ?? "调用失败");
  return env.result.value as T;
}
//#endregion

//#region 类型与样式
interface PluginEntry {
  name: string;
  version: string | null;
  description: string | null;
  bundle: boolean;
  hasBundleDecl: boolean;
}
interface ListSnapshot {
  profile: string;
  dshHome: string;
  bundles: string[];
  plugins: PluginEntry[];
}

const SHORT_NAMES = [
  "llm-opencode-zen",
  "harness-updater",
  "layout-infer",
  "dsh-console",
  "dsh-github-sync",
  "dsh-runtime-events",
  "dsh-plugins-ui",
];

const cardStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
} as const;
const sectionStyle = {
  background: "var(--background-2, rgba(255,255,255,0.04))",
  border: "1px solid var(--border-strong, rgba(255,255,255,0.1))",
  borderRadius: 10,
  padding: "14px 16px",
} as const;
const sectionTitleStyle = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text, #e8eaed)",
  margin: "0 0 8px",
} as const;
const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 0",
  borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
} as const;
const nameStyle = {
  fontSize: 13,
  color: "var(--text, #e8eaed)",
  fontFamily: "monospace",
  flex: "0 0 auto",
} as const;
const versionStyle = {
  fontSize: 11,
  color: "var(--text-secondary, #8a8f98)",
  flex: "0 0 auto",
} as const;
const descStyle = {
  flex: 1,
  minWidth: 0,
  fontSize: 11,
  color: "var(--text-secondary, #8a8f98)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;
const badgeStyle = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 8,
  border: "1px solid var(--primary, #4f8cff)",
  color: "var(--primary, #4f8cff)",
  flex: "0 0 auto",
} as const;
const inputStyle = {
  flex: 1,
  minWidth: 0,
  background: "var(--background-2, rgba(255,255,255,0.06))",
  border: "1px solid var(--border-strong, rgba(255,255,255,0.14))",
  borderRadius: 6,
  color: "var(--text, #e8eaed)",
  fontSize: 13,
  padding: "6px 10px",
} as const;
const buttonStyle = {
  background: "var(--primary, #4f8cff)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 12,
  padding: "6px 14px",
  cursor: "pointer",
  flex: "0 0 auto",
} as const;
const ghostButtonStyle = {
  background: "transparent",
  color: "var(--text-secondary, #8a8f98)",
  border: "1px solid var(--border-strong, rgba(255,255,255,0.14))",
  borderRadius: 6,
  fontSize: 11,
  padding: "3px 10px",
  cursor: "pointer",
  flex: "0 0 auto",
} as const;
const dangerButtonStyle = {
  ...ghostButtonStyle,
  color: "var(--danger, #e06c75)",
  borderColor: "var(--danger, #e06c75)",
} as const;
const chipStyle = {
  fontSize: 11,
  color: "var(--primary, #4f8cff)",
  background: "transparent",
  border: "1px dashed var(--border-strong, rgba(255,255,255,0.18))",
  borderRadius: 10,
  padding: "1px 8px",
  cursor: "pointer",
} as const;
const hintStyle = {
  fontSize: 11,
  color: "var(--text-secondary, #8a8f98)",
  lineHeight: 1.5,
} as const;
const errorStyle = {
  fontSize: 12,
  color: "var(--danger, #e06c75)",
  background: "rgba(224,108,117,0.08)",
  border: "1px solid rgba(224,108,117,0.3)",
  borderRadius: 6,
  padding: "8px 10px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
} as const;
const okStyle = {
  fontSize: 12,
  color: "var(--success, #98c379)",
  background: "rgba(152,195,121,0.08)",
  border: "1px solid rgba(152,195,121,0.3)",
  borderRadius: 6,
  padding: "8px 10px",
} as const;
//#endregion

/** 单行插件:名称 + 版本 + 描述 + bundle 徽标 + 更新/卸载 */
function PluginRow(props: {
  plugin: PluginEntry;
  busy: boolean;
  onUpdate(): void;
  onUninstall(): void;
}) {
  const { plugin, busy, onUpdate, onUninstall } = props;
  return h(
    "div",
    { style: rowStyle },
    h("span", { style: nameStyle, title: plugin.name }, plugin.name),
    plugin.bundle
      ? h("span", { style: badgeStyle }, "bundle")
      : plugin.hasBundleDecl
        ? h("span", { style: { ...badgeStyle, borderColor: "var(--warning, #e5c07b)", color: "var(--warning, #e5c07b)" } }, "patch")
        : null,
    h("span", { style: versionStyle }, plugin.version ?? "?"),
    h("span", { style: descStyle }, plugin.description ?? ""),
    h(
      "button",
      { style: ghostButtonStyle, disabled: busy, onClick: onUpdate, title: "升级到最新版本" },
      "升级",
    ),
    h(
      "button",
      { style: dangerButtonStyle, disabled: busy, onClick: onUninstall, title: "卸载并移除 bundle 声明" },
      "卸载",
    ),
  );
}

/** 插件管理面板(注册为 settings.plugins.tab 条目 id=manage) */
export function ManageTab(_props: unknown) {
  const [snapshot, setSnapshot] = useState<ListSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [spec, setSpec] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await rpc<ListSnapshot>("list"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (label: string, method: string, args: Record<string, unknown>) => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        const value = await rpc<{ note?: string; output?: string; bundles?: string[] }>(method, args);
        setNotice(
          (value.note ? value.note + "。\n" : "") +
            (value.bundles ? "bundles: " + value.bundles.length + " 项\n" : "") +
            (value.output ? value.output.trim().slice(-200) : ""),
        );
        setSpec("");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const restart = useCallback(async () => {
    setBusy("restart");
    setError(null);
    setNotice(null);
    try {
      await rpc<{ childPid: number; selfPid: number }>("restart");
      setNotice("正在重启 dsh web… 页面会短暂断开,几秒后刷新即可。");
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }, []);

  const uninstall = useCallback(
    (name: string) => {
      if (confirming !== name) {
        setConfirming(name);
        return;
      }
      setConfirming(null);
      void run("uninstall", "uninstall", { pkg: name });
    },
    [confirming, run],
  );

  const names = useMemo(
    () =>
      (snapshot?.plugins ?? [])
        .filter((p) => p.name.startsWith("@3kaiu/"))
        .map((p) => p.name),
    [snapshot],
  );

  return h(
    "div",
    { style: cardStyle },
    // 安装
    h(
      "div",
      { style: sectionStyle },
      h("p", { style: sectionTitleStyle }, "安装插件"),
      h(
        "div",
        { style: { display: "flex", gap: 8 } },
        h("input", {
          style: inputStyle,
          placeholder: "快捷名、GitHub .tgz 地址、本地路径或包名",
          value: spec,
          disabled: busy !== null,
          onChange: (e: { target: { value: string } }) => setSpec(e.target.value),
          onKeyDown: (e: { key: string }) => {
            if (e.key === "Enter" && spec.trim()) void run("install", "install", { spec: spec.trim() });
          },
        }),
        h(
          "button",
          {
            style: buttonStyle,
            disabled: busy !== null || !spec.trim(),
            onClick: () => void run("install", "install", { spec: spec.trim() }),
          },
          "安装",
        ),
      ),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 } },
        SHORT_NAMES.map((short) =>
          h(
            "button",
            {
              key: short,
              style: chipStyle,
              disabled: busy !== null,
              onClick: () => setSpec(short),
            },
            short,
          ),
        ),
      ),
      h(
        "p",
        { style: hintStyle },
        "支持 @3kaiu 插件快捷名(下载 GitHub Release tarball 并校验 SHA-256)、任意 https .tgz 地址、file: 本地路径或 npm 包名。安装后需重启 dsh web 生效。",
      ),
    ),
    // 已安装列表
    h(
      "div",
      { style: sectionStyle },
      h("p", { style: sectionTitleStyle }, "已安装插件"),
      loading
        ? h("p", { style: hintStyle }, "加载中…")
        : snapshot
          ? h(
              "div",
              null,
              (snapshot.plugins.length === 0
                ? [h("p", { style: hintStyle }, "没有已安装的插件。")]
                : snapshot.plugins.map((p) =>
                    h(PluginRow, {
                      key: p.name,
                      plugin: p,
                      busy: busy !== null,
                      onUpdate: () => void run("update", "update", { pkg: p.name }),
                      onUninstall: () => uninstall(p.name),
                    }),
                  )),
              h(
                "p",
                { style: { ...hintStyle, marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" } },
                h("span", null, `profile: ${snapshot.profile}`),
                h("span", null, `bundles: ${snapshot.bundles.length}`),
                names.length > 0 ? h("span", null, `@3kaiu: ${names.length}`) : null,
              ),
            )
          : null,
    ),
    // 操作区
    h(
      "div",
      { style: sectionStyle },
      h(
        "div",
        { style: { display: "flex", gap: 8, alignItems: "center" } },
        h("p", { style: { ...sectionTitleStyle, margin: 0, flex: 1 } }, "重启 dsh web"),
        h(
          "button",
          { style: buttonStyle, disabled: busy !== null, onClick: () => void restart() },
          "重启",
        ),
      ),
      h(
        "p",
        { style: hintStyle },
        "安装、卸载、升级需要重启 dsh web 后生效。重启会短暂断开连接,完成后刷新页面即可。",
      ),
    ),
    error ? h("div", { style: errorStyle }, error) : null,
    notice ? h("div", { style: okStyle }, notice) : null,
    confirming
      ? h(
          "p",
          { style: hintStyle },
          `确认卸载 ${confirming}?再次点击「卸载」确认。`,
        )
      : null,
  );
}
