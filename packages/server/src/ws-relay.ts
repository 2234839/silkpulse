/**
 * WebSocket 路由 —— 处理 device / console 两类 WS 连接
 *
 * 路径约定：
 * - /ws/device          设备端连接（SDK），双向：上报采集数据 + 接收 exec 指令
 * - /ws/console         控制台连接，双向：订阅设备 + 接收实时数据
 *
 * 设备上报的数据：
 *   1. 存入 registry 的环形缓冲区（HTTP API 用）
 *   2. 转发给所有订阅了该设备的控制台
 */

import type { WebSocketBehavior } from "uWebSockets.js";
import type { DeviceRegistry } from "./device-registry.js";
import type { AuthContext } from "./auth.js";
import { SilkWs, getSilk, type WsUserData } from "./uws/ws-socket.js";
import { DeviceChannel } from "./device-channel.js";
import { trackConsoleSession } from "./stats-reporter.js";
import type { ServerToConsoleMessage, ConsoleMessage } from "@silkpulse/shared";

/** 广播可观测性：发送/截断计数，供 health 端点读取，压测用 */
export const fanoutStats = { sent: 0, skippedClosed: 0, skippedProject: 0, backpressureClosed: 0 };

/**
 * 创建并挂载 WebSocket 服务到 HTTP server
 * 返回 notifyDeviceListChanged，供 HTTP API（如 tags 修改）触发控制台刷新
 */
export function setupWebSocket(
  registry: DeviceRegistry,
  auth: {
    authorizeWsConnection: (url: string, wsPath: string) => AuthContext;
    isAuthEnabled: () => boolean;
  },
  /** 静态资产代理（强 CSP 设备经通道拉取 server 资产用），不传则设备请求返回错误 */
  readAsset?: (pathname: string) => string,
): {
  behavior: WebSocketBehavior<WsUserData>;
  notifyDeviceListChanged: () => void;
  broadcast: (deviceId: string, msg: ServerToConsoleMessage) => void;
} {
  /** 每个 WS 设备连接对应的业务通道（设备端）；控制台端为订阅集合 */
  const deviceChannels = new Map<SilkWs, DeviceChannel>();
  /** 控制台连接 → 会话结束回调（close 时调用，供旁路统计上报会话时长） */
  const closeCallbacks = new Map<SilkWs, () => void>();
  /** 控制台订阅：consoleWs → Set<deviceId>，以及反向映射 device → Set<consoleWs> */
  const consoleSubscriptions = new Map<SilkWs, Set<string>>();
  const deviceWatchers = new Map<string, Set<SilkWs>>();

  /** 向所有订阅了某设备的控制台广播消息 */
  /**
   * 单连接背压上限（bytes）
   *
   * 控制台客户端网络慢（VPN/弱网）时，ws.send 持续往内核缓冲区塞数据，
   * bufferedAmount 无限膨胀会拖垮 server 内存。超过此阈值判定连接已积压，
   * 丢弃后续消息并强制关闭该连接，保护 server 和其他客户端。
   * 1MB 约等于数千条日志的体积，正常订阅远不会触顶。
   */
  const MAX_BUFFERED = 1024 * 1024;

  function broadcast(deviceId: string, msg: ServerToConsoleMessage) {
    const watchers = deviceWatchers.get(deviceId);
    if (!watchers) return;
    /** 获取设备所属项目，用于控制台权限过滤 */
    const targetDevice = registry.get(deviceId);
    const deviceProjectId = targetDevice?.info.projectId;
    const text = JSON.stringify(msg);
    for (const ws of watchers) {
      if (ws.readyState !== ws.OPEN) {
        fanoutStats.skippedClosed++;
        continue;
      }
      /** 项目隔离：项目级控制台只能收到自己项目设备的数据 */
      const ctx = ws.authCtx;
      if (ctx?.role === "project" && ctx.projectId !== deviceProjectId) {
        fanoutStats.skippedProject++;
        continue;
      }
      /** 背压保护：积压超限的连接直接关闭，不再塞数据 */
      if (ws.bufferedAmount > MAX_BUFFERED) {
        fanoutStats.backpressureClosed++;
        ws.end(1011, "backpressure: send buffer overflow");
        continue;
      }
      /** close 后 send 自动 no-op（竞态安全，close 回调统一清理死连接） */
      ws.send(text);
      fanoutStats.sent++;
    }
  }

  /**
   * 每个控制台连接的 watcher 偏好（面板级按需采集）
   *
   * key = 控制台 ws，value = 该控制台当前观看的设备 + 启用的 watcher 集合。
   * 控制台切换面板时发 set-watchers 更新此偏好。
   */
  const consoleWatcherPrefs = new Map<SilkWs, { deviceId: string; watchers: Set<string> }>();

  /**
   * 汇总某设备所有订阅控制台的 watcher 偏好，取并集
   *
   * 多个控制台可能同时看不同面板（一个看 Storage，一个看 Element），
   * 设备端需要启用所有控制台请求的 watcher 的并集。
   */
  function mergeDeviceWatchers(deviceId: string): string[] {
    const merged = new Set<string>();
    for (const [, pref] of consoleWatcherPrefs) {
      if (pref.deviceId === deviceId) {
        for (const w of pref.watchers) merged.add(w);
      }
    }
    return [...merged];
  }

  /** 取消某控制台对所有设备的订阅 */
  function unsubscribeAll(ws: SilkWs) {
    const subs = consoleSubscriptions.get(ws);
    if (!subs) return;
    for (const deviceId of subs) {
      const watchers = deviceWatchers.get(deviceId);
      if (watchers) {
        watchers.delete(ws);
        if (watchers.size === 0) deviceWatchers.delete(deviceId);
      }
    }
    consoleSubscriptions.delete(ws);
    /** 清理 watcher 偏好，并通知设备端更新（可能需要关闭某些 watcher） */
    const pref = consoleWatcherPrefs.get(ws);
    consoleWatcherPrefs.delete(ws);
    if (pref) {
      const merged = mergeDeviceWatchers(pref.deviceId);
      const device = registry.get(pref.deviceId);
      const sock = device?.latestSocket;
      if (sock && sock.readyState === sock.OPEN) {
        sock.send(JSON.stringify({ type: "set-watchers", watchers: merged }));
      }
    }
  }

  /**
   * uWS WebSocket 行为定义（设备/控制台共用，靠 open 时的 url 区分）
   *
   * idleTimeout=32 + sendPingsAutomatically：协议层心跳（等价旧版 30s ping 循环，
   * 浏览器自动回 pong 刷新 idle 计时，脏断开 32s 内被强制清理）。
   * maxBackpressure=1MB：uWS 原生背压上限，超限直接断慢消费者。
   */
  const behavior: WebSocketBehavior<WsUserData> = {
    idleTimeout: 32,
    sendPingsAutomatically: true,
    maxBackpressure: MAX_BUFFERED,
    maxPayloadLength: 4 * 1024 * 1024,

    open: (ws) => {
      const silk = getSilk(ws);
      handleOpen(silk);
    },
    message: (ws, message) => {
      const silk = getSilk(ws);
      /** uWS message 是 ArrayBuffer（回调返回后被 neuter），立刻转字符串 */
      let raw: string;
      try {
        raw = Buffer.from(message).toString();
      } catch {
        return;
      }
      handleMessage(silk, raw);
    },
    close: (ws) => {
      const silk = getSilk(ws);
      silk.closed = true;
      /** 摘除连接：还有其他活连接（多标签页）则设备仍在线；
       *  最后一条断开走宽限期（reload 窗口内重连无缝续接，不丢历史缓冲） */
      const closeUrl = new URL(getUrlFromSocket(silk), "http://localhost");
      if (closeUrl.pathname === "/ws/device") {
        const channel = deviceChannels.get(silk);
        if (channel) {
          channel.onClosed();
          deviceChannels.delete(silk);
        }
      }
      if (closeUrl.pathname === "/ws/console") {
        closeCallbacks.get(silk)?.();
        closeCallbacks.delete(silk);
        unsubscribeAll(silk);
      }
    },
  };

  /** ---------- 连接生命周期处理 ---------- */
  function handleOpen(silk: SilkWs) {
    const url = new URL(getUrlFromSocket(silk), "http://localhost");
    const pathname = url.pathname;

    /** ---------- 设备端连接 ---------- */
    if (pathname === "/ws/device") {
      deviceChannels.set(
        silk,
        new DeviceChannel(silk, {
          registry,
          broadcast,
          notifyDeviceListChanged,
          resolveProjectId: () =>
            silk.authCtx.role === "project" ? silk.authCtx.projectId : undefined,
          readAsset,
        }),
      );
    }

    /** ---------- 控制台连接 ---------- */
    if (pathname === "/ws/console") {
      consoleSubscriptions.set(silk, new Set());

      /** 控制台连上后立即推送当前设备列表（按项目过滤） */
      const consoleProjectId = silk.authCtx.role === "project" ? silk.authCtx.projectId : undefined;
      silk.send(
        JSON.stringify({
          type: "device-list",
          devices: registry.listByProject(consoleProjectId),
        } satisfies ServerToConsoleMessage),
      );
      /** 旁路统计：控制台会话开始；用户身份用 projectId（项目密钥持有者，稳定不随刷新变化），超管记为 admin（未知 projectId 的设备控制台也归入） */
      const authUser =
        silk.authCtx.role === "project"
          ? (silk.authCtx.projectId ?? "anonymous")
          : silk.authCtx.role === "admin"
            ? "admin"
            : "anonymous";
      const endConsoleSession = trackConsoleSession(authUser);
      closeCallbacks.set(silk, endConsoleSession);
    }
  }

  function handleMessage(silk: SilkWs, raw: string): void {
    const url = new URL(getUrlFromSocket(silk), "http://localhost");
    const pathname = url.pathname;

    /** ---------- 设备端消息 ---------- */
    if (pathname === "/ws/device") {
      deviceChannels.get(silk)?.handleRaw(raw);
      return;
    }

    /** ---------- 控制台消息 ---------- */

    if (pathname === "/ws/console") {
      {
        let msg: ConsoleMessage;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }

        /**
         * 指令鉴权守卫：携带 deviceId 的控制台→设备指令（subscribe/exec/screen-share 等）
         * 必须通过项目隔离检查——项目级控制台只能操作自己项目的设备，
         * 未分组设备（projectId=undefined）仅超管可操作。
         * 列表推送（broadcast/notifyDeviceListChanged）已过滤，但指令路径
         * 是控制台主动发起，不拦的话项目密钥可对任何设备发指令（越权）。
         */
        const msgWithDeviceId = msg as { deviceId?: string };
        if (msgWithDeviceId.deviceId) {
          const targetDevice = registry.get(msgWithDeviceId.deviceId);
          const devicePid = targetDevice?.info.projectId;
          const ctx = silk.authCtx;
          if (ctx?.role === "project" && ctx.projectId !== devicePid) {
            /** 越权：目标设备不属于本控制台的项目（含未分组）——忽略指令 */
            return;
          }
        }
        const ws = silk;
        switch (msg.type) {
          case "subscribe": {
            const subs = consoleSubscriptions.get(ws)!;
            subs.add(msg.deviceId);
            let watchers = deviceWatchers.get(msg.deviceId);
            if (!watchers) {
              watchers = new Set();
              deviceWatchers.set(msg.deviceId, watchers);
            }
            watchers.add(ws);
            break;
          }
          case "unsubscribe": {
            const subs = consoleSubscriptions.get(ws);
            if (!subs) break;
            subs.delete(msg.deviceId);
            const watchers = deviceWatchers.get(msg.deviceId);
            watchers?.delete(ws);
            break;
          }
          case "set-watchers": {
            /** 控制台通知当前打开的面板，server 汇总所有控制台的 watcher 后下发合并结果 */
            consoleWatcherPrefs.set(ws, {
              deviceId: msg.deviceId,
              watchers: new Set(msg.watchers),
            });
            /** 重新计算该设备的 watcher 并集 */
            const merged = mergeDeviceWatchers(msg.deviceId);
            const device = registry.get(msg.deviceId);
            const sock = device?.latestSocket;
            if (sock && sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify({ type: "set-watchers", watchers: merged }));
            }
            break;
          }
          case "ping": {
            /** 应用层心跳响应（浏览器 WebSocket 无法发 ping 帧） */
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "pong" } satisfies ServerToConsoleMessage));
            }
            break;
          }
          case "start-screen-share": {
            /** 控制台请求设备开始屏幕共享（用户侧弹出授权弹窗） */
            const device = registry.get(msg.deviceId);
            const sock = device?.latestSocket;
            if (sock && sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify({ type: "start-screen-share" }));
            }
            break;
          }
          case "stop-screen-share": {
            /** 控制台请求设备停止屏幕共享 */
            const device = registry.get(msg.deviceId);
            const sock = device?.latestSocket;
            if (sock && sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify({ type: "stop-screen-share" }));
            }
            break;
          }
          case "get-network-body": {
            /** 控制台请求完整 body（懒加载），转发给设备 */
            const device = registry.get(msg.deviceId);
            const sock = device?.latestSocket;
            if (sock && sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify({ type: "get-network-body", bodySeq: msg.bodySeq }));
            }
            break;
          }
          case "devtools-relay": {
            /** 控制台 devtools client 的 RPC 消息，透传给对应设备（发 latestSocket：指令类消息单点送达） */
            const device = registry.get(msg.deviceId);
            const sock = device?.latestSocket;
            if (sock && sock.readyState === sock.OPEN) {
              sock.send(
                JSON.stringify({
                  type: "devtools-relay",
                  plugin: msg.plugin,
                  payload: msg.payload,
                }),
              );
            }
            break;
          }
        }
      }
    }
  }

  /** 设备列表变化时推送给所有控制台（按项目隔离） */
  function notifyDeviceListChanged() {
    for (const ws of consoleSubscriptions.keys()) {
      if (ws.readyState !== ws.OPEN) continue;
      /** 每个控制台只收到它有权访问的设备列表 */
      const ctx = ws.authCtx;
      const pid = ctx?.role === "project" ? ctx.projectId : undefined;
      const msg: ServerToConsoleMessage = {
        type: "device-list",
        devices: registry.listByProject(pid),
      };
      /** close 后 send 自动 no-op（与 broadcast 保持一致） */
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * registry 事件 → 控制台推送
   *
   * 主要补宽限期超时下线路径：detachSocket 的 setTimeout 里 unregister
   * 不经过 ws-relay 的 close 回调，没有这里订阅的话设备列表会出现幽灵设备。
   */
  registry.onChange((event) => {
    if (event.type === "offline") {
      notifyDeviceListChanged();
      return;
    }
    if (event.type === "reconnect") {
      /** 页面 reload 重连：通知所有订阅该设备的控制台重载 devtools 面板（重新握手 backend） */
      broadcast(event.device.id, {
        type: "device-reconnect",
        deviceId: event.device.id,
      });
    }
  });

  return { behavior, notifyDeviceListChanged, broadcast };
}

/**
 * 从 SilkWs 取连接时的完整 URL
 *
 * uWS 不在 open 回调里直接给 URL —— upgrade 阶段把 URL 存进 UserData（见 index.ts），
 * 这里读出来解析路径。
 */
export function getUrlFromSocket(silk: SilkWs): string {
  return socketUrls.get(silk) ?? "/";
}

/** SilkWs → 连接 URL（upgrade 阶段由 index.ts 注册） */
const socketUrls = new WeakMap<SilkWs, string>();

/** 注册连接 URL（upgrade 阶段调用，open 回调前） */
export function registerSocketUrl(silk: SilkWs, url: string): void {
  socketUrls.set(silk, url);
}
