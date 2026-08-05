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

import type { WebSocketServer, WebSocket } from 'ws'
import type { DeviceRegistry, Device } from './device-registry.js'
import type {
  DeviceMessage,
  ServerToConsoleMessage,
  ConsoleMessage,
  DeviceInfo,
} from '@clarosight/shared'

/** 生成设备 ID（8 位十六进制） */
function generateDeviceId(): string {
  return Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')
}

/**
 * 创建并挂载 WebSocket 服务到 HTTP server
 * 返回一个函数，用于向指定设备的控制台广播消息
 */
export function setupWebSocket(
  wss: WebSocketServer,
  registry: DeviceRegistry
): void {
  /** 每个 WS 连接对应的设备 ID（设备端）或订阅集合（控制台端） */
  const deviceSockets = new Map<WebSocket, Device>()
  /** 控制台订阅：consoleWs → Set<deviceId>，以及反向映射 device → Set<consoleWs> */
  const consoleSubscriptions = new Map<WebSocket, Set<string>>()
  const deviceWatchers = new Map<string, Set<WebSocket>>()

  /** 向所有订阅了某设备的控制台广播消息 */
  function broadcast(deviceId: string, msg: ServerToConsoleMessage) {
    const watchers = deviceWatchers.get(deviceId)
    if (!watchers) return
    const text = JSON.stringify(msg)
    for (const ws of watchers) {
      if (ws.readyState === ws.OPEN) ws.send(text)
    }
  }

  /** 取消某控制台对所有设备的订阅 */
  function unsubscribeAll(ws: WebSocket) {
    const subs = consoleSubscriptions.get(ws)
    if (!subs) return
    for (const deviceId of subs) {
      const watchers = deviceWatchers.get(deviceId)
      if (watchers) {
        watchers.delete(ws)
        if (watchers.size === 0) deviceWatchers.delete(deviceId)
      }
    }
    consoleSubscriptions.delete(ws)
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    /** ---------- 设备端连接 ---------- */
    if (pathname === '/ws/device') {
      let deviceId = ''
      let device: Device | undefined

      ws.on('message', (raw) => {
        let msg: DeviceMessage
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }

        switch (msg.type) {
          case 'register': {
            /** 设备首次注册：分配/复用 id，建立映射 */
            deviceId = msg.device.id || generateDeviceId()
            const info: DeviceInfo = {
              ...msg.device,
              id: deviceId,
              onlineAt: Date.now(),
            }
            device = registry.register(info, ws)
            deviceSockets.set(ws, device)
            /** 广播设备列表更新给所有控制台 */
            broadcast(deviceId, {
              type: 'device-online',
              device: info,
            })
            notifyDeviceListChanged()
            break
          }
          case 'update-info': {
            /** SPA 路由变化：SDK 上报新 url/title，server 更新元信息并通知控制台 */
            if (!device) return
            registry.updateInfo(deviceId, {
              url: msg.device.url,
              title: msg.device.title,
              viewportWidth: msg.device.viewportWidth,
              viewportHeight: msg.device.viewportHeight,
              deviceType: msg.device.deviceType,
            })
            broadcast(deviceId, {
              type: 'device-online',
              device: device.info,
            })
            break
          }
          case 'log': {
            if (!device) return
            device.logs.push(msg.log)
            broadcast(deviceId, { type: 'log', deviceId, log: msg.log })
            break
          }
          case 'network': {
            if (!device) return
            device.network.push(msg.entry)
            broadcast(deviceId, {
              type: 'network',
              deviceId,
              entry: msg.entry,
            })
            break
          }
          case 'error': {
            if (!device) return
            device.errors.push(msg.error)
            registry.updateInfo(deviceId, {
              errorCount: device.info.errorCount + 1,
            })
            broadcast(deviceId, {
              type: 'error',
              deviceId,
              error: msg.error,
            })
            break
          }
          case 'snapshot': {
            /** 快照不存缓冲区（体积大、时效性强），直接转发给控制台 */
            if (!device) return
            /** 快照请求通常是 exec 触发的，由 exec-bridge 处理，这里仅转发 */
            break
          }
          case 'exec-result': {
            if (!device) return
            const resolve = device.pendingExecs.get(msg.execId)
            if (resolve) {
              resolve(msg.result)
              device.pendingExecs.delete(msg.execId)
            }
            break
          }
        }
      })

      ws.on('close', () => {
        /** 只有当 registry 里这个 device 的 ws 仍是当前关闭的 ws 时才下线。
         *  若设备已用新 ws 重连，registry 里是新的 ws，此时旧连接关闭不应下线 */
        const current = registry.get(deviceId)
        if (current && current.ws === ws) {
          registry.unregister(deviceId)
        }
        deviceSockets.delete(ws)
        notifyDeviceListChanged()
      })
      return
    }

    /** ---------- 控制台连接 ---------- */
    if (pathname === '/ws/console') {
      consoleSubscriptions.set(ws, new Set())

      /** 控制台连上后立即推送当前设备列表 */
      ws.send(
        JSON.stringify({
          type: 'device-list',
          devices: registry.list(),
        } satisfies ServerToConsoleMessage)
      )

      ws.on('message', (raw) => {
        let msg: ConsoleMessage
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }
        switch (msg.type) {
          case 'subscribe': {
            const subs = consoleSubscriptions.get(ws)!
            subs.add(msg.deviceId)
            let watchers = deviceWatchers.get(msg.deviceId)
            if (!watchers) {
              watchers = new Set()
              deviceWatchers.set(msg.deviceId, watchers)
            }
            watchers.add(ws)
            break
          }
          case 'unsubscribe': {
            const subs = consoleSubscriptions.get(ws)
            if (!subs) break
            subs.delete(msg.deviceId)
            const watchers = deviceWatchers.get(msg.deviceId)
            watchers?.delete(ws)
            break
          }
        }
      })

      ws.on('close', () => unsubscribeAll(ws))
    }
  })

  /** 设备列表变化时推送给所有控制台 */
  function notifyDeviceListChanged() {
    const devices = registry.list()
    const msg: ServerToConsoleMessage = { type: 'device-list', devices }
    const text = JSON.stringify(msg)
    for (const ws of consoleSubscriptions.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(text)
    }
  }
}
