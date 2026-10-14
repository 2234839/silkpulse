/**
 * Elements 面板桥接 —— 在目标页运行 chobitsu（Chrome DevTools 协议纯 JS 实现），
 * 通过 SilkPulse WS 与控制台内嵌的官方 devtools-frontend（chii_app embedded 模式）通信
 *
 * 架构：
 *   目标页（本文件）              SilkPulse server            控制台
 *   ┌──────────────────┐      ┌────────────┐      ┌──────────────────────────┐
 *   │ chobitsu          │      │  devtools  │      │ iframe: 官方 frontend    │
 *   │ 应答 CDP DOM/CSS  │◄────►│  -relay    │◄────►│ (embedded postMessage    │
 *   │ 等域              │ (WS) │   透传     │ (WS) │  模式，原始 CDP JSON)    │
 *   └──────────────────┘      └────────────┘      └──────────────────────────┘
 *
 * payload 约定（双向均为原始 CDP JSON 字符串，chii embedded 连接层原生格式）：
 *   frontend → 设备：字符串 → chobitsu.sendRawMessage
 *   设备 → frontend：chobitsu onMessage 字符串 → relay 原样透传
 *   握手：{ activate: true }（dock encodeFromClient 由 frontend ready 信号转换）
 *
 * chobitsu 未加载完成前到达的 frontend 消息先进缓冲区，加载后按序 flush——
 * frontend 一启动就发 DOM.enable 等命令，不能丢也不能乱序。
 */

import { send } from "./ws-client.js";
import { registerServerMessageHandler } from "./message-router.js";
import type { NetworkEntry, LogEntry } from "@silkpulse/shared";

/** chobitsu UMD bundle 的下载路径（server 静态服务） */
const CHOBITSU_URL = "/plugins/chrome-devtools/chobitsu.js";

/** 激活协议里 enable 域的顺序（chobitsu 幂等）
 *
 * 注意不含 Runtime：chobitsu 的 executionContextCreated 只在首次 Runtime.enable
 * 时推送，若桥接预 enable 抢先消费，frontend 自己的 Runtime.enable 就拿不到
 * 上下文，Console 面板会因「无 JS 上下文」丢弃所有日志。Runtime 留给 frontend
 * 自己 enable（frontend 连上后立即发），context 事件才能送达它。 */
const ENABLE_METHODS = [
  "Network.enable",
  "Debugger.enable",
  "DOMStorage.enable",
  "DOM.enable",
  "CSS.enable",
  "Overlay.enable",
] as const;

/** chobitsu 全局对象的最小接口面 */
interface Chobitsu {
  /** 发送 CDP 命令（JSON 字符串） */
  sendRawMessage(message: string): void;
  /** 注册 CDP 事件/响应回调（JSON 字符串） */
  setOnMessage(handler: (message: string) => void): void;
}

/** 是否已激活（chobitsu 已加载 + enable 序列已发） */
let activated = false;
/** 加载中 promise（并发 activate 幂等） */
let loadPromise: Promise<Chobitsu> | null = null;
/** chobitsu 就绪前缓冲的 frontend 消息（保持顺序） */
const pendingMessages: string[] = [];

/** 推导 server origin（与 react-devtools-bridge 同逻辑） */
function resolveServerOrigin(): string {
  const target = window as unknown as Record<string, unknown>;
  const fromInit = target.__SILKPULSE_SERVER__;
  if (typeof fromInit === "string" && fromInit) return fromInit;
  try {
    const script = document.currentScript as HTMLScriptElement | null;
    if (script?.src) return new URL(script.src).origin;
  } catch {
    /** script.src 解析失败忽略 */
  }
  return "";
}

/**
 * 懒加载 chobitsu UMD bundle（fetch + new Function，UMD 自己挂 window.chobitsu）
 * 失败抛错：Elements 面板是显式激活的，失败需要让控制台看到连接不上的事实
 */
async function loadChobitsu(): Promise<Chobitsu> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const target = window as unknown as { chobitsu?: Chobitsu };
    if (target.chobitsu) return target.chobitsu;

    const resp = await fetch(resolveServerOrigin() + CHOBITSU_URL);
    if (!resp.ok) throw new Error(`chobitsu 加载失败: HTTP ${resp.status}`);
    const code = await resp.text();
    new Function(code).call(window);
    if (!target.chobitsu) throw new Error("chobitsu bundle 未挂载全局 chobitsu");
    return target.chobitsu;
  })();
  return loadPromise;
}

/** 向控制台 frontend 透传 chobitsu 消息（CDP JSON 字符串原样）
 *
 * 过滤 tmp id 的响应：预 enable 序列用 tmp 前缀 id 发出，frontend 没见过这些 id，
 * 透传过去会报 Protocol Error: the message with wrong id（demo 同款过滤） */
function relayToConsole(message: string): void {
  if (message.includes('"id":"tmp')) return;
  send({ type: "devtools-relay", plugin: "elements", payload: message });
}

/**
 * 激活 Elements 桥：加载 chobitsu → flush 缓冲 → 发 enable 序列 →
 * 通知 frontend 文档就绪（Page.frameNavigated + DOM.documentUpdated，
 * 与 chii/demo 验证过的序列一致——缺这两条 frontend 的 DOM 树不渲染）。
 *
 * 可重入：控制台侧刷新会重载 frontend iframe 并再次发 activate，
 * 此时需重发文档就绪序列，否则重载后的 frontend 收不到事件、树永远空白。
 */
async function activateChobitsu(): Promise<void> {
  try {
    const chobitsu = await loadChobitsu();

    if (!activated) {
      activated = true;
      chobitsu.setOnMessage((m) => {
        /** 丢弃 chobitsu 自带 console hook 的日志事件：consoleAPICalled 由
         *  feedLogEntry（log-collector 结构化数据）单一供给，双路同发会导致
         *  官方 Console 面板每条日志重复两条 */
        if (m.includes('"Runtime.consoleAPICalled"')) return;
        relayToConsole(m);
      });
      /** flush 激活期间缓冲的 frontend 命令（保持到达顺序） */
      for (const msg of pendingMessages) chobitsu.sendRawMessage(msg);
      pendingMessages.length = 0;
      /** 预 enable 各域（tmp id 前缀，响应不透传给 frontend） */
      let tmpId = 0;
      for (const method of ENABLE_METHODS) {
        chobitsu.sendRawMessage(JSON.stringify({ id: `tmp${++tmpId}`, method }));
      }
    }

    /** 文档就绪通知：每次激活都发（frontend 重载后需要重新收一次） */
    relayToConsole(
      JSON.stringify({
        method: "Page.frameNavigated",
        params: {
          frame: {
            id: "1",
            mimeType: "text/html",
            securityOrigin: location.origin,
            url: location.href,
          },
          type: "Navigation",
        },
      }),
    );
    relayToConsole(JSON.stringify({ method: "Runtime.executionContextsCleared", params: {} }));
    /** 手工补发 JS 上下文：Console 面板必须有 executionContext 才接受日志事件
     *  （chobitsu 的 context 推送时机受 enable 顺序影响不可靠，与文档就绪序列
     *  同为手工合成——frontend 重载后需要重新收一次） */
    relayToConsole(
      JSON.stringify({
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            id: 1,
            uniqueId: "1",
            origin: location.origin,
            name: "top",
            auxData: { isDefault: true },
          },
        },
      }),
    );
    relayToConsole(JSON.stringify({ method: "DOM.documentUpdated", params: {} }));
  } catch (err) {
    console.error("[silkpulse] Elements 桥激活失败:", err);
  }
}

/**
 * 初始化 Elements 桥（SDK 顶层同步调用，仅注册消息处理，不加载 chobitsu——
 * chobitsu 只在控制台打开 Elements 面板时才按需下载）
 */
export function initElementsBridge(): void {
  registerServerMessageHandler((msg) => {
    if (msg.type !== "devtools-relay" || msg.plugin !== "elements") return;

    /** 握手：控制台 frontend 就绪 → 激活 chobitsu（幂等） */
    if (typeof msg.payload === "object" && msg.payload !== null) {
      if ((msg.payload as { activate?: boolean }).activate === true) void activateChobitsu();
      return;
    }

    /** CDP 命令：就绪直接透传，未就绪缓冲（激活流程会 flush） */
    if (typeof msg.payload === "string") {
      if (activated && loadPromise) {
        void loadPromise.then((chobitsu) => chobitsu.sendRawMessage(msg.payload as string));
      } else {
        pendingMessages.push(msg.payload);
      }
    }
  });
}

/* ════════ 网络数据 → 官方 Network 面板适配 ════════
 * 官方 Network 面板是事件驱动：消费 CDP Network.requestWillBeSent / responseReceived /
 * loadingFinished / loadingFailed 事件渲染瀑布流。chobitsu 不实现 Network 域，
 * 这里把 SilkPulse network-collector 采集的 HAR 风格条目合成为这些事件，
 * 经同一 relay 通道喂给 frontend（Network.enable 已在激活序列中发出）。
 * 未激活时静默丢弃——官方面板没打开就不需要这份数据，零开销。 */

/** 已上报请求的元数据（seq 关联，合成 responseReceived 时需要请求侧信息） */
interface NetReqMeta {
  /** 合成 requestId（net 前缀避免与 chobitsu 的 id 空间冲突） */
  requestId: string;
  url: string;
  method: string;
  /** 请求头（截断版，与控制台网络面板一致） */
  headers: Record<string, string>;
  /** 请求发出时的 epoch 秒（CDP wallTime） */
  wallTime: number;
  /** 请求发出时的单调秒（CDP timestamp 基准） */
  startTs: number;
  /** 是否已合成过响应事件（responseReceived 只发一次） */
  responded: boolean;
}

/** 进行中请求的元数据表（seq → meta），完成即清理 */
const netRequests = new Map<number, NetReqMeta>();

/** 合成一条 CDP 事件并透传给 frontend（事件无 id，不会被 tmp 过滤误伤） */
function emitNetworkEvent(method: string, params: Record<string, unknown>): void {
  if (!activated) return;
  relayToConsole(JSON.stringify({ method, params }));
}

/** HTTP 资源类型映射（官方 waterfall 的类型图标用，映射不准只影响图标） */
function resourceType(entry: NetworkEntry): string {
  if (entry.protocol === "ws" || entry.kind === "ws") return "WebSocket";
  if (entry.kind === "xhr") return "XHR";
  const mime = entry.mimeType ?? entry.resBodyMime ?? "";
  if (mime.includes("javascript")) return "Script";
  if (mime.includes("css")) return "Stylesheet";
  if (mime.startsWith("image/")) return "Image";
  return "Fetch";
}

/**
 * 请求条目 sink：network-collector 每上报一条 entry 调一次。
 * fetch/xhr 在请求发出时（status=0）先发 requestWillBeSent，响应到达后由
 * feedNetworkUpdate 补 response/loading；resource/WS 等一次性完整条目在此直接补全。
 */
export function feedNetworkEntry(entry: NetworkEntry): void {
  if (!activated) return;
  const requestId = `net${entry.seq}`;
  const wallTime = Date.parse(entry.timestamp) / 1000 || Date.now() / 1000;
  const startTs = performance.now() / 1000;
  const meta: NetReqMeta = {
    requestId,
    url: entry.url,
    method: entry.method,
    headers: entry.reqHeaders ?? {},
    wallTime,
    startTs,
    responded: false,
  };
  netRequests.set(entry.seq, meta);
  emitNetworkEvent("Network.requestWillBeSent", {
    requestId,
    loaderId: "",
    documentURL: location.href,
    request: {
      url: entry.url,
      method: entry.method,
      headers: meta.headers,
      initialPriority: "High",
      referrerPolicy: "strict-origin-when-cross-origin",
    },
    timestamp: startTs,
    wallTime,
    initiator: { type: "other" },
    type: resourceType(entry),
  });
  /** 一次性完整条目（resource/已完成 ws 等）立即合成响应 */
  if (entry.status > 0) emitNetworkResponse(entry, meta, entry.duration);
}

/**
 * 请求更新 sink：fetch/xhr 响应到达（或出错）时由 network-collector 的
 * updateSink 转发过来，合成 responseReceived + loadingFinished/Failed
 */
export function feedNetworkUpdate(
  seq: number,
  patch: Partial<NetworkEntry> & { error?: string },
): void {
  if (!activated) return;
  const meta = netRequests.get(seq);
  if (!meta || meta.responded) return;
  meta.responded = true;
  const duration = patch.duration ?? 0;
  const entry = {
    seq,
    url: meta.url,
    method: meta.method,
    status: patch.status ?? 0,
    resHeaders: patch.resHeaders,
    resBodyMime: patch.resBodyMime,
    error: patch.error,
    duration,
  } as NetworkEntry;
  emitNetworkResponse(entry, meta, duration);
  /** 响应合成完即可释放（官方面板后续交互走 requestId 缓存，不再依赖此表） */
  netRequests.delete(seq);
}

/** 合成响应侧事件（responseReceived + loadingFinished/loadingFailed） */
function emitNetworkResponse(entry: NetworkEntry, meta: NetReqMeta, duration: number): void {  const endTs = meta.startTs + duration / 1000;
  if (entry.error) {
    emitNetworkEvent("Network.loadingFailed", {
      requestId: meta.requestId,
      timestamp: endTs,
      type: resourceType(entry),
      errorText: entry.error,
      canceled: false,
    });
    return;
  }
  const status = entry.status || 200;
  const headers = entry.resHeaders ?? {};
  const contentType =
    (headers["content-type"] ?? headers["Content-Type"] ?? entry.resBodyMime ?? "") as string;
  emitNetworkEvent("Network.responseReceived", {
    requestId: meta.requestId,
    loaderId: "",
    timestamp: endTs,
    type: resourceType(entry),
    response: {
      url: meta.url,
      status,
      statusText: status === 200 ? "OK" : "",
      headers,
      mimeType: contentType.split(";")[0] || "text/plain",
      connectionReused: false,
      connectionId: 0,
      remoteIPAddress: "",
      remotePort: 0,
      fromDiskCache: false,
      encodedDataLength: entry.resBodySize ?? -1,
      protocol: entry.protocol === "ws" || entry.kind === "ws" ? "websocket" : "http/1.1",
      securityState: "insecure",
    },
  });
  emitNetworkEvent("Network.loadingFinished", {
    requestId: meta.requestId,
    timestamp: endTs,
    encodedDataLength: entry.resBodySize ?? 0,
    shouldReportCorruptBlocking: false,
  });
}

/**
 * 日志条目 sink：把 log-collector 采集的 LogEntry 合成为 Runtime.consoleAPICalled
 * 喂给官方 Console 面板（不依赖 chobitsu 自身的 console hook——其劫持时机受
 * SDK hook 链影响不稳定，log-collector 的结构化日志是确定性的数据源）。
 */
export function feedLogEntry(entry: LogEntry): void {
  if (!activated) return;
  /** LogEntry type → CDP consoleAPICalled type */
  const typeMap: Record<string, string> = {
    info: "info",
    warn: "warning",
    error: "error",
    debug: "debug",
    trace: "trace",
    table: "table",
    dir: "dir",
    time: "log",
    assert: "error",
  };
  emitNetworkEvent("Runtime.consoleAPICalled", {
    type: typeMap[entry.type] ?? "log",
    args: [{ type: "string", value: entry.message }],
    executionContextId: 1,
    timestamp: Date.parse(entry.timestamp) / 1000 || Date.now() / 1000,
    stackTrace:
      entry.type === "error"
        ? undefined
        : undefined,
  });
}
