/**
 * HTTP 桥接通道 —— 设备经 userscript 的 GM_xmlhttpRequest 接入
 *
 * 解决的问题：强 CSP 页面声明 connect-src 时，页面上下文里的 WebSocket 和
 * fetch 都会被拦。油猴的 GM_xmlhttpRequest 走扩展特权通道，不受页面 CSP
 * 约束 —— userscript 承担传输层，SDK 与 userscript 之间用 window.postMessage。
 *
 * 协议（server 侧三个端点）：
 * - POST /ws/device-bridge/register  建立会话：body 携带首批上行消息（含 register），
 *   返回 { bridgeId, token, downlink }（downlink = 建立 SSE 前已产生的下行消息）
 * - POST /ws/device-bridge/uplink    批量上行：body { messages: 原始 JSON 串数组 }
 * - GET  /ws/device-bridge/stream    SSE 下行流（text/event-stream，每条消息一个 data 帧）
 *
 * 会话生命周期：SSE 断开或超时无活动 → 销毁会话并走 registry 宽限期下线；
 * userscript 检测到 stream 断开/404 后重新 register（SDK 保持稳定 deviceId，无缝续接）。
 */

import type { HttpResponse } from "uWebSockets.js";
import type { Ctx } from "./uws/http-helpers.js";
import { readBody, sendJson, onAborted } from "./uws/http-helpers.js";
import type { DeviceRegistry } from "./device-registry.js";
import type { DeviceConn } from "./device-conn.js";
import { DeviceChannel, type DeviceChannelDeps } from "./device-channel.js";
import type { AuthContext } from "./auth.js";

/** SSE 断开后会话保留时长（ms）：userscript 重连窗口，超时无活动才销毁 */
const BRIDGE_IDLE_MS = 30_000;

/** 下行积压上限（bytes）：SSE 慢消费者超过即销毁会话（背压保护，对齐 WS 路径） */
const MAX_PENDING = 1024 * 1024;

/** 心跳间隔（ms）：SSE 注释帧，保持代理不掐空闲连接 + 判活 */
const HEARTBEAT_MS = 15_000;

/** 生成随机十六进制串（会话 id / token） */
function randomId(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 销毁会话（模块级前向声明，实现见 setupBridge 内） */
let destroySession: (session: BridgeSession | undefined) => void;

/** 桥接会话完整状态 */
interface BridgeSession {
  id: string;
  token: string;
  conn: BridgeConn;
  channel: DeviceChannel;
  /** SSE 消费者（null = 流未接入，下行进 pendingDownlink） */
  sse: { res: HttpResponse; pendingBytes: number } | null;
  /** SSE 未接入时的下行暂存（register/uplink 响应带回） */
  pendingDownlink: string[];
  /** 下行积压字节数（背压检测，对齐 WS 的 bufferedAmount 语义） */
  pendingBytesDownlink: number;
  /** 最后活动时间（uplink / SSE 写入 / 心跳刷新） */
  lastActivity: number;
  /** 销毁标记：BridgeConn.send 据此 no-op */
  closed: boolean;
}

/** 桥接连接：DeviceConn 的 HTTP 实现，send → SSE 帧或暂存队列 */
class BridgeConn implements DeviceConn {
  static readonly OPEN = 1;
  readonly OPEN = BridgeConn.OPEN;
  closed = false;

  constructor(private readonly getSession: () => BridgeSession | undefined) {}

  get readyState(): number {
    return this.closed ? 3 : 1;
  }

  get bufferedAmount(): number {
    return this.getSession()?.pendingBytesDownlink ?? 0;
  }

  send(text: string): number {
    const s = this.getSession();
    if (!s || s.closed) return 0;
    if (s.sse) {
      const frame = `data: ${text}\n\n`;
      let written = false;
      const sse = s.sse;
      sse.res.cork(() => {
        written = sse.res.write(frame);
      });
      if (!written) {
        /** uWS 内核缓冲满：计数积压，超限销毁会话（慢消费者保护） */
        sse.pendingBytes += frame.length;
        s.pendingBytesDownlink = sse.pendingBytes;
        if (sse.pendingBytes > MAX_PENDING) destroySession(s);
      }
      s.lastActivity = Date.now();
      return 1;
    }
    s.pendingDownlink.push(text);
    return 1;
  }

  end(): void {
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    destroySession(this.getSession());
  }
}

/** 鉴权依赖（与 ws-relay 同构） */
export interface BridgeAuth {
  authorizeWsConnection: (url: string, wsPath: string) => AuthContext;
  isAuthEnabled: () => boolean;
}

export function setupBridge(deps: {
  registry: DeviceRegistry;
  broadcast: DeviceChannelDeps["broadcast"];
  notifyDeviceListChanged: () => void;
  auth: BridgeAuth;
}) {
  const { registry } = deps;
  /** bridgeId → 会话 */
  const sessions = new Map<string, BridgeSession>();

  /** 销毁会话：断 SSE + registry 宽限期下线 + 移除映射（幂等） */
  destroySession = function (session) {
    if (!session || !sessions.has(session.id)) return;
    sessions.delete(session.id);
    session.closed = true;
    session.conn.closed = true;
    if (session.sse) {
      const res = session.sse.res;
      session.sse = null;
      try {
        res.end();
      } catch {
        /** 客户端已断开，uWS 抛错忽略 */
      }
    }
    /** 最后一条连接断开 → registry 5s 宽限期后真正下线（重连窗口内无缝续接） */
    session.channel.onClosed();
  };

  /** SSE 断开（onAborted / 心跳写失败）：保留会话等 userscript 重新 register */
  function detachSse(session: BridgeSession) {
    if (!session.sse) return;
    session.sse = null;
    session.pendingBytesDownlink = 0;
    session.lastActivity = Date.now();
  }

  /** 周期任务：SSE 心跳 + 空闲会话清理 */
  setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (session.sse) {
        /** 心跳注释帧（SSE 规范：冒号开头为注释，客户端忽略）；
         *  连接已死时 uWS 可能抛错 —— 抛错即断开，摘除 SSE 靠空闲超时销毁会话 */
        try {
          const res = session.sse.res;
          res.cork(() => {
            res.write(`: hb\n\n`);
          });
          session.lastActivity = now;
        } catch {
          detachSse(session);
        }
        continue;
      }
      if (now - session.lastActivity > BRIDGE_IDLE_MS) destroySession(session);
    }
  }, HEARTBEAT_MS);

  /** 从 query 校验会话，失败返回 undefined（调用方回 404 触发 userscript 重新 register） */
  function verify(ctx: Ctx): BridgeSession | undefined {
    const id = ctx.parsedUrl.searchParams.get("bridgeId") ?? "";
    const token = ctx.parsedUrl.searchParams.get("token") ?? "";
    const session = sessions.get(id);
    if (!session || session.token !== token) return undefined;
    session.lastActivity = Date.now();
    return session;
  }

  /** 取走暂存的下行消息并清空（SSE 未接入时的降级通道） */
  function drainDownlink(session: BridgeSession): string[] {
    const downlink = session.pendingDownlink;
    session.pendingDownlink = [];
    return downlink;
  }

  /**
   * 桥接路由主入口（index.ts 的 app.any 里调用）
   * 返回 true 表示该请求已被桥接通道处理
   */
  async function handleBridgeRoute(ctx: Ctx): Promise<boolean> {
    const pathname = ctx.parsedUrl.pathname;
    if (!pathname.startsWith("/ws/device-bridge/")) return false;
    const action = pathname.slice("/ws/device-bridge/".length);

    /** ---------- register：建立会话 ---------- */
    if (action === "register" && ctx.method === "POST") {
      const authCtx = deps.auth.authorizeWsConnection(ctx.url, "/ws/device");
      if (authCtx.role === "anonymous") {
        sendJson(ctx, { error: "未授权" }, 401);
        return true;
      }
      const { body, oversize } = await readBody(ctx);
      if (oversize) {
        sendJson(ctx, { error: "body 超过 2MB 上限" }, 413);
        return true;
      }
      if (ctx.aborted) return true;

      let parsed: { sessionToken?: string; messages?: string[] };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        sendJson(ctx, { error: "bad json" }, 400);
        return true;
      }

      const session: BridgeSession = {
        id: "",
        token: "",
        conn: undefined as never,
        channel: undefined as never,
        sse: null,
        pendingDownlink: [],
        pendingBytesDownlink: 0,
        lastActivity: Date.now(),
        closed: false,
      };
      session.conn = new BridgeConn(() => sessions.get(session.id));
      session.channel = new DeviceChannel(session.conn, {
        registry,
        broadcast: deps.broadcast,
        notifyDeviceListChanged: deps.notifyDeviceListChanged,
        resolveProjectId: () => (authCtx.role === "project" ? authCtx.projectId : undefined),
      });
      session.id = randomId(12);
      session.token = randomId(16);
      sessions.set(session.id, session);

      /** 首批上行消息（必须含 register；后续消息顺带处理，减少往返） */
      for (const raw of parsed.messages ?? []) {
        if (session.closed) break;
        session.channel.handleRaw(raw);
      }
      if (session.closed) {
        sendJson(ctx, { error: "session closed" }, 500);
        return true;
      }
      sendJson(ctx, {
        bridgeId: session.id,
        token: session.token,
        downlink: drainDownlink(session),
      });
      return true;
    }

    /** ---------- uplink：批量上行 ---------- */
    if (action === "uplink" && ctx.method === "POST") {
      const session = verify(ctx);
      if (!session) {
        sendJson(ctx, { error: "session-expired" }, 404);
        return true;
      }
      const { body, oversize } = await readBody(ctx);
      if (oversize) {
        sendJson(ctx, { error: "body 超过 2MB 上限" }, 413);
        return true;
      }
      if (ctx.aborted) return true;
      let parsed: { messages?: string[] };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        sendJson(ctx, { error: "bad json" }, 400);
        return true;
      }
      for (const raw of parsed.messages ?? []) {
        if (session.closed) break;
        session.channel.handleRaw(raw);
      }
      /** SSE 已接入时下行走流，响应不带 downlink；未接入时降级捎带 */
      sendJson(ctx, session.sse ? { ok: true } : { ok: true, downlink: drainDownlink(session) });
      return true;
    }

    /** ---------- stream：SSE 下行 ---------- */
    if (action === "stream" && ctx.method === "GET") {
      const session = verify(ctx);
      if (!session) {
        sendJson(ctx, { error: "session-expired" }, 404);
        return true;
      }
      const res = ctx.res;
      ctx.responded = true;
      onAborted(ctx, () => {
        if (session.sse?.res === res) detachSse(session);
      });
      res.cork(() => {
        res.writeStatus("200 OK");
        res.writeHeader("Content-Type", "text/event-stream");
        res.writeHeader("Cache-Control", "no-cache");
        res.writeHeader("Access-Control-Allow-Origin", "*");
        res.write(`retry: 3000\n\n`);
      });
      session.sse = { res, pendingBytes: 0 };
      session.lastActivity = Date.now();
      /** 冲刷 SSE 接入前暂存的下行（含 register 阶段产生的消息） */
      const backlog = drainDownlink(session);
      res.cork(() => {
        for (const text of backlog) {
          res.write(`data: ${text}\n\n`);
        }
      });
      /** onDrain：内核缓冲清空，重置积压计数 */
      res.onDrain(() => {
        if (session.sse) {
          session.sse.pendingBytes = 0;
          session.pendingBytesDownlink = 0;
        }
      });
      return true;
    }

    sendJson(ctx, { error: "Not found" }, 404);
    return true;
  }

  /** 存活会话数（health 观测用） */
  function sessionCount(): number {
    return sessions.size;
  }

  return { handleBridgeRoute, sessionCount };
}
