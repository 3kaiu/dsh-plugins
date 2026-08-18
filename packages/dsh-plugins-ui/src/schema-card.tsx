// Schema 驱动的插件配置卡:解析 dsh-settings 描述符里的 serialized schemastery
// 图(uid/refs),对每个顶层字段渲染控件,经 SettingsScope.set/unset 写回。
// 支持:string/number/boolean/const/union(枚举)/object(嵌套)/array(JSON 编辑);
// secret 字段(describe redactSecrets 剥离)渲染为密码框,不回显。

import { createElement as h, useCallback, useEffect, useMemo, useState } from "react";

//#region 类型(与 dsh-settings 描述符 / SettingsScope 契约对齐,宽松声明)
interface SchemaNode {
  type: string;
  meta?: Record<string, unknown>;
  value?: unknown;
  list?: number[];
  dict?: Record<string, number>;
  inner?: number;
}
interface SerializedSchema {
  uid: number;
  refs: Record<string, SchemaNode>;
}
interface Snapshot {
  status: "loading" | "ready" | "unavailable";
  value: unknown;
  base: unknown;
  user: unknown;
  revision: number | undefined;
  writable: boolean;
  mode: "host" | "memory";
}
interface Scope {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
  unset(field: string): Promise<void>;
}
interface Descriptor {
  ns: string;
  schema: SerializedSchema;
  value: unknown;
  revision: number;
  base?: unknown;
  user?: unknown;
  applies: "live" | "restart";
  secrets?: { path: string[] }[];
}
interface DescribeResult {
  result: { ok: boolean; value?: { namespaces: Descriptor[] }; message?: string };
}
//#endregion

const deepEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hasOwn = (o: unknown, k: string) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const valueAt = (o: unknown, k: string) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  margin: "6px 0",
} as const;
const labelStyle = {
  width: 200,
  flex: "0 0 200px",
  fontSize: 12,
  color: "var(--text-secondary, #8a8f98)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;
const inputStyle = {
  flex: 1,
  minWidth: 0,
  background: "var(--background-2, rgba(255,255,255,0.06))",
  border: "1px solid var(--border-strong, rgba(255,255,255,0.14))",
  borderRadius: 6,
  color: "var(--text, #e8eaed)",
  fontSize: 13,
  padding: "4px 8px",
} as const;
const badgeStyle = {
  fontSize: 10,
  color: "var(--warning, #e5c07b)",
  whiteSpace: "nowrap",
} as const;

/** 单个字段行:label + 控件 + 覆盖标记 */
function FieldRow(props: {
  name: string;
  node: SchemaNode;
  refs: Record<string, SchemaNode>;
  value: unknown;
  base: unknown;
  overridden: boolean;
  secret: boolean;
  disabled: boolean;
  onEdit(next: unknown): void;
}) {
  const { name, node, refs, value, base, overridden, secret, disabled, onEdit } = props;
  let control: unknown;
  switch (node.type) {
    case "boolean":
      control = h("input", {
        type: "checkbox",
        checked: !!value,
        disabled,
        onChange: (e: { target: { checked: boolean } }) => onEdit(e.target.checked),
        style: { accentColor: "var(--primary, #4f8cff)", width: 16, height: 16 },
      });
      break;
    case "number":
      control = h("input", {
        type: "number",
        value: value === undefined || value === null ? "" : String(value),
        disabled,
        style: inputStyle,
        onChange: (e: { target: { value: string } }) => {
          const text = e.target.value;
          if (text === "") { onEdit(undefined); return; }
          const n = Number(text);
          if (Number.isFinite(n)) onEdit(n);
        },
      });
      break;
    case "string":
      control = secret
        ? h("input", {
            type: "password",
            value: "",
            placeholder: value === undefined ? "" : "已设置(留空保持不变)",
            disabled,
            style: inputStyle,
            onChange: () => {},
            onBlur: (e: { target: { value: string } }) => {
              const text = e.target.value;
              if (text.length > 0) onEdit(text);
            },
          })
        : h("input", {
            type: "text",
            value: value === undefined || value === null ? "" : String(value),
            disabled,
            style: inputStyle,
            onChange: (e: { target: { value: string } }) => onEdit(e.target.value),
          });
      break;
    case "const":
      control = h("code", { style: { fontSize: 12, color: "var(--text-secondary, #8a8f98)" } }, JSON.stringify(node.value));
      break;
    case "union": {
      const options = (node.list ?? [])
        .map((uid) => refs[String(uid)])
        .filter((r) => r && r.type === "const")
        .map((r) => r.value);
      control = h(
        "select",
        {
          value: value === undefined || value === null ? "" : String(value),
          disabled,
          style: inputStyle,
          onChange: (e: { target: { value: string } }) => onEdit(e.target.value),
        },
        options.map((o) => h("option", { key: String(o), value: String(o) }, String(o))),
      );
      break;
    }
    case "array":
      control = h("textarea", {
        rows: 3,
        value: value === undefined ? "" : JSON.stringify(value, null, 1),
        disabled,
        spellcheck: false,
        style: { ...inputStyle, fontFamily: "monospace", fontSize: 12, resize: "vertical" },
        onChange: (e: { target: { value: string } }) => {
          try {
            onEdit(JSON.parse(e.target.value));
          } catch {
            // 解析失败:保留旧值
          }
        },
      });
      break;
    case "object":
      control = h(SchemaFields, {
        refs,
        uid: node,
        value,
        base,
        disabled,
        onEdit: (next: unknown) => onEdit(next),
      });
      break;
    default:
      control = h("span", { style: { fontSize: 12, color: "var(--text-secondary, #8a8f98)" } }, node.type);
  }
  return h(
    "div",
    { style: rowStyle },
    h("span", { style: labelStyle, title: name }, name),
    control,
    overridden ? h("span", { style: badgeStyle }, "已覆盖") : null,
  );
}

/** object 节点的子字段集合(嵌套分组;嵌套层不显示覆盖标记) */
function SchemaFields(props: {
  refs: Record<string, SchemaNode>;
  uid: SchemaNode;
  value: unknown;
  base: unknown;
  disabled: boolean;
  onEdit(next: unknown): void;
}) {
  const { refs, uid, value, base, disabled, onEdit } = props;
  const entries = Object.entries(uid.dict ?? {});
  return h(
    "div",
    { style: { flex: 1, minWidth: 0 } },
    entries.map(([key, childUid]) => {
      const child = refs[String(childUid)];
      if (!child) return null;
      const childValue = valueAt(value, key);
      const childBase = valueAt(base, key);
      return h(FieldRow, {
        key: key,
        name: key,
        node: child,
        refs,
        value: childValue,
        base: childBase,
        overridden: false,
        secret: false,
        disabled,
        onEdit: (next) => {
          const nextObj = { ...(value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}), [key]: next };
          onEdit(nextObj);
        },
      });
    }),
  );
}

/** 卡外壳:描述符加载 + 编辑草稿 + 保存/丢弃(与官方 PluginCard 交互对齐) */
export function SchemaCard(props: { useCard?: (sel: (s: Snapshot) => Snapshot) => Snapshot; spec?: { ns: string; title: string; description: string }; scope?: Scope; describeAll?(): Promise<DescribeResult> }) {
  const [desc, setDesc] = useState<Descriptor | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const snap = props.useCard?.((s) => s) ?? { status: "loading" as const, value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: "host" as const };
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.describeAll) return;
    let alive = true;
    props.describeAll().then((res) => {
      if (!alive || !res.result.ok || !res.result.value) return;
      const found = res.result.value.namespaces.find((d) => d.ns === props.spec?.ns);
      if (found) setDesc(found);
    }).catch((e: unknown) => {
      if (alive) setLoadError(String((e as Error)?.message ?? e));
    });
    return () => { alive = false; };
  }, [props.describeAll, props.spec?.ns]);

  const value = snap.value as Record<string, unknown> | undefined;
  const base = snap.base as Record<string, unknown> | undefined;
  const user = snap.user as Record<string, unknown> | undefined;
  const secrets = new Set((desc?.secrets ?? []).map((s) => s.path[0]).filter(Boolean));

  const changed = useMemo(
    () => Object.keys(draft).filter((k) => !deepEqual(draft[k], valueAt(value, k))),
    [draft, value],
  );

  const edit = useCallback(
    (field: string, next: unknown) => {
      setDraft((d) => ({ ...d, [field]: next }));
    },
    [],
  );

  const save = useCallback(async () => {
    if (!props.scope || changed.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      for (const k of changed) {
        const next = draft[k];
        const secret = secrets.has(k);
        if (secret && next === "") continue; // 密码框留空 = 保持不变
        const isReset = deepEqual(next, valueAt(base, k));
        if (isReset && hasOwn(user, k)) {
          await props.scope.unset(k);
        } else {
          await props.scope.set(k, next);
        }
      }
      setDraft({});
    } catch (e) {
      setSaveError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  }, [props.scope, changed, draft, base, user, secrets]);

  const discard = useCallback(() => setDraft({}), []);

  const refs = desc?.schema?.refs ?? {};
  const root = desc?.schema ? refs[String(desc.schema.uid)] : null;

  return h(
    "div",
    { style: { padding: "10px 2px" } },
    h(
      "div",
      { style: { fontSize: 13, fontWeight: 600, color: "var(--text, #e8eaed)", marginBottom: 2 } },
      props.spec?.title ?? "插件配置",
    ),
    h(
      "div",
      { style: { fontSize: 11, color: "var(--text-secondary, #8a8f98)", marginBottom: 8 } },
      props.spec?.description ?? "",
      desc?.applies === "restart" ? h("span", { style: badgeStyle }, " 重启后生效") : null,
    ),
    loadError ? h("div", { style: { fontSize: 12, color: "var(--danger, #e06c75)", margin: "6px 0" } }, "加载失败: " + loadError) : null,
    snap.status === "unavailable"
      ? h("div", { style: { fontSize: 12, color: "var(--text-secondary, #8a8f98)", margin: "6px 0" } }, "该命名空间未接入设置服务。")
      : root
        ? h(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            Object.entries(root.dict ?? {}).map(([key, childUid]) => {
              const child = refs[String(childUid)];
              if (!child) return null;
              return h(FieldRow, {
                key: key,
                name: key,
                node: child,
                refs,
                value: valueAt(value, key),
                base: valueAt(base, key),
                overridden: hasOwn(user, key),
                secret: secrets.has(key),
                disabled: saving || !snap.writable,
                onEdit: (next: unknown) => edit(key, next),
              });
            }),
          )
        : null,
    h(
      "div",
      { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 8 } },
      h(
        "button",
        {
          onClick: () => void save(),
          disabled: !snap.writable || changed.length === 0 || saving,
          style: {
            background: "var(--primary, #4f8cff)",
            border: "none",
            borderRadius: 6,
            color: "#fff",
            fontSize: 12,
            padding: "4px 14px",
            cursor: snap.writable && changed.length > 0 && !saving ? "pointer" : "default",
            opacity: !snap.writable || changed.length === 0 || saving ? 0.5 : 1,
          },
        },
        saving ? "保存中…" : "保存",
      ),
      h(
        "button",
        {
          onClick: discard,
          disabled: changed.length === 0 || saving,
          style: {
            background: "transparent",
            border: "1px solid var(--border-strong, rgba(255,255,255,0.14))",
            borderRadius: 6,
            color: "var(--text-secondary, #8a8f98)",
            fontSize: 12,
            padding: "4px 14px",
            cursor: changed.length > 0 && !saving ? "pointer" : "default",
            opacity: changed.length === 0 || saving ? 0.5 : 1,
          },
        },
        "丢弃",
      ),
      changed.length > 0 ? h("span", { style: badgeStyle }, changed.length + " 项待保存") : null,
      saveError ? h("span", { style: { fontSize: 12, color: "var(--danger, #e06c75)" } }, saveError) : null,
      !snap.writable ? h("span", { style: { fontSize: 11, color: "var(--text-secondary, #8a8f98)" } }, "只读(设置文档不可写)") : null,
    ),
  );
}
