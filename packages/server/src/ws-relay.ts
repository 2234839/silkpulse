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
import type { AuthContext } from './auth.js'
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
 * 返回 notifyDeviceListChanged，供 HTTP API（如 tags 修改）触发控制台刷新
 */
export function setupWebSocket(
  wss: WebSocketServer,
  registry: DeviceRegistry
): { notifyDeviceListChanged: () => void } {
  /** 每个 WS 连接对应的设备 ID（设备端）或订阅集合（控制台端） */
  const deviceSockets = new Map<WebSocket, Device>()
  /** 控制台订阅：consoleWs → Set<deviceId>，以及反向映射 device → Set<consoleWs> */
  const consoleSubscriptions = new Map<WebSocket, Set<string>>()
  const deviceWatchers = new Map<string, Set<WebSocket>>()

  /** 向所有订阅了某设备的控制台广播消息 */
  /**
   * 单连接背压上限（bytes）
   *
   * 控制台客户端网络慢（VPN/弱网）时，ws.send 持续往内核缓冲区塞数据，
   * bufferedAmount 无限膨胀会拖垮 server 内存。超过此阈值判定连接已积压，
   * 丢弃后续消息并强制关闭该连接，保护 server 和其他客户端。
   * 1MB 约等于数千条日志的体积，正常订阅远不会触顶。
   */
  const MAX_BUFFERED = 1024 * 1024

  function broadcast(deviceId: string, msg: ServerToConsoleMessage) {
    const watchers = deviceWatchers.get(deviceId)
    if (!watchers) return
    /** 获取设备所属项目，用于控制台权限过滤 */
    const targetDevice = registry.get(deviceId)
    const deviceProjectId = targetDevice?.info.projectId
    const text = JSON.stringify(msg)
    for (const ws of watchers) {
      if (ws.readyState !== ws.OPEN) continue
      /** 项目隔离：项目级控制台只能收到自己项目设备的数据 */
      const ctx = (ws as unknown as { __authCtx?: AuthContext }).__authCtx
      if (ctx?.role === 'project' && ctx.projectId !== deviceProjectId) continue
      /** 背压保护：积压超限的连接直接关闭，不再塞数据 */
      if (ws.bufferedAmount > MAX_BUFFERED) {
        ws.close(1011, 'backpressure: send buffer overflow')
        continue
      }
      /**
       * send 带回调：连接已死但 readyState 尚未更新的竞态下，send 内部会回调报错，
       * 不带回调时 ws 库会抛同步异常。回调吞掉错误（close 回调统一清理死连接）。
       */
      ws.send(text, () => {})
    }
  }

  /**
   * 每个控制台连接的 watcher 偏好（面板级按需采集）
   *
   * key = 控制台 ws，value = 该控制台当前观看的设备 + 启用的 watcher 集合。
   * 控制台切换面板时发 set-watchers 更新此偏好。
   */
  const consoleWatcherPrefs = new Map<WebSocket, { deviceId: string; watchers: Set<string> }>()

  /**
   * 汇总某设备所有订阅控制台的 watcher 偏好，取并集
   *
   * 多个控制台可能同时看不同面板（一个看 Storage，一个看 Element），
   * 设备端需要启用所有控制台请求的 watcher 的并集。
   */
  function mergeDeviceWatchers(deviceId: string): string[] {
    const merged = new Set<string>()
    for (const [, pref] of consoleWatcherPrefs) {
      if (pref.deviceId === deviceId) {
        for (const w of pref.watchers) merged.add(w)
      }
    }
    return [...merged]
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
    /** 清理 watcher 偏好，并通知设备端更新（可能需要关闭某些 watcher） */
    const pref = consoleWatcherPrefs.get(ws)
    consoleWatcherPrefs.delete(ws)
    if (pref) {
      const merged = mergeDeviceWatchers(pref.deviceId)
      const device = registry.get(pref.deviceId)
      if (device && device.ws.readyState === device.ws.OPEN) {
        device.ws.send(JSON.stringify({ type: 'set-watchers', watchers: merged }))
      }
    }
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
            /** 从 WS 连接的鉴权上下文获取 projectId */
            const wsAuthCtx = (ws as unknown as { __authCtx?: AuthContext }).__authCtx
            const info: DeviceInfo = {
              ...msg.device,
              id: deviceId,
              /** 鉴权模式下，projectId 由 server 从鉴权上下文注入（不由 SDK 决定） */
              projectId: wsAuthCtx?.projectId ?? msg.device.projectId,
              onlineAt: Date.now(),
              /** 兼容未上报 tags 的旧 SDK */
              tags: msg.device.tags ?? [],
              note: msg.device.note,
            }
            device = registry.register(info, ws)
            deviceSockets.set(ws, device)
            /** 广播设备列表更新给所有控制台（用 register 合并后的最新 info） */
            broadcast(deviceId, {
              type: 'device-online',
              device: device.info,
            })
            notifyDeviceListChanged()
            break
          }
          case 'update-info': {
            /** SPA 路由变化：SDK 上报新 url/title/icon，server 更新元信息并通知控制台 */
            if (!device) return
            registry.updateInfo(deviceId, {
              url: msg.device.url,
              title: msg.device.title,
              icon: msg.device.icon,
              viewportWidth: msg.device.viewportWidth,
              viewportHeight: msg.device.viewportHeight,
              deviceType: msg.device.deviceType,
            })
            broadcast(deviceId, {
              type: 'device-online',
              device: device.info,
            })
            /** 通知所有控制台刷新设备列表（title/icon/url 变化要反映到侧边栏） */
            notifyDeviceListChanged()
            break
          }
          case 'log': {
            if (!device) return
            device.logs.push(msg.log)
            broadcast(deviceId, { type: 'log', deviceId, log: msg.log })
            break
          }
          case 'log-repeat': {
            /**
             * 连续重复日志：最后一条 repeat +1（不发新条目）。
             * SDK 检测到与上一条 type+message 完全相同时不发 log，只发 log-repeat，
             * 避免循环/spam 日志占满环形缓冲区挤掉有价值的诊断日志。
             */
            if (!device) return
            const last = device.logs.last()
            if (last) {
              last.repeat = (last.repeat ?? 1) + 1
              broadcast(deviceId, { type: 'log-repeat', deviceId })
            }
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
          case 'ws-frame': {
            /**
             * WebSocket 帧追加（send/recv/event）：按 seq 找到 WS 连接条目，
             * 追加帧到 frames（上限 50 FIFO），广播让 console 增量更新。
             * 与 log-repeat 同模式：seq 稳定，只发增量，不重发整个 entry。
             */
            if (!device) return
            const wsEntry = device.network.findBySeq(msg.seq)
            if (wsEntry && wsEntry.protocol === 'ws') {
              if (!wsEntry.frames) wsEntry.frames = []
              wsEntry.frames.push(msg.frame)
              /** 上限 50 帧 FIFO，超出移除最早（防长连接刷爆体积） */
              if (wsEntry.frames.length > 50) wsEntry.frames.shift()
              broadcast(deviceId, { type: 'ws-frame', deviceId, seq: msg.seq, frame: msg.frame })
            }
            break
          }
          case 'ws-state': {
            /** WebSocket readyState 变化（CONNECTING→OPEN→CLOSING→CLOSED） */
            if (!device) return
            const wsEntry = device.network.findBySeq(msg.seq)
            if (wsEntry && wsEntry.protocol === 'ws') {
              wsEntry.wsState = msg.wsState
              /** status 字段同步 readyState，列表展示一致 */
              wsEntry.status = msg.wsState
              broadcast(deviceId, { type: 'ws-state', deviceId, seq: msg.seq, wsState: msg.wsState })
            }
            break
          }
          case 'sse-event': {
            /**
             * SSE 事件追加：按 seq 找到 SSE 连接条目，追加事件到 events（上限 50 FIFO），
             * 广播让 console 增量更新。与 ws-frame 同模式。
             *
             * 特殊事件 `__closed__` 表示 SSE 流结束（reader done），更新 sseState。
             */
            if (!device) return
            const sseEntry = device.network.findBySeq(msg.seq)
            if (sseEntry && sseEntry.sseState) {
              if (msg.event.event === '__closed__') {
                sseEntry.sseState = 'closed'
              } else {
                if (!sseEntry.events) sseEntry.events = []
                sseEntry.events.push(msg.event)
                if (sseEntry.events.length > 50) sseEntry.events.shift()
              }
              broadcast(deviceId, { type: 'sse-event', deviceId, seq: msg.seq, event: msg.event })
            }
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
            /** 错误数变化会改变设备列表状态（红条/计数），推送更新 */
            notifyDeviceListChanged()
            break
          }
          case 'snapshot': {
            /** 快照不存缓冲区（体积大、时效性强），直接转发给控制台 */
            if (!device) return
            /** 快照请求通常是 exec 触发的，由 exec-bridge 处理，这里仅转发 */
            break
          }
          case 'screen-frame': {
            /** 屏幕共享帧：直接转发给订阅了该设备的控制台（不存缓冲，体积大时效性强） */
            if (!device) return
            broadcast(deviceId, { type: 'screen-frame', deviceId, frame: msg.frame })
            break
          }
          case 'screen-share-status': {
            /** 屏幕共享状态变化（等待授权/共享中/被拒绝等）：转发给控制台 */
            if (!device) return
            broadcast(deviceId, { type: 'screen-share-status', deviceId, status: msg.status })
            break
          }
          case 'exec-result': {
            if (!device) return
            const entry = device.pendingExecs.get(msg.execId)
            if (entry) {
              clearTimeout(entry.timer)
              entry.resolve(msg.result)
              device.pendingExecs.delete(msg.execId)
            }
            break
          }
          case 'storage-change': {
            /** 远程设备 storage 变化（SDK 劫持 setItem/removeItem 触发），转发给控制台实时刷新 */
            if (!device) return
            broadcast(deviceId, {
              type: 'storage-change',
              deviceId,
              storageType: msg.storageType,
              key: msg.key,
              timestamp: msg.timestamp,
            })
            break
          }
          case 'dom-change': {
            /** 远程设备 DOM 变化（SDK MutationObserver 触发），转发给控制台 Element 面板实时刷新 */
            if (!device) return
            broadcast(deviceId, {
              type: 'dom-change',
              deviceId,
              changes: msg.changes,
            })
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

      /** 控制台连上后立即推送当前设备列表（按项目过滤） */
      const consoleAuthCtx = (ws as unknown as { __authCtx?: AuthContext }).__authCtx
      const consoleProjectId = consoleAuthCtx?.role === 'project' ? consoleAuthCtx.projectId : undefined
      ws.send(
        JSON.stringify({
          type: 'device-list',
          devices: registry.listByProject(consoleProjectId),
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
          case 'set-watchers': {
            /** 控制台通知当前打开的面板，server 汇总所有控制台的 watcher 后下发合并结果 */
            consoleWatcherPrefs.set(ws, { deviceId: msg.deviceId, watchers: new Set(msg.watchers) })
            /** 重新计算该设备的 watcher 并集 */
            const merged = mergeDeviceWatchers(msg.deviceId)
            const device = registry.get(msg.deviceId)
            if (device && device.ws.readyState === device.ws.OPEN) {
              device.ws.send(JSON.stringify({ type: 'set-watchers', watchers: merged }))
            }
            break
          }
          case 'ping': {
            /** 应用层心跳响应（浏览器 WebSocket 无法发 ping 帧） */
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' } satisfies ServerToConsoleMessage))
            }
            break
          }
          case 'start-screen-share': {
            /** 控制台请求设备开始屏幕共享（用户侧弹出授权弹窗） */
            const device = registry.get(msg.deviceId)
            if (device && device.ws.readyState === device.ws.OPEN) {
              device.ws.send(JSON.stringify({ type: 'start-screen-share' }))
            }
            break
          }
          case 'stop-screen-share': {
            /** 控制台请求设备停止屏幕共享 */
            const device = registry.get(msg.deviceId)
            if (device && device.ws.readyState === device.ws.OPEN) {
              device.ws.send(JSON.stringify({ type: 'stop-screen-share' }))
            }
            break
          }
        }
      })

      ws.on('close', () => unsubscribeAll(ws))
    }
  })

  /** 设备列表变化时推送给所有控制台（按项目隔离） */
  function notifyDeviceListChanged() {
    for (const ws of consoleSubscriptions.keys()) {
      if (ws.readyState !== ws.OPEN) continue
      /** 每个控制台只收到它有权访问的设备列表 */
      const ctx = (ws as unknown as { __authCtx?: AuthContext }).__authCtx
      const pid = ctx?.role === 'project' ? ctx.projectId : undefined
      const msg: ServerToConsoleMessage = { type: 'device-list', devices: registry.listByProject(pid) }
      /** 加错误回调防 send 抛异常中断循环（与 broadcast 保持一致） */
      ws.send(JSON.stringify(msg), () => {})
    }
  }

  /**
   * WS 心跳：每 30s ping 所有连接，检测脏断开（移动端弱网/TCP 未正常关闭）。
   * 每个连接标记 alive，ping 后删除标记，收到 pong 重新标记。
   * 下个周期仍无标记 → 连接已死，terminate 强制清理（触发 close → 下线）。
   */
  const HEARTBEAT_INTERVAL = 30000
  const aliveSet = new WeakSet<WebSocket>()

  /** 新连接默认存活 + 监听 pong */
  wss.on('connection', (ws) => {
    aliveSet.add(ws)
    ws.on('pong', () => aliveSet.add(ws))
  })

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.readyState !== ws.OPEN) return
      if (!aliveSet.has(ws)) {
        /** 上个周期 ping 后没收到 pong → 脏断开，强制关闭 */
        ws.terminate()
        return
      }
      aliveSet.delete(ws)
      ws.ping()
    })
  }, HEARTBEAT_INTERVAL)

  /** server 关闭时清理心跳定时器 */
  wss.on('close', () => clearInterval(interval))

  return { notifyDeviceListChanged }
}
