/**
 * WebSocket 客户端 —— 连接 clarosight server，处理重连 + 消息路由
 *
 * 职责：
 * 1. 连接 /ws/device，发送 register（含设备元信息）
 * 2. 上报 log/network/error（各 collector 调用 send）
 * 3. 接收 server 下发的 exec 指令，转给 exec-runner
 * 4. 断线指数退避重连
 */

import type {
  DeviceMessage,
  ServerToDeviceMessage,
  DeviceInfo,
} from '@clarosight/shared'

/** 连接选项 */
export interface WsClientOptions {
  /** server 地址，如 ws://localhost:8080/ws/device */
  url: string
  /** 设备元信息（register 时上报） */
  info: DeviceInfo
}

/** 当前 WebSocket（重连时切换） */
let ws: WebSocket | null = null

/** 重连退避计数 */
let reconnectAttempts = 0

/** 是否已主动断开（页面卸载时） */
let manualClose = false

/** 消息处理器（exec-runner 注册） */
let messageHandler: ((msg: ServerToDeviceMessage) => void) | null = null

/** 注册消息处理器 */
export function onMessage(handler: (msg: ServerToDeviceMessage) => void): void {
  messageHandler = handler
}

/**
 * 建立连接并保持
 */
export function connect(options: WsClientOptions): void {
  manualClose = false
  doConnect(options)
}

function doConnect(options: WsClientOptions): void {
  ws = new WebSocket(options.url)

  ws.onopen = () => {
    reconnectAttempts = 0
    send({ type: 'register', device: options.info })
  }

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as ServerToDeviceMessage
      messageHandler?.(msg)
    } catch {
      /** 非 JSON 消息忽略 */
    }
  }

  ws.onclose = () => {
    ws = null
    if (manualClose) return
    /** 指数退避：1s, 2s, 4s, 8s... 上限 30s */
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000)
    reconnectAttempts++
    setTimeout(() => doConnect(options), delay)
  }

  ws.onerror = () => {
    /** onclose 会处理重连，这里只防止 console 噪音 */
  }
}

/**
 * 发送消息到 server（连接未就绪时静默丢弃，等重连）
 */
export function send(message: DeviceMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message))
  }
}

/** 主动断开（页面卸载） */
export function disconnect(): void {
  manualClose = true
  ws?.close()
  ws = null
}

/** 连接是否就绪 */
export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN
}
