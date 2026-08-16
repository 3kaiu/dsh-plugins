// runtime client: REST 回放 + WS 订阅 + 断线重连(协议见 docs/09 §1-2)
export interface Envelope {
  seq: number;
  schema: number;
  eventId: string;
  family: "session" | "tool" | "error" | "test" | "completion";
  type: string;
  at: string;
  sessionId?: string;
  source: string;
  data: Record<string, unknown>;
}

const SEQ_KEY = "dsh-console.seq";
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`;
const REST = "/api/events";

export function savedSeq(): number {
  return Number(localStorage.getItem(SEQ_KEY)) || 0;
}

export async function backfill(since: number, families?: string[]): Promise<{ seq: number; events: Envelope[] }> {
  const q = new URLSearchParams({ since: String(since) });
  if (families && families.length) q.set("families", families.join(","));
  const res = await fetch(`${REST}?${q}`);
  if (!res.ok) throw new Error("backfill failed");
  return res.json();
}

export function connectWs(
  onEvent: (e: Envelope) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      retry = 0;
      onStatus(true);
      ws!.send(JSON.stringify({ op: "subscribe", families: ["session", "tool", "error", "test", "completion"] }));
    };
    ws.onmessage = (m) => {
      let msg: any;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.op === "event") {
        onEvent(msg.event as Envelope);
        localStorage.setItem(SEQ_KEY, String(msg.event.seq));
      } else if (msg.op === "hello") {
        // 服务端已补推,无需额外动作
      } else if (msg.op === "pong") {
        // 心跳响应,无需处理
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (closed) return;
      retry += 1;
      setTimeout(open, Math.min(1000 * 2 ** retry, 15000));
    };
    ws.onerror = () => { try { ws?.close(); } catch {} };
  };

  open();
  return () => { closed = true; try { ws?.close(); } catch {} };
}
