// 基础组件:Card/Drawer/ProgressBar/StatusDot/Tag/EmptyState(见 docs/10 §3)
import { ComponentChildren } from "preact";

export function Card({ title, extra, children }: { title?: string; extra?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="card">
      {title !== undefined && (
        <header class="card-head">
          <h3>{title}</h3>
          {extra}
        </header>
      )}
      <div class="card-body">{children}</div>
    </section>
  );
}

export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ComponentChildren }) {
  if (!open) return null;
  return (
    <div class="drawer-mask" onClick={onClose}>
      <aside class="drawer" onClick={(e) => e.stopPropagation()}>
        <header class="drawer-head">
          <h3>{title}</h3>
          <button class="btn-ghost" onClick={onClose}>✕</button>
        </header>
        <div class="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export function ProgressBar({ value, max = 100, tone }: { value: number; max?: number; tone?: "ok" | "warn" | "bad" }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div class="progress" role="progressbar" aria-valuenow={pct}>
      <div class={"progress-fill" + (tone ? " tone-" + tone : "")} style={{ width: pct + "%" }} />
    </div>
  );
}

export function StatusDot({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span class={"dot" + (ok ? " dot-ok" : " dot-bad")} title={label ?? (ok ? "已连接" : "未连接")} />
  );
}

const TONE_CLASS: Record<string, string> = { LOW: "tag-low", MEDIUM: "tag-med", HIGH: "tag-high", CRITICAL: "tag-crit" };
export function Tag({ text, tone }: { text: string; tone?: string }) {
  return <span class={"tag" + (tone ? " " + (TONE_CLASS[tone] ?? "") : "")}>{text}</span>;
}

export function EmptyState({ text }: { text: string }) {
  return <div class="empty">{text}</div>;
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-CN", { hour12: false }) + " " + d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
