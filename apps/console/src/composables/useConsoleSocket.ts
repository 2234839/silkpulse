/**
 * useConsoleSocket —— 控制台 WebSocket 连接 hook
 *
 * 连接 /ws/console，订阅设备实时数据：
 * - 设备列表（上线/下线事件）
 * - 选中设备的 log/network/error 实时推送
 */
import { ref, shallowRef, onUnmounted } from "vue";
import type {
  DeviceInfo,
  LogEntry,
  NetworkEntry,
  ErrorEntry,
  ScreenFrame,
  ScreenShareStatus,
  MouseEventData,
  ServerToConsoleMessage,
} from "@silkpulse/shared";
import { useAuth } from "./useAuth";
import { apiFetch } from "../utils/api";

/**
 * 客户端会话缓冲上限（FIFO 淘汰最旧记录）
 *
 * 定位：本设备查看会话的完整时间线，远大于 server 环形缓冲的历史回填窗口
 * （logs 500 / network 300 / errors 100）。正常调试不可能触顶；只有长时间挂机
 * 观察高频页面（60fps 打点、轮询心跳）才会逼近。触顶后批量裁剪而非逐条，摊薄拷贝成本。
 */
const MAX_SESSION_LOGS = 50_000;
/** 网络条目带 frames/events/body 引用，单条占用远大于日志，上限收紧 */
const MAX_SESSION_NETWORK = 10_000;
/** 页面错误低频产生，保留更多时间线 */
const MAX_SESSION_ERRORS = 5_000;
/** 单个 WS 连接的帧 / SSE 连接的事件上限（网络面板查看详情用，超限淘汰最旧） */
const MAX_SESSION_FRAMES = 2_000;
/** 裁剪滞后量：超过上限 + 此值才触发一次裁剪，避免逐条 slice 的 O(n) 抖动 */
const TRIM_HEADROOM = 500;

/** 单个数组的批量裁剪：返回裁掉的条数，触顶时一次性 FIFO 淘汰头部 */
function boundedAppend<T>(arr: T[], item: T, max: number): [T[], number] {
  const next = [...arr, item];
  if (next.length <= max + TRIM_HEADROOM) return [next, 0];
  return [next.slice(next.length - max), next.length - max];
}

export function useConsoleSocket() {
  const { apiKey } = useAuth();
  /** 所有在线设备 */
  const devices = ref<DeviceInfo[]>([]);
  /** 当前选中设备的实时日志 */
  const logs = shallowRef<LogEntry[]>([]);
  /** 当前选中设备的实时 network */
  const network = shallowRef<NetworkEntry[]>([]);
  /** 当前选中设备的实时错误 */
  const errors = shallowRef<ErrorEntry[]>([]);
  /**
   * 会话内因触顶被丢弃的最旧记录累计条数
   *
   * 仅在当前设备的持续查看会话中累积，切设备清零。
   * 面板工具栏据此显示"已滚动丢弃最早 N 条"提示——淘汰必须可见，
   * 避免用户误以为完整历史仍在内存里。
   */
  const droppedCounts = ref({ logs: 0, network: 0, errors: 0 });
  /**
   * storage 变化版本号
   *
   * 收到远程设备 storage-change 推送时递增，StoragePanel watch 它自动重新拉取。
   * 用版本号而非直接传数据：storage 数据量大（IndexedDB 可能几百条），
   * 推送只做信号，拉取走 HTTP（可分页/缓存）。
   */
  const storageVersion = ref(0);
  /** 最后一次 storage 变化的时间戳（面板显示用） */
  const storageUpdateTime = ref<number | null>(null);
  /**
   * DOM 变化版本号（每次收到 dom-change 推送时递增）
   *
   * ElementPanel watch 它判断是否需要刷新已展开节点。
   * 同时携带 parentIdxs + kinds 供 ElementPanel 精确刷新 + 高亮。
   */
  const domChangeVersion = ref(0);
  /** 最近一次 DOM 变化的详细数据（parentIdxs + kinds + timestamp） */
  const domChangeData = ref<{
    parentIdxs: number[];
    kinds: Array<"added" | "removed" | "attributes" | "text">;
    timestamp: number;
  } | null>(null);

  /** 最新的屏幕共享帧（ElementPanel watch 后用 FrameCompositor 合成到 canvas） */
  const screenFrame = shallowRef<ScreenFrame | null>(null);
  /** 远端设备屏幕共享状态 */
  const screenShareStatus = shallowRef<ScreenShareStatus | null>(null);
  /**
   * 远端设备最新鼠标事件（归一化坐标 0~1）
   *
   * ElementPanel watch 它在画面/布局预览上渲染虚拟光标。
   * 用 shallowRef：鼠标 move 频率高，浅比较避免深层响应式开销。
   */
  const deviceMouse = shallowRef<MouseEventData | null>(null);
  /**
   * 每个 storage key 的最后修改时间戳（运行期间 SDK 捕获）
   *
   * key = `${storageType}::${storageKey}`，值 = timestamp。
   * 只在 SDK 运行期间有效（页面刷新后重置），不需要持久化。
   */
  const storageKeyTimes = ref<Record<string, number>>({});
  /**
   * 当前选中设备 id
   *
   * 持久化到 localStorage：刷新/路由返回后自动恢复上次选中（设备仍在线时），
   * 避免每次都回到"从左侧选择一个设备"空态。
   */
  const SELECTED_DEVICE_KEY = "silkpulse-selected-device";
  const selectedDeviceId = ref<string | null>(localStorage.getItem(SELECTED_DEVICE_KEY));
  /** 连接状态 */
  const connected = ref(false);

  let ws: WebSocket | null = null;
  /**
   * 重连定时器句柄
   *
   * 必须跟踪，否则组件卸载后已调度的重连仍会触发，建立幽灵 WS 连接。
   * 与 SDK ws-client 的同类修复一致：定时器生命周期要显式管理。
   */
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 重连退避计数器
   *
   * 连续失败时延迟递增（2→4→8→16→30s 上限），避免 server 恢复瞬间连接风暴。
   * 成功连接后重置为 0。
   */
  let reconnectAttempts = 0;
  /**
   * 应用层心跳定时器
   *
   * 浏览器 WebSocket API 无法发 ping 帧，只能靠应用层消息做心跳。
   * 每 25s 发 {type:'ping'}，server 回 {type:'pong'}，
   * 超过 35s 未收到 pong → 主动 close 触发重连（检测半开连接）。
   */
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** 上次收到 pong 的时间戳 */
  let lastPongTime = Date.now();
  /** 是否主动关闭（组件卸载），避免 close 后重连 */
  let intentionalClose = false;

  /** 上次选中的设备 ID（切换设备时先 unsubscribe 旧设备） */
  let lastSubscribedDeviceId: string | null = null;

  /**
   * devtools relay 消息监听器（DevToolsPanel 注册）
   *
   * 用监听器模式而非状态存储：devtools RPC 消息频率高、只面向当前面板，
   * 不需要响应式开销，直接回调转发给 iframe postMessage。
   */
  const devtoolsRelayListeners = new Map<
    number,
    (msg: Extract<ServerToConsoleMessage, { type: "devtools-relay" }>) => void
  >();
  let devtoolsListenerSeq = 0;

  /**
   * 注册 devtools relay 监听器（DevToolsPanel onMounted 调用）
   *
   * 返回取消函数，面板卸载时调用。
   */
  function onDevtoolsRelay(
    listener: (msg: Extract<ServerToConsoleMessage, { type: "devtools-relay" }>) => void,
  ): () => void {
    const id = ++devtoolsListenerSeq;
    devtoolsRelayListeners.set(id, listener);
    return () => devtoolsRelayListeners.delete(id);
  }

  /** 发送 devtools relay 消息到设备（DevToolsPanel 的 iframe → WS → 设备 backend） */
  function sendDevtoolsRelay(
    deviceId: string,
    plugin: "vue" | "react",
    payload: string | Record<string, unknown>,
  ): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "devtools-relay", deviceId, plugin, payload }));
    }
  }

  /**
   * 设备 reload 重连监听器（DevToolsPanel 注册）
   *
   * 设备页面 reload 后 backend（vue devtools-kit / react Agent）随页面销毁重建，
   * 旧 iframe 里的 frontend 还持着死链路 → 需重载 iframe 重新握手。
   */
  const deviceReconnectListeners = new Map<number, (deviceId: string) => void>();
  let deviceReconnectSeq = 0;

  /** 注册 reload 重连监听器，返回取消函数 */
  function onDeviceReconnect(listener: (deviceId: string) => void): () => void {
    const id = ++deviceReconnectSeq;
    deviceReconnectListeners.set(id, listener);
    return () => deviceReconnectListeners.delete(id);
  }

  /** 切换选中的设备（订阅实时数据 + 拉取历史缓冲区） */
  async function selectDevice(id: string | null) {
    selectedDeviceId.value = id;
    /** 持久化选择：null 时清除记录 */
    if (id) localStorage.setItem(SELECTED_DEVICE_KEY, id);
    else localStorage.removeItem(SELECTED_DEVICE_KEY);
    logs.value = [];
    network.value = [];
    errors.value = [];
    /** 新设备的全新会话：丢弃统计归零 */
    droppedCounts.value = { logs: 0, network: 0, errors: 0 };
    screenShareStatus.value = null;
    storageKeyTimes.value = {};
    /** 先取消订阅旧设备，避免带宽浪费（server 会保留旧订阅） */
    if (
      ws &&
      ws.readyState === WebSocket.OPEN &&
      lastSubscribedDeviceId &&
      lastSubscribedDeviceId !== id
    ) {
      ws.send(JSON.stringify({ type: "unsubscribe", deviceId: lastSubscribedDeviceId }));
    }
    lastSubscribedDeviceId = id;
    if (!id) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", deviceId: id }));
    }
    /** 同时拉取 server 端环形缓冲区的历史数据，让用户立即看到选中前的请求/日志 */
    try {
      const [logsRes, netRes, errRes] = await Promise.all([
        apiFetch(`/api/devices/${id}/logs`),
        apiFetch(`/api/devices/${id}/network`),
        apiFetch(`/api/devices/${id}/errors`),
      ]); /** 竞态守卫：HTTP 往返期间用户可能已切到别的设备，过期响应不得覆盖新选中设备的状态 */
      if (selectedDeviceId.value !== id) return;
      logs.value = await logsRes.json();
      network.value = await netRes.json();
      errors.value = await errRes.json();
    } catch {
      /** 拉取失败时保持空，WS 推送仍会补充新数据 */
    }
  }

  /**
   * 通知 server 当前启用的 watcher（按需采集）
   *
   * 控制台打开 Storage/Element 面板时调用，传入对应 watcher 类型。
   * server 汇总所有控制台的请求后，下发 set-watchers 给设备 SDK，
   * 设备端按需启停 MutationObserver / storage 劫持等。
   */
  function setWatchers(deviceId: string, watchers: string[]): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set-watchers", deviceId, watchers }));
    }
  }

  /** 连接 server */
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    /** 鉴权模式下在 WS URL query 中携带 token */
    const wsParams = new URLSearchParams();
    if (apiKey.value) wsParams.set("token", apiKey.value);
    const queryStr = wsParams.toString();
    const url = `${proto}//${location.host}/ws/console${queryStr ? "?" + queryStr : ""}`;
    intentionalClose = false;
    ws = new WebSocket(url);

    ws.onopen = () => {
      connected.value = true;
      /** 重置退避计数器 */
      reconnectAttempts = 0;
      /** 重连后恢复之前选中的设备订阅 */
      if (lastSubscribedDeviceId) {
        ws!.send(JSON.stringify({ type: "subscribe", deviceId: lastSubscribedDeviceId }));
      }
      /** 启动应用层心跳（每 25s 发 ping） */
      lastPongTime = Date.now();
      startHeartbeat();
    };

    ws.onclose = () => {
      connected.value = false;
      stopHeartbeat();
      /** 组件卸载时主动关闭，不再重连 */
      if (intentionalClose) return;
      /** 指数退避重连：2→4→8→16→30s 上限 */
      const delay = Math.min(2000 * 2 ** reconnectAttempts, 30000);
      reconnectAttempts++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    ws.onerror = () => {
      /** onerror 后必然触发 onclose，这里不做重连逻辑，
       *  但如果鉴权失败（403），onclose 的 wasClean 为 false 会继续重连 → 死循环。
       *  通过 onclose 里的退避机制限制频率，不额外处理。 */
    };

    ws.onmessage = (ev) => {
      let msg: ServerToConsoleMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      /** 收到 pong 更新心跳时间戳 */
      if ((msg as { type?: string }).type === "pong") {
        lastPongTime = Date.now();
        return;
      }
      handleMessage(msg);
    };
  }

  /** 启动应用层心跳 */
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      /** 检查上次 pong 是否超时（35s 未收到 → 半开连接） */
      if (Date.now() - lastPongTime > 35000) {
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: "ping" }));
    }, 25000);
  }

  /** 停止心跳定时器 */
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function handleMessage(msg: ServerToConsoleMessage) {
    switch (msg.type) {
      case "device-list": {
        devices.value = msg.devices;
        /**
         * 恢复上次选中的设备：localStorage 里记着的 id 仍在线 → 重新 selectDevice
         * （订阅实时数据 + 拉历史缓冲）；已离线 → 清掉记录回空态，避免恢复到幽灵设备。
         */
        const restored = selectedDeviceId.value;
        if (restored) {
          if (msg.devices.some((d) => d.id === restored)) {
            void selectDevice(restored);
            return;
          }
          selectedDeviceId.value = null;
          localStorage.removeItem(SELECTED_DEVICE_KEY);
        }
        break;
      }
      case "device-online": {
        /** 新设备 → 追加；已存在 → 更新元信息（SPA 路由变化、tags 修改都会触发） */
        const idx = devices.value.findIndex((d) => d.id === msg.device.id);
        if (idx === -1) {
          devices.value = [...devices.value, msg.device];
        } else {
          const next = devices.value.slice();
          next[idx] = msg.device;
          devices.value = next;
        }
        break;
      }
      case "device-offline":
        devices.value = devices.value.filter((d) => d.id !== msg.deviceId);
        if (selectedDeviceId.value === msg.deviceId) {
          selectedDeviceId.value = null;
          localStorage.removeItem(SELECTED_DEVICE_KEY);
          logs.value = [];
          network.value = [];
          errors.value = [];
          screenShareStatus.value = null;
        }
        break;
      case "log":
        if (msg.deviceId === selectedDeviceId.value) {
          const [next, dropped] = boundedAppend(logs.value, msg.log, MAX_SESSION_LOGS);
          if (dropped > 0) droppedCounts.value.logs += dropped;
          logs.value = next;
        }
        break;
      case "log-repeat": {
        /** 连续重复日志：最后一条 repeat +1（浅拷贝触发 shallowRef 响应式） */
        if (msg.deviceId === selectedDeviceId.value && logs.value.length > 0) {
          const arr = logs.value.slice();
          const lastIdx = arr.length - 1;
          const last = arr[lastIdx];
          arr[lastIdx] = { ...last, repeat: (last.repeat ?? 1) + 1 };
          logs.value = arr;
        }
        break;
      }
      case "network":
        if (msg.deviceId === selectedDeviceId.value) {
          const [netNext, netDropped] = boundedAppend(
            network.value,
            msg.entry,
            MAX_SESSION_NETWORK,
          );
          if (netDropped > 0) droppedCounts.value.network += netDropped;
          network.value = netNext;
        }
        break;
      case "network-update": {
        /** 已有 entry 的增量更新（loading→done）：按 seq 找到并合并 patch */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice();
          const idx = arr.findIndex((n) => n.seq === msg.seq);
          if (idx >= 0) {
            arr[idx] = { ...arr[idx], ...msg.patch };
            network.value = arr;
          }
        }
        break;
      }
      case "ws-frame": {
        /** WebSocket 帧追加：按 seq 找到 WS 连接条目，追加帧（浅拷贝触发响应式） */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice();
          const entry = arr.find((n) => n.seq === msg.seq);
          if (entry && entry.protocol === "ws") {
            const frames = [...(entry.frames ?? []), msg.frame];
            /** 单连接帧上限：超限 FIFO 淘汰最旧帧（帧列表可能高频增长） */
            const bounded =
              frames.length > MAX_SESSION_FRAMES
                ? frames.slice(frames.length - MAX_SESSION_FRAMES)
                : frames;
            const idx = arr.indexOf(entry);
            arr[idx] = { ...entry, frames: bounded };
            network.value = arr;
          }
        }
        break;
      }
      case "ws-state": {
        /** WebSocket readyState 变化：更新条目 wsState + status */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice();
          const entry = arr.find((n) => n.seq === msg.seq);
          if (entry && entry.protocol === "ws") {
            const idx = arr.indexOf(entry);
            arr[idx] = { ...entry, wsState: msg.wsState, status: msg.wsState };
            network.value = arr;
          }
        }
        break;
      }
      case "sse-event": {
        /** SSE 事件追加：按 seq 找到 SSE 连接条目，追加事件（浅拷贝触发响应式） */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice();
          const entry = arr.find((n) => n.seq === msg.seq);
          if (entry && entry.sseState) {
            const idx = arr.indexOf(entry);
            if (msg.event.event === "__closed__") {
              arr[idx] = { ...entry, sseState: "closed" as const };
            } else {
              const events = [...(entry.events ?? []), msg.event];
              /** 单连接事件上限：超限 FIFO 淘汰最旧事件 */
              const bounded =
                events.length > MAX_SESSION_FRAMES
                  ? events.slice(events.length - MAX_SESSION_FRAMES)
                  : events;
              arr[idx] = { ...entry, events: bounded };
            }
            network.value = arr;
          }
        }
        break;
      }
      case "error":
        if (msg.deviceId === selectedDeviceId.value) {
          const [errNext, errDropped] = boundedAppend(errors.value, msg.error, MAX_SESSION_ERRORS);
          if (errDropped > 0) droppedCounts.value.errors += errDropped;
          errors.value = errNext;
        }
        break;
      case "storage-change":
        /**
         * 远程设备 storage 变化 → 递增版本号 + 记录时间 + 缓存 key 时间戳
         *
         * msg.key 可能不存在（clear() 无法确定具体 key），此时只刷新不记 key 时间。
         */
        if (msg.deviceId === selectedDeviceId.value) {
          storageVersion.value++;
          const ts = msg.timestamp ?? Date.now();
          storageUpdateTime.value = ts;
          if (msg.key) {
            storageKeyTimes.value = {
              ...storageKeyTimes.value,
              [`${msg.storageType}::${msg.key}`]: ts,
            };
          }
        }
        break;
      case "dom-change":
        /** 远程设备 DOM 变化 → 递增版本号 + 携带 parentIdxs 供 ElementPanel 精确刷新 */
        if (msg.deviceId === selectedDeviceId.value) {
          domChangeVersion.value++;
          domChangeData.value = msg.changes;
        }
        break;
      case "screen-frame":
        /** 设备屏幕共享帧 → 更新 screenFrame（ElementPanel watch 合成） */
        if (msg.deviceId === selectedDeviceId.value) {
          screenFrame.value = msg.frame;
        }
        break;
      case "screen-share-status":
        /** 设备屏幕共享状态变化（等待授权/共享中/被拒绝等） */
        if (msg.deviceId === selectedDeviceId.value) {
          screenShareStatus.value = msg.status;
        }
        break;
      case "device-mouse":
        /** 远端鼠标/触摸事件 → 更新 deviceMouse（ElementPanel watch 渲染虚拟光标） */
        if (msg.deviceId === selectedDeviceId.value) {
          deviceMouse.value = msg.mouse;
        }
        break;
      case "device-reconnect": {
        /** 设备页面 reload 重连：devtools backend 已重建 → 通知监听器（DevToolsPanel 重载 iframe 重新握手） */
        for (const listener of deviceReconnectListeners.values()) listener(msg.deviceId);
        break;
      }
      case "devtools-relay": {
        /** devtools backend RPC 消息：直接回调给监听器（DevToolsPanel → iframe postMessage） */
        for (const listener of devtoolsRelayListeners.values()) listener(msg);
        break;
      }
      case "network-body": {
        /** 设备返回完整 body（懒加载）：合并到对应 entry */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice();
          const idx = arr.findIndex((n) => n.seq === msg.bodySeq);
          if (idx >= 0 && msg.body !== null) {
            /** body 可能是 reqBody 或 resBody，看原始 entry 哪个被截断 */
            const entry = arr[idx];
            arr[idx] = {
              ...entry,
              /** 覆盖被截断的字段，清除 truncated 标记 */
              resBody: entry.resBody ?? msg.body,
              reqBody: entry.bodyTruncated ? msg.body : entry.reqBody,
              bodyTruncated: false,
            };
            network.value = arr;
          }
          /** 从 pending 中取出 callback */
          const cb = pendingBodyRequests.get(msg.bodySeq);
          if (cb) {
            pendingBodyRequests.delete(msg.bodySeq);
            cb(msg.body);
          }
        }
        break;
      }
    }
  }

  /** 发送控制台消息到 server（start/stop screen-share 等） */
  function sendConsoleMessage(msg: import("@silkpulse/shared").ConsoleMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** 懒加载 body 请求的 pending callback 映射 */
  const pendingBodyRequests = new Map<number, (body: string | null) => void>();

  /**
   * 请求完整 body（懒加载）
   *
   * bodyTruncated=true 的 entry 调用此方法，通过 WS 请求设备返回完整 body。
   * 返回 Promise<string | null>，超时 5s 自动 resolve(null)。
   */
  function requestNetworkBody(deviceId: string, bodySeq: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBodyRequests.delete(bodySeq);
        resolve(null);
      }, 5000);

      pendingBodyRequests.set(bodySeq, (body) => {
        clearTimeout(timer);
        resolve(body);
      });

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "get-network-body", deviceId, bodySeq }));
      } else {
        clearTimeout(timer);
        pendingBodyRequests.delete(bodySeq);
        resolve(null);
      }
    });
  }

  onUnmounted(() => {
    /** 标记主动关闭，阻止 onclose 重连 */
    intentionalClose = true;
    /** 清理重连定时器，防止卸载后建立幽灵 WS 连接 */
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    stopHeartbeat();
    ws?.close();
  });

  return {
    devices,
    logs,
    network,
    errors,
    /** 各类记录因触顶被滚动丢弃的累计条数（面板工具栏提示用） */
    droppedCounts,
    storageVersion,
    storageUpdateTime,
    storageKeyTimes,
    domChangeVersion,
    domChangeData,
    screenFrame,
    screenShareStatus,
    deviceMouse,
    selectedDeviceId,
    connected,
    connect,
    selectDevice,
    setWatchers,
    sendConsoleMessage,
    requestNetworkBody,
    onDevtoolsRelay,
    sendDevtoolsRelay,
    onDeviceReconnect,
  };
}
