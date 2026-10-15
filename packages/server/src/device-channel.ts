/**
 * 设备通道 —— 单条设备连接的业务消息处理
 *
 * 从 ws-relay 抽出，与传输层解耦：WebSocket 连接和 HTTP 桥接连接（BridgeConn）
 * 共用同一套 DeviceMessage 处理逻辑（register / log / network / error / exec-result ...）。
 *
 * 生命周期：连接建立时创建 → 每条上行消息喂 handleRaw → 连接断开时 onClosed()。
 */

import type { DeviceConn } from "./device-conn.js";
import type { DeviceRegistry, Device } from "./device-registry.js";
import type {
  DeviceMessage,
  ServerToConsoleMessage,
  ServerToDeviceMessage,
  DeviceInfo,
} from "@silkpulse/shared";

/** DeviceChannel 依赖的外部能力（由 ws-relay 提供） */
export interface DeviceChannelDeps {
  registry: DeviceRegistry;
  /** 向所有订阅了某设备的控制台广播消息 */
  broadcast: (deviceId: string, msg: ServerToConsoleMessage) => void;
  /** 设备列表变化时刷新控制台侧边栏 */
  notifyDeviceListChanged: () => void;
  /**
   * 解析设备归属的项目 ID（register 时注入，不由 SDK 决定）
   * WS 路径取连接鉴权上下文，桥接路径取请求 query 的鉴权结果
   */
  resolveProjectId?: () => string | undefined;
  /**
   * 静态资产代理：按 pathname 读 server 静态目录文件文本，读不到抛错。
   * 强 CSP 页面 fetch 不了跨域资产，经已建立的设备通道中转下发。
   */
  readAsset?: (pathname: string) => string;
}

/** 生成设备 ID（8 位十六进制） */
function generateDeviceId(): string {
  return Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export class DeviceChannel {
  /** register 成功后的设备 id（未注册时为空串） */
  deviceId = "";
  /** register 成功后的设备对象 */
  device: Device | undefined;

  constructor(
    private readonly conn: DeviceConn,
    private readonly deps: DeviceChannelDeps,
  ) {}

  /** 喂入一条原始上行消息（JSON 文本），解析失败静默忽略 */
  handleRaw(raw: string): void {
    let msg: DeviceMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    this.handleMessage(msg);
  }

  /** 处理一条已解析的设备上行消息 */
  handleMessage(msg: DeviceMessage): void {
    const { registry, broadcast, notifyDeviceListChanged } = this.deps;
    let { deviceId } = this;
    let { device } = this;

    switch (msg.type) {
      case "register": {
        /** 设备首次注册：分配/复用 id，建立映射 */
        deviceId = msg.device.id || generateDeviceId();
        const info: DeviceInfo = {
          ...msg.device,
          id: deviceId,
          /** projectId 由传输层鉴权阶段决定（WS 鉴权上下文 / 桥接 query），不由 SDK 决定 */
          projectId: this.deps.resolveProjectId?.() ?? msg.device.projectId,
          onlineAt: Date.now(),
          /** 兼容未上报 tags 的旧 SDK */
          tags: msg.device.tags ?? [],
          note: msg.device.note,
        };
        const registered = registry.register(info, this.conn, msg.sessionToken ?? "");
        if (!registered) {
          /** deviceId 已被另一个活着的标签页占用（复制标签页，Web Locks 不可用时的
           *  server 端仲裁）：告知设备换新 id 重连。此连接不再接受消息。 */
          this.conn.send(
            JSON.stringify({
              type: "device-id-conflict",
            } satisfies ServerToDeviceMessage),
          );
          return;
        }
        device = registered;
        this.deviceId = deviceId;
        this.device = device;
        /** 广播设备列表更新给所有控制台（用 register 合并后的最新 info） */
        broadcast(deviceId, {
          type: "device-online",
          device: device.info,
        });
        notifyDeviceListChanged();
        return;
      }
      case "update-info": {
        /** SPA 路由变化：SDK 上报新 url/title/icon，server 更新元信息并通知控制台 */
        if (!device) return;
        registry.updateInfo(deviceId, {
          url: msg.device.url,
          title: msg.device.title,
          icon: msg.device.icon,
          viewportWidth: msg.device.viewportWidth,
          viewportHeight: msg.device.viewportHeight,
          deviceType: msg.device.deviceType,
          /** 框架探测结果（DevTools 面板自动选插件用，SPA 路由变化后可能更新） */
          frameworks: msg.device.frameworks,
        });
        broadcast(deviceId, {
          type: "device-online",
          device: device.info,
        });
        /** 通知所有控制台刷新设备列表（title/icon/url 变化要反映到侧边栏） */
        notifyDeviceListChanged();
        return;
      }
      case "log": {
        if (!device) return;
        registry.appendLog(deviceId, msg.log);
        broadcast(deviceId, { type: "log", deviceId, log: msg.log });
        return;
      }
      case "log-repeat": {
        /**
         * 连续重复日志：最后一条 repeat +1（不发新条目）。
         * SDK 检测到与上一条 type+message 完全相同时不发 log，只发 log-repeat，
         * 避免循环/spam 日志占满环形缓冲区挤掉有价值的诊断日志。
         */
        if (!device) return;
        const last = device.logs.last();
        if (last) {
          last.repeat = (last.repeat ?? 1) + 1;
          broadcast(deviceId, { type: "log-repeat", deviceId });
        }
        return;
      }
      case "network": {
        if (!device) return;
        device.network.push(msg.entry);
        broadcast(deviceId, {
          type: "network",
          deviceId,
          entry: msg.entry,
        });
        return;
      }
      case "network-update": {
        /**
         * 已有 entry 的增量更新（loading→done、流式 body 追加）
         * 按 seq 找到 entry 合并 patch 字段，广播让 console 同步更新
         */
        if (!device) return;
        const existing = device.network.findBySeq(msg.seq);
        if (existing) {
          Object.assign(existing, msg.patch);
          broadcast(deviceId, {
            type: "network-update",
            deviceId,
            seq: msg.seq,
            patch: msg.patch,
          });
        }
        return;
      }
      case "ws-frame": {
        /**
         * WebSocket 帧追加（send/recv/event）：按 seq 找到 WS 连接条目，
         * 追加帧到 frames（上限 50 FIFO），广播让 console 增量更新。
         * 与 log-repeat 同模式：seq 稳定，只发增量，不重发整个 entry。
         */
        if (!device) return;
        const wsEntry = device.network.findBySeq(msg.seq);
        if (wsEntry && wsEntry.protocol === "ws") {
          if (!wsEntry.frames) wsEntry.frames = [];
          wsEntry.frames.push(msg.frame);
          broadcast(deviceId, { type: "ws-frame", deviceId, seq: msg.seq, frame: msg.frame });
        }
        return;
      }
      case "ws-state": {
        /** WebSocket readyState 变化（CONNECTING→OPEN→CLOSING→CLOSED） */
        if (!device) return;
        const wsEntry = device.network.findBySeq(msg.seq);
        if (wsEntry && wsEntry.protocol === "ws") {
          wsEntry.wsState = msg.wsState;
          /** status 字段同步 readyState，列表展示一致 */
          wsEntry.status = msg.wsState;
          broadcast(deviceId, {
            type: "ws-state",
            deviceId,
            seq: msg.seq,
            wsState: msg.wsState,
          });
        }
        return;
      }
      case "sse-event": {
        /**
         * SSE 事件追加：按 seq 找到 SSE 连接条目，追加事件到 events（上限 50 FIFO），
         * 广播让 console 增量更新。与 ws-frame 同模式。
         *
         * 特殊事件 `__closed__` 表示 SSE 流结束（reader done），更新 sseState。
         */
        if (!device) return;
        const sseEntry = device.network.findBySeq(msg.seq);
        if (sseEntry && sseEntry.sseState) {
          if (msg.event.event === "__closed__") {
            sseEntry.sseState = "closed";
          } else {
            if (!sseEntry.events) sseEntry.events = [];
            sseEntry.events.push(msg.event);
          }
          broadcast(deviceId, {
            type: "sse-event",
            deviceId,
            seq: msg.seq,
            event: msg.event,
          });
        }
        return;
      }
      case "error": {
        if (!device) return;
        device.errors.push(msg.error);
        registry.updateInfo(deviceId, {
          errorCount: device.info.errorCount + 1,
        });
        broadcast(deviceId, {
          type: "error",
          deviceId,
          error: msg.error,
        });
        /** 错误数变化会改变设备列表状态（红条/计数），推送更新 */
        notifyDeviceListChanged();
        return;
      }
      case "snapshot": {
        /** 快照不存缓冲区（体积大、时效性强），直接转发给控制台 */
        /** 快照请求通常是 exec 触发的，由 exec-bridge 处理，这里仅转发 */
        return;
      }
      case "screen-frame": {
        /** 屏幕共享帧：直接转发给订阅了该设备的控制台（不存缓冲，体积大时效性强） */
        if (!device) return;
        broadcast(deviceId, { type: "screen-frame", deviceId, frame: msg.frame });
        return;
      }
      case "screen-share-status": {
        /** 屏幕共享状态变化（等待授权/共享中/被拒绝等）：转发给控制台 */
        if (!device) return;
        broadcast(deviceId, { type: "screen-share-status", deviceId, status: msg.status });
        return;
      }
      case "asset-fetch": {
        /** 资产代理：读静态文件后经原通道下发（新旧 userscript 宿主都能透传） */
        if (!device) return;
        if (!this.deps.readAsset) {
          this.conn.send(
            JSON.stringify({
              type: "asset-fetch-res",
              reqId: msg.reqId,
              ok: false,
              error: "server 未启用资产代理",
            }),
          );
          return;
        }
        try {
          const data = this.deps.readAsset(msg.path);
          this.conn.send(
            JSON.stringify({ type: "asset-fetch-res", reqId: msg.reqId, ok: true, data }),
          );
        } catch (err) {
          this.conn.send(
            JSON.stringify({
              type: "asset-fetch-res",
              reqId: msg.reqId,
              ok: false,
              error: String(err),
            }),
          );
        }
        return;
      }
      case "exec-result": {
        if (!device) return;
        const entry = device.pendingExecs.get(msg.execId);
        if (entry) {
          clearTimeout(entry.timer);
          entry.resolve(msg.result);
          device.pendingExecs.delete(msg.execId);
        }
        return;
      }
      case "network-body": {
        /** 设备返回完整 body（懒加载响应），转发给订阅该设备的控制台 */
        if (!device) return;
        broadcast(deviceId, {
          type: "network-body",
          deviceId,
          bodySeq: msg.bodySeq,
          body: msg.body,
        });
        return;
      }
      case "storage-change": {
        /** 远程设备 storage 变化（SDK 劫持 setItem/removeItem 触发），转发给控制台实时刷新 */
        if (!device) return;
        broadcast(deviceId, {
          type: "storage-change",
          deviceId,
          storageType: msg.storageType,
          key: msg.key,
          timestamp: msg.timestamp,
        });
        return;
      }
      case "dom-change": {
        /** 远程设备 DOM 变化（SDK MutationObserver 触发），转发给控制台 Element 面板实时刷新 */
        if (!device) return;
        broadcast(deviceId, {
          type: "dom-change",
          deviceId,
          changes: msg.changes,
        });
        return;
      }
      case "device-mouse": {
        /** 远端设备鼠标/触摸事件，转发给控制台渲染虚拟光标 */
        if (!device) return;
        broadcast(deviceId, {
          type: "device-mouse",
          deviceId,
          mouse: msg.mouse,
        });
        return;
      }
      case "devtools-relay": {
        /** devtools backend RPC 消息（vue/react）：透传给订阅该设备的控制台（不存缓冲，时效性强） */
        if (!device) return;
        broadcast(deviceId, {
          type: "devtools-relay",
          deviceId,
          plugin: msg.plugin,
          payload: msg.payload,
        });
        return;
      }
    }
  }

  /** 连接断开：摘除 registry 中的这条连接（最后一条进宽限期） */
  onClosed(): void {
    if (!this.deviceId) return;
    this.deps.registry.detachSocket(this.deviceId, this.conn);
  }
}
