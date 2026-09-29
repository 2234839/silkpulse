/**
 * DevToolsDock —— devtools 插件（dock）统一注册协议
 *
 * 灵感来自 devframe 的 hub dock 模型：每个 devtools 面板是一个「dock」，
 * 实现同一份接口（静态资源、消息编解码、刷新语义、可用性探测），
 * DevToolsPanel 由注册表驱动，新增框架 devtools = 注册一个对象 + SDK 侧加对应 bridge。
 *
 * 注意：devtools-relay 的 wire 格式（vue SuperJSON 信封 / react wall 对象）
 * 由各官方 frontend 决定，dock 只封装差异，不改协议。
 */

/** dock 注册信息（每个 devtools 插件一份，vue / react / 未来扩展） */
export interface DevToolsDock {
  /** 框架标识：devtools-relay 的 plugin 字段（"vue" | "react" | ...） */
  plugin: string;
  /** 显示名（状态条 / 切换按钮） */
  label: string;
  /** devtools client 静态资源路径（server public/plugins/ 下的 iframe src） */
  src: string;

  /**
   * 可用性探测：目标页框架探测结果（undefined = 尚未上报）下该 dock 是否可用。
   * undefined 时保持「尝试连接」，不做否定判定。
   */
  isSupported: (frameworks: string[] | undefined) => boolean;

  /**
   * iframe → 设备方向：判断 client 消息是否属于本 dock 的合法格式，
   * 并转为 relay payload（非法返回 undefined，调用方静默丢弃）。
   * 收到特殊控制信号（如 react frontend ready）时可在返回值附 activate 等指令。
   */
  encodeFromClient: (data: unknown) => string | Record<string, unknown> | undefined;

  /**
   * 设备 → iframe 方向：判断 relay payload 是否属于本 dock 的合法格式，
   * 合法则原样返回（交给 postMessage 给 iframe），非法返回 undefined。
   */
  decodeFromBackend: (payload: unknown) => unknown | undefined;

  /**
   * 刷新语义：向设备发送「拉新」指令（不重载 iframe 时）。
   * 返回 undefined 表示本 dock 的刷新 = 重载 iframe（如 react 的 Store 长驻问题）。
   */
  refreshPayload?: string | Record<string, unknown>;

  /**
   * 判断 encodeFromClient 的产物是否为握手信号（如 react 的 frontend ready
   * → activate 指令）：握手时面板应重置连接状态（回到「连接中」）。
   * 默认无握手信号语义。
   */
  isHandshake?: (payload: string | Record<string, unknown>) => boolean;
}

/** 与官方 vue iframe channel 一致的消息信封 key */
const IFRAME_MESSAGING_EVENT_KEY = "__devtools-kit-iframe-messaging-event-key__";

/* ════════ Vue dock ════════ */

/** vue 官方信封的最小结构校验（SuperJSON 字符串，不解析内容） */
function isVueEnvelope(data: unknown): data is string {
  return typeof data === "string" && data.includes(IFRAME_MESSAGING_EVENT_KEY);
}

export const vueDock: DevToolsDock = {
  plugin: "vue",
  label: "Vue",
  src: "/plugins/vue-devtools/index.html",
  isSupported: (fws) => !fws || fws.length === 0 ? false : fws.includes("vue"),
  encodeFromClient: (data) => (isVueEnvelope(data) ? data : undefined),
  decodeFromBackend: (payload) => (typeof payload === "string" ? payload : undefined),
  /** vue：官方 SEND_INSPECTOR_TREE/STATE 事件流，client 原地更新（保留展开/选中状态） */
  refreshPayload: "__silkpulse_refresh__",
};

/* ════════ React dock ════════ */

/** react frontend 就绪信号（宿主 HTML 发的内部事件） */
function isReactFrontendReady(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).event === "__silkpulse_frontend_ready__"
  );
}

/** react 消息校验：{ event: string, ... } 对象（fromBackend 标记来自设备端） */
function isReactFromFrontend(data: unknown): data is { event: string; payload?: unknown } {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.event === "string" && obj.fromBackend !== true;
}

export const reactDock: DevToolsDock = {
  plugin: "react",
  label: "React",
  src: "/plugins/react-devtools/index.html",
  isSupported: (fws) => (!fws || fws.length === 0 ? false : fws.includes("react")),
  encodeFromClient: (data) => {
    /** frontend 就绪信号 → 请求设备激活 backend Agent */
    if (isReactFrontendReady(data)) return { activate: true };
    if (!isReactFromFrontend(data)) return undefined;
    return { event: data.event, payload: data.payload };
  },
  decodeFromBackend: (payload) => {
    if (typeof payload !== "object" || payload === null) return undefined;
    const data = payload as { event?: unknown };
    return typeof data.event === "string" ? payload : undefined;
  },
  /** react：无原地刷新 payload——frontend Store 长驻，重载 iframe 才能保证树恒为 1 份 */
  refreshPayload: undefined,
  /** frontend ready → activate 指令是握手信号：重置「已连接」状态重新等待 backend */
  isHandshake: (payload) => typeof payload === "object" && !("event" in payload),
};

/* ════════ 注册表 ════════ */

/** 所有已注册 dock（新框架 devtools 在此追加） */
export const devToolsDocks: DevToolsDock[] = [vueDock, reactDock];

/** 按 plugin 名取 dock */
export function getDock(plugin: string): DevToolsDock {
  const dock = devToolsDocks.find((d) => d.plugin === plugin);
  if (!dock) throw new Error(`[DevToolsDock] 未注册的 devtools 插件: ${plugin}`);
  return dock;
}
