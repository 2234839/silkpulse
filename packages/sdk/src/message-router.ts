/**
 * server → device 消息分发表
 *
 * ws-client 保持单 handler 模式（exec-runner 主链路），本模块在其上
 * 提供多播注册：index.ts 的主 handler 先执行，devtools-bridge 等扩展
 * 模块通过 registerServerMessageHandler 挂自己的监听，互不干扰。
 */

import type { ServerToDeviceMessage } from '@silkpulse/shared'

/** 扩展监听器集合 */
const handlers: Array<(msg: ServerToDeviceMessage) => void> = []

/**
 * 注册扩展监听器（devtools-bridge 等模块用）
 *
 * ws-client.onMessage 的主 handler 会在分发前调用这些监听器。
 */
export function registerServerMessageHandler(handler: (msg: ServerToDeviceMessage) => void): void {
  handlers.push(handler)
}

/**
 * 分发 server 消息给所有扩展监听器（ws-client 主 handler 调用）
 */
export function dispatchServerMessage(msg: ServerToDeviceMessage): void {
  for (const handler of handlers) {
    try {
      handler(msg)
    } catch {
      /** 单个监听器异常不影响其他监听器和主链路 */
    }
  }
}
