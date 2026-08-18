// Console「插件配置」面板:schema 驱动配置卡(移植自 dsh-plugins-ui/schema-card)
// 数据源 = Console 代理 API(GET /api/settings/sections, POST /api/settings/update)。
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Card } from "./basic";

interface SchemaNode {
  type: string;
  value?: unknown;
  list?: number[];
  dict?: Record<string, number>;
}
interface Section {
  ns: string;
  schema: { uid: number; refs: Record<string, SchemaNode> };
  value: unknown;
  base?: unknown;
  user?: unknown;
  applies: "live" | "restart";
}
export const PLUGIN_NS = ["harness-updater", "github-sync", "runtime-events", "dsh-console"];

const deepEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hasOwn = (o: unknown, k: string) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const valueAt = (o: unknown, k: string) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);

const rowStyle = { display: "flex", alignItems: "center", gap: 8, margin: "6px 0" };
const labelStyle = { width: 180, flex: "0 0 180px", fontSize: 12, color: "var(--text-secondary, #8a8f98)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const };
const inputStyle = { flex: 1, minWidth: 0, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 6, color: "var(--text, #e8eaed)", fontSize: 13, padding: "4px 8px" };
const badgeStyle = { fontSize: 10, color: "var(--warning, #e5c07b)", whiteSpace: "nowrap" as const };

function FieldRow(props: { name: string; node: SchemaNode; refs: Record<string, SchemaNode>; value: unknown; overridden: boolean; secret: boolean; disabled: boolean; onEdit(next: unknown): void }) {
  const { name, node, refs, value, overridden, secret, disabled, onEdit } = props;
  let control: unknown;
  switch (node.type) {
    case "boolean":
      control = h("input", { type: "checkbox", checked: !!value, disabled, style: { accentColor: "#4f8cff", width: 16, height: 16 }, onChange: (e: { target: { checked: boolean } }) => onEdit(e.target.checked) });
      break;
    case "number":
      control = h("input", { type: "number", value: value === undefined || value === null ? "" : String(value), disabled, style: inputStyle, onChange: (e: { target: { value: string } }) => { const t = e.target.value; if (t === "") { onEdit(undefined); return; } const n = Number(t); if (Number.isFinite(n)) onEdit(n); } });
      break;
    case "string":
      control = secret
        ? h("input", { type: "password", value: "", placeholder: value === undefined ? "" : "已设置(留空保持不变)", disabled, style: inputStyle, onChange: () => {}, onBlur: (e: { target: { value: string } }) => { if (e.target.value.length > 0) onEdit(e.target.value); } })
        : h("input", { type: "text", value: value === undefined || value === null ? "" : String(value), disabled, style: inputStyle, onChange: (e: { target: { value: string } }) => onEdit(e.target.value) });
      break;
    case "const":
      control = h("code", { style: { fontSize: 12, color: "var(--text-secondary, #8a8f98)" } }, JSON.stringify(node.value));
      break;
    case "union": {
      const options = (node.list ?? []).map((uid) => refs[String(uid)]).filter((r) => r && r.type === "const").map((r) => r.value);
      control = h("select", { value: value === undefined || value === null ? "" : String(value), disabled, style: inputStyle, onChange: (e: { target: { value: string } }) => onEdit(e.target.value) }, options.map((o) => h("option", { key: String(o), value: String(o) }, String(o))));
      break;
    }
    case "array":
      control = h("textarea", { rows: 3, value: value === undefined ? "" : JSON.stringify(value, null, 1), disabled, spellcheck: false, style: { ...inputStyle, fontFamily: "monospace", fontSize: 12, resize: "vertical" }, onChange: (e: { target: { value: string } }) => { try { onEdit(JSON.parse(e.target.value)); } catch {} } });
      break;
    case "object":
      control = h(SchemaFields, { refs, uid: node, value, disabled, onEdit: (next: unknown) => onEdit(next) });
      break;
    default:
      control = h("span", { style: { fontSize: 12, color: "var(--text-secondary, #8a8f98)" } }, node.type);
  }
  return h("div", { style: rowStyle }, h("span", { style: labelStyle, title: name }, name), control, overridden ? h("span", { style: badgeStyle }, "已覆盖") : null);
}

function SchemaFields(props: { refs: Record<string, SchemaNode>; uid: SchemaNode; value: unknown; disabled: boolean; onEdit(next: unknown): void }) {
  const { refs, uid, value, disabled, onEdit } = props;
  return h("div", { style: { flex: 1, minWidth: 0 } }, Object.entries(uid.dict ?? {}).map(([key, childUid]) => {
    const child = refs[String(childUid)];
    if (!child) return null;
    return h(FieldRow, {
      key, name: key, node: child, refs, value: valueAt(value, key), overridden: false, secret: false, disabled,
      onEdit: (next: unknown) => onEdit({ ...(value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}), [key]: next }),
    });
  }));
}

const NS_TITLES: Record<string, string> = {
  "harness-updater": "运行时更新",
  "github-sync": "GitHub 同步",
  "runtime-events": "运行时事件",
  "dsh-console": "事件控制台",
};

function SectionCard(props: { section: Section }) {
  const { section } = props;
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const refs = section.schema.refs;
  const root = refs[String(section.schema.uid)];
  const value = section.value as Record<string, unknown> | undefined;
  const user = section.user as Record<string, unknown> | undefined;
  const changed = Object.keys(draft).filter((k) => !deepEqual(draft[k], valueAt(value, k)));

  const save = async () => {
    if (changed.length === 0) return;
    setSaving(true); setError(null);
    const ops: { op: "set" | "unset"; path: string[]; value?: unknown }[] = [];
    for (const k of changed) {
      const next = draft[k];
      if (deepEqual(next, valueAt(section.base, k)) && hasOwn(user, k)) ops.push({ op: "unset", path: [k] });
      else ops.push({ op: "set", path: [k], value: next });
    }
    try {
      const res = await fetch("/api/settings/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ns: section.ns, ops }) });
      const json = await res.json();
      if (!json.ok) { setError(json.reason ?? "保存失败"); return; }
      setDraft({}); setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return h(
    Card,
    { title: (NS_TITLES[section.ns] ?? section.ns) + (section.applies === "restart" ? " · 重启后生效" : "") },
    root
      ? h("div", null, Object.entries(root.dict ?? {}).map(([key, childUid]) => {
          const child = refs[String(childUid)];
          if (!child) return null;
          return h(FieldRow, { key, name: key, node: child, refs, value: valueAt(value, key), overridden: hasOwn(user, key), secret: false, disabled: saving, onEdit: (next: unknown) => setDraft((d) => ({ ...d, [key]: next })) });
        }))
      : null,
    h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 10 } },
      h("button", { class: "btn", disabled: saving || changed.length === 0, onClick: () => void save() }, "保存"),
      h("button", { class: "btn ghost", disabled: saving || changed.length === 0, onClick: () => setDraft({}) }, "丢弃"),
      changed.length > 0 ? h("span", { style: badgeStyle }, changed.length + " 项待保存") : null,
      saved ? h("span", { class: "dim" }, "已保存,立即生效") : null,
      error ? h("span", { style: { fontSize: 12, color: "var(--danger, #e06c75)" } }, error) : null,
    ),
  );
}

/** 插件配置面板:加载 4 个插件 ns 的 schema 并逐张渲染配置卡。 */
export function PluginSettings() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/settings/sections?ns=" + PLUGIN_NS.join(","))
      .then((r) => r.json())
      .then((json) => {
        if (!alive) return;
        if (!json.ok) { setError(json.reason ?? "加载失败"); return; }
        setSections(json.sections ?? []);
      })
      .catch((e: unknown) => { if (alive) setError(String((e as Error)?.message ?? e)); });
    return () => { alive = false; };
  }, []);
  return h("div", null,
    h("div", { class: "dim", style: { marginBottom: 12 } }, "各插件的运行参数。保存立即生效(重启生效项已标注)。"),
    error ? h("div", { style: { fontSize: 12, color: "var(--danger, #e06c75)", marginBottom: 10 } }, "加载失败: " + error) : null,
    sections === null
      ? h("div", { class: "dim" }, "加载中…")
      : sections.map((s) => h(SectionCard, { key: s.ns, section: s })),
  );
}