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

/**
 * 离线消息缓冲队列
 *
 * 解决两个丢数据场景：
 * 1. 启动期间：采集器安装到 WS 连上之间，页面的早期错误/日志/网络请求
 * 2. 断线期间：WS 断开到重连成功之间，数据暂存，重连后 flush
 *
 * 上限 200 条防膨胀（日志已有限流，error/network 量小，正常不会触顶）。
 * 满了之后新增的丢弃旧的（FIFO 覆盖），优先保留新数据。
 */
const MAX_QUEUE = 200
const sendQueue: string[] = []

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
    const sock = ws
    if (!sock) return
    sock.send(JSON.stringify({ type: 'register', device: options.info }))

    /** flush 离线期间缓冲的消息（register 先发，确保 server 建好设备上下文） */
    if (sendQueue.length > 0) {
      for (const raw of sendQueue) {
        sock.send(raw)
      }
      sendQueue.length = 0
    }
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
 * 发送消息到 server
 *
 * 连接就绪时立即发；未就绪时入缓冲队列，连上后 flush。
 * 不再静默丢弃——启动期间和断线期间的数据都不该丢。
 */
export function send(message: DeviceMessage): void {
  const raw = JSON.stringify(message)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(raw)
  } else {
    /** 入队：满了丢弃最旧的（FIFO 覆盖），优先保留新数据 */
    if (sendQueue.length >= MAX_QUEUE) sendQueue.shift()
    sendQueue.push(raw)
  }
}

/** 当前缓冲队列长度（测试/诊断用） */
export function getQueueLength(): number {
  return sendQueue.length
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
