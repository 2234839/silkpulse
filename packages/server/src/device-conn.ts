/**
 * 设备连接抽象 —— 屏蔽底层传输差异
 *
 * 设备可通过两种传输接入 server：
 * - WebSocket（SilkWs 包装）：常规路径
 * - HTTP 桥接（BridgeConn）：userscript 用 GM_xmlhttpRequest 承载，
 *   穿透页面 CSP connect-src 对 WebSocket 的拦截
 *
 * 两者对外呈现同一接口，DeviceRegistry / DeviceChannel 不感知传输类型。
 */

/** 设备连接的最小接口（SilkWs 与 BridgeConn 均满足） */
export interface DeviceConn {
  /** readyState 常量：OPEN（static 成员，实例可访问） */
  readonly OPEN: number;
  /** 连接是否就绪（对齐 ws 库语义） */
  readonly readyState: number;
  /** 未发送缓冲字节数（背压检测用） */
  readonly bufferedAmount: number;
  /** close 后置位，send 自动 no-op */
  closed: boolean;
  /** 发送文本消息（JSON 字符串），返回值语义对齐 SilkWs */
  send(text: string, cb?: () => void): number;
  /** 优雅关闭 */
  end(code?: number, shortMessage?: string): void;
  /** 强制关闭 */
  close(): void;
}
