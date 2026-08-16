// DSH Console 入口:hash 路由 + 事件流引导(REST 回放 → WS 订阅)
import { render } from "preact";
import { signal } from "@preact/signals";
import { backfill, connectWs, savedSeq } from "./runtime/client";
import { events, connected, ingest, lastSyncAt, resetStores } from "./stores/events";
import { startHealthPolling } from "./stores/health";
import { StatusDot } from "./components/basic";
import { Dashboard } from "./pages/dashboard";
import { Sessions } from "./pages/sessions";
import { Tasks } from "./pages/tasks";
import { Failures } from "./pages/failures";
import { Health } from "./pages/health";
import { Maintenance } from "./pages/maintenance";
import { Settings } from "./pages/settings";
import "./styles.css";

const route = signal(location.hash.slice(1) || "dashboard");
window.addEventListener("hashchange", () => (route.value = location.hash.slice(1) || "dashboard"));

const ROUTES: Record<string, () => preact.JSX.Element> = {
  dashboard: Dashboard, sessions: Sessions, tasks: Tasks, failures: Failures,
  health: Health, maintenance: Maintenance, settings: Settings,
};

function refresh() {
  const since = savedSeq();
  backfill(since).then((r) => {
    ingest(r.events);
    localStorage.setItem("dsh-console.seq", String(r.seq));
  }).catch(() => {});
}

// 引导:回放 → 订阅增量
resetStores();
refresh();
connectWs((e) => ingest([e]), (ok) => (connected.value = ok));
startHealthPolling(30000);

export function App() {
  const current = route.value in ROUTES ? route.value : "dashboard";
  const Page = ROUTES[current];
  return (
    <div>
      <header class="topbar">
        <span class="brand">DSH Console</span>
        <StatusDot ok={connected.value} label={connected.value ? "事件流已连接" : "事件流断开"} />
        <span class="dim" style="font-size:12px">{lastSyncAt.value ? "同步于 " + lastSyncAt.value.slice(11, 19) : "未同步"}</span>
        <span class="spacer" />
        <button class="btn-ghost" onClick={refresh}>刷新</button>
        <a class="btn" href="http://127.0.0.1:3080" target="_blank" rel="noreferrer">打开 Harness →</a>
      </header>
      <div class="layout">
        <nav class="sidebar">
          {Object.keys(ROUTES).map((r) => (
            <a href={"#" + r} class={current === r ? "active" : ""}>{r === "dashboard" ? "总览" : r}</a>
          ))}
        </nav>
        <main class="main"><Page /></main>
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
