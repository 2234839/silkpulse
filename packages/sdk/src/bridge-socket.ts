/**
 * BridgeSocket —— 经 userscript 宿主（GM_xmlhttpRequest）连接 server 的传输层
 *
 * 场景：强 CSP 页面声明 connect-src 时，页面上下文的 WebSocket 被拦。
 * userscript 在扩展特权上下文里用 GM_xmlhttpRequest 承载与 server 的通信，
 * 本类只负责与宿主之间的 window.postMessage 转发。
 *
 * 握手协议：
 * - page → host: { __silkpulsePage: true, cmd: "init" | "send" | "close", msgs?: string[] }
 * - host → page: { __silkpulseHost: true, event: "open" | "down" | "close", data?: string }
 *   open = 宿主已在 server 建好桥接会话（首批上行含 register 后触发）
 *
 * 事件处理器接口与 ws-client 的 DeviceSocket 对齐（onopen/onmessage/onclose/onerror）。
 */

import type { DeviceSocket } from "./ws-client.js";

/** page → host 消息标记 */
const PAGE_FLAG = "__silkpulsePage";
/** host → page 消息标记 */
const HOST_FLAG = "__silkpulseHost";

export class BridgeSocket implements DeviceSocket {
  static readonly OPEN = 1;
  readonly OPEN = BridgeSocket.OPEN;
  /** 0 = 等宿主建会话，1 = 会话就绪，3 = 已关闭 */
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  /** 会话未就绪期间的标记位（缓冲统一由 ws-client 的 sendQueue 负责） */
  private readonly listener = (ev: MessageEvent) => {
    const d = ev.data as { [HOST_FLAG]?: true; event?: string; data?: string } | undefined | null;
    if (!d || d[HOST_FLAG] !== true) return;
    if (d.event === "open") {
      this.readyState = 1;
      this.onopen?.();
      return;
    }
    if (d.event === "down" && typeof d.data === "string") {
      if (this.readyState === 1) this.onmessage?.({ data: d.data });
      return;
    }
    if (d.event === "close") {
      /** 宿主会话失效（SSE 断开/404）：走标准 onclose → ws-client 指数退避重连 */
      this.readyState = 3;
      window.removeEventListener("message", this.listener);
      this.onclose?.();
    }
  };

  constructor() {
    window.addEventListener("message", this.listener);
    this.post({ cmd: "init" });
  }

  send(data: string): void {
    if (this.readyState === 1) {
      this.post({ cmd: "send", msgs: [data] });
    }
    /** readyState=0 期间的缓冲由 ws-client 的 sendQueue 统一负责，这里不重复缓冲 */
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    window.removeEventListener("message", this.listener);
    this.post({ cmd: "close" });
  }

  private post(msg: Record<string, unknown>) {
    window.postMessage({ [PAGE_FLAG]: true, ...msg }, window.location.origin);
  }
}
