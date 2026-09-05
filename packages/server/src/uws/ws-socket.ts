/**
 * uWS WebSocket 的统一业务包装
 *
 * uWS 的 WebSocket 是 C++ 对象的 JS 视图，行为与 ws 库差异大：
 * - 没有 readyState 属性 → 用 closed 标记维护
 * - send 无回调 → 靠返回值 + getBufferedAmount 判断背压
 * - close 后对象立即失效 → 所有方法前判 closed
 *
 * SilkWs 提供业务层熟悉的接口（readyState/OPEN/send/getBufferedAmount/end），
 * 让 device-registry / ws-relay 的迁移改动最小。
 */

import type { WebSocket } from "uWebSockets.js";
import type { AuthContext } from "../auth.js";

/** readyState 常量（对齐 ws 库语义） */
export const WS_READY = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

/**
 * 业务 WebSocket 包装
 *
 * 生命周期：open 回调创建 → close 回调销毁（closed 置位）。
 * close 后 send 自动变 no-op，调用方无需 try/catch。
 */
export class SilkWs {
  static readonly OPEN = WS_READY.OPEN;
  static readonly CLOSED = WS_READY.CLOSED;

  /** 底层 uWS WebSocket（close 后不可再用） */
  readonly ws: WebSocket<WsUserData>;
  /** 鉴权上下文（upgrade 阶段解析，业务层做项目隔离用） */
  readonly authCtx: AuthContext;
  /** close 回调触发后置位 */
  closed = false;

  constructor(ws: WebSocket<WsUserData>, authCtx: AuthContext) {
    this.ws = ws;
    this.authCtx = authCtx;
  }

  /** ws 库兼容：readyState */
  get readyState(): number {
    return this.closed ? WS_READY.CLOSED : WS_READY.OPEN;
  }

  get OPEN(): number {
    return WS_READY.OPEN;
  }

  /** ws 库兼容：缓冲字节数（背压检测） */
  get bufferedAmount(): number {
    if (this.closed) return 0;
    return this.ws.getBufferedAmount();
  }

  /**
   * 发送文本消息（JSON 字符串）
   *
   * 与 ws.send(text, cb) 等价：
   * - 返回 1 成功 / 2 背压丢弃 / 0 暂积压
   * - close 后 no-op（对应 ws 库回调吞错语义）
   */
  send(text: string, _cb?: () => void): number {
    if (this.closed) return 0;
    return this.ws.send(text);
  }

  /** 优雅关闭（对应 ws.close(code, reason)） */
  end(code = 1000, shortMessage = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.end(code, shortMessage);
  }

  /** 强制关闭（对应 ws.terminate()） */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
  }
}

/** uWS UserData：连接级业务数据（upgrade 阶段创建，open 回调补全） */
export interface WsUserData {
  /** SilkWs 包装实例（open 回调创建后回填，upgrade 阶段为 undefined） */
  silk: SilkWs;
  /** upgrade 阶段解析的鉴权上下文（open 时消费） */
  authCtx?: import("../auth.js").AuthContext;
  /** upgrade 阶段的完整连接 URL（open 时消费） */
  url?: string;
}

/** 从 uWS ws 取业务包装（open 回调之前不可用） */
export function getSilk(ws: WebSocket<WsUserData>): SilkWs {
  return ws.getUserData().silk;
}
