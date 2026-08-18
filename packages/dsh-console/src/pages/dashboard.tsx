import { Card, StatusDot, ProgressBar, EmptyState, fmtTime, Tag } from "../components/basic";
import { useEffect, useState } from "preact/hooks";
import { runningSessions, sessions, failures, events } from "../stores/events";
import { health } from "../stores/health";

function renderMd(md: string) {
  // 极简 markdown 渲染(早报格式:# / ## / - / --- / 文本)
  return md.split("\\n").map((line, i) => {
    if (line.startsWith("# ")) return <h2 key={i} style="margin:4px 0 6px">{line.slice(2)}</h2>;
    if (line.startsWith("## ")) return <h3 key={i} style="margin:8px 0 4px">{line.slice(3)}</h3>;
    if (line.startsWith("- ")) return <div key={i} class="list-item" style="padding:2px 0"><span>{line.slice(2)}</span></div>;
    if (line.startsWith("---")) return <hr key={i} style="margin:6px 0;border:none;border-top:1px solid var(--border,#ddd)" />;
    if (!line.trim()) return <div key={i} style="height:4px" />;
    return <div key={i} class="dim">{line}</div>;
  });
}

export function Dashboard() {
  const running = runningSessions.value;
  const total = sessions.value.length;
  const failCount = failures.value.reduce((n, f) => n + f.count, 0);
  const todayToolCalls = events.value.filter((e) => e.type === "tool.started").length;
  const h = health.value;
  const [morning, setMorning] = useState<null | string>(null);
  const [morningNote, setMorningNote] = useState("加载早报…");
  const loadMorning = () => {
    setMorning(null);
    setMorningNote("加载早报…");
    fetch("/api/morning-report").then((res) => res.json()).then((j) => {
      if (j.ok) { setMorning(j.markdown); setMorningNote("生成于 " + (j.generatedAt ?? "").slice(0, 19).replace("T", " ")); }
      else { setMorning(null); setMorningNote(j.reason ?? "早报不可用"); }
    }).catch(() => { setMorning(null); setMorningNote("早报接口不可用"); });
  };
  useEffect(() => { loadMorning(); }, []);
  const [upd, setUpd] = useState<null | { installed: string; latest: string | null; updateAvailable: boolean; lastCheckAt: string | null }>(null);
  useEffect(() => {
    fetch("/api/dsh-update").then((res) => res.json()).then((j) => { if (j && j.ok) setUpd(j); }).catch(() => {});
  }, []);
  return (
    <div>
      <h1 style="margin-bottom:14px">工作台总览</h1>
      {upd && (
        <div style="margin-bottom:14px">
          <Card title="dsh 版本">
            {upd.updateAvailable ? (
              <div class="list-item">
                <span style="color:var(--warn,#ffd166);font-weight:600">新版本 {upd.latest} 可用</span>
                <span class="dim">已装 {upd.installed} · 重跑安装脚本(install.sh)升级</span>
              </div>
            ) : (
              <div class="dim">已是最新 {upd.installed}{upd.latest ? `(registry ${upd.latest})` : ""} · 检查于 {fmtTime(upd.lastCheckAt)}</div>
            )}
          </Card>
        </div>
      )}
      <div style="margin-bottom:14px">
        <Card title="维护早报" extra={<button onClick={loadMorning} style="font-size:12px;padding:2px 8px;cursor:pointer">刷新</button>}>
          {morning ? <div>{renderMd(morning)}<div class="dim" style="margin-top:6px">{morningNote}</div></div> : <EmptyState text={morningNote} />}
        </Card>
      </div>
      <div class="row" style="margin-bottom:14px">
        <Card title="运行中会话">
          {running.length === 0 ? <EmptyState text="暂无运行中会话" /> : running.map((s) => (
            <div class="list-item">
              <StatusDot ok />
              <div style="flex:1">
                <div>{s.title}</div>
                <div class="dim">{s.model || "model 未知"} · 工具调用 {s.tools} 次 · 轮次 {s.turns}</div>
              </div>
            </div>
          ))}
        </Card>
        <Card title="今日快照">
          <div class="grid2">
            <div><div class="stat">{total}</div><div class="dim">会话总数</div></div>
            <div><div class="stat">{todayToolCalls}</div><div class="dim">工具调用</div></div>
            <div><div class="stat">{failCount}</div><div class="dim">失败事件</div></div>
            <div><div class="stat">{h?.count ?? "—"}</div><div class="dim">事件库条数</div></div>
          </div>
        </Card>
      </div>
      <div class="row">
        <Card title="健康条" extra={<Tag text={h?.server ?? "离线"} tone={h ? "low" : "high"} />}>
          {h ? (
            <div class="grid2">
              <div><div class="dim">事件库目录</div><div class="mono">{h.eventsDir}</div></div>
              <div><div class="dim">最新 seq</div><div class="stat" style="font-size:16px">{h.seq}</div></div>
            </div>
          ) : <EmptyState text="等待 /api/health/summary…" />}
        </Card>
        <Card title="最新活动">
          <div class="feed">
            {events.value.slice(-8).reverse().map((e) => (
              <div class="list-item">
                <Tag text={e.type} />
                <span class="dim mono">{fmtTime(e.at)}</span>
              </div>
            ))}
            {events.value.length === 0 && <EmptyState text="尚无事件,等待运行时产生" />}
          </div>
        </Card>
      </div>
    </div>
  );
}
