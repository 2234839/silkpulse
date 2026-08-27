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

import type { WebSocketBehavior } from 'uWebSockets.js'
import type { DeviceRegistry, Device } from './device-registry.js'
import type { AuthContext } from './auth.js'
import { SilkWs, getSilk, type WsUserData } from './uws/ws-socket.js'
import type {
  DeviceMessage,
  ServerToConsoleMessage,
  ConsoleMessage,
  DeviceInfo,
} from '@silkpulse/shared'

/** 广播可观测性：发送/截断计数，供 health 端点读取，压测用 */
export const fanoutStats = { sent: 0, skippedClosed: 0, skippedProject: 0, backpressureClosed: 0 }

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
  registry: DeviceRegistry,
  auth: { authorizeWsConnection: (url: string, wsPath: string) => AuthContext; isAuthEnabled: () => boolean }
): { behavior: WebSocketBehavior<WsUserData>; notifyDeviceListChanged: () => void } {
  /** 每个 WS 连接对应的设备 ID（设备端）或订阅集合（控制台端） */
  const deviceSockets = new Map<SilkWs, Device>()
  /** 控制台订阅：consoleWs → Set<deviceId>，以及反向映射 device → Set<consoleWs> */
  const consoleSubscriptions = new Map<SilkWs, Set<string>>()
  const deviceWatchers = new Map<string, Set<SilkWs>>()

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
      if (ws.readyState !== ws.OPEN) {
        fanoutStats.skippedClosed++
        continue
      }
      /** 项目隔离：项目级控制台只能收到自己项目设备的数据 */
      const ctx = ws.authCtx
      if (ctx?.role === 'project' && ctx.projectId !== deviceProjectId) {
        fanoutStats.skippedProject++
        continue
      }
      /** 背压保护：积压超限的连接直接关闭，不再塞数据 */
      if (ws.bufferedAmount > MAX_BUFFERED) {
        fanoutStats.backpressureClosed++
        ws.end(1011, 'backpressure: send buffer overflow')
        continue
      }
      /** close 后 send 自动 no-op（竞态安全，close 回调统一清理死连接） */
      ws.send(text)
      fanoutStats.sent++
    }
  }

  /**
   * 每个控制台连接的 watcher 偏好（面板级按需采集）
   *
   * key = 控制台 ws，value = 该控制台当前观看的设备 + 启用的 watcher 集合。
   * 控制台切换面板时发 set-watchers 更新此偏好。
   */
  const consoleWatcherPrefs = new Map<SilkWs, { deviceId: string; watchers: Set<string> }>()

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
  function unsubscribeAll(ws: SilkWs) {
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
      const sock = device?.latestSocket
      if (sock && sock.readyState === sock.OPEN) {
        sock.send(JSON.stringify({ type: 'set-watchers', watchers: merged }))
      }
    }
  }

  /**
   * uWS WebSocket 行为定义（设备/控制台共用，靠 open 时的 url 区分）
   *
   * idleTimeout=32 + sendPingsAutomatically：协议层心跳（等价旧版 30s ping 循环，
   * 浏览器自动回 pong 刷新 idle 计时，脏断开 32s 内被强制清理）。
   * maxBackpressure=1MB：uWS 原生背压上限，超限直接断慢消费者。
   */
  const behavior: WebSocketBehavior<WsUserData> = {
    idleTimeout: 32,
    sendPingsAutomatically: true,
    maxBackpressure: MAX_BUFFERED,
    maxPayloadLength: 4 * 1024 * 1024,

    open: (ws) => {
      const silk = getSilk(ws)
      handleOpen(silk)
    },
    message: (ws, message) => {
      const silk = getSilk(ws)
      /** uWS message 是 ArrayBuffer（回调返回后被 neuter），立刻转字符串 */
      let raw: string
      try {
        raw = Buffer.from(message).toString()
      } catch {
        return
      }
      handleMessage(silk, raw)
    },
    close: (ws) => {
      const silk = getSilk(ws)
      silk.closed = true
      /** 摘除连接：还有其他活连接（多标签页）则设备仍在线；
       *  最后一条断开走宽限期（reload 窗口内重连无缝续接，不丢历史缓冲） */
      const closeUrl = new URL(getUrlFromSocket(silk), 'http://localhost')
      if (closeUrl.pathname === '/ws/device') {
        const state = deviceStates.get(silk)
        if (state?.deviceId) {
          registry.detachSocket(state.deviceId, silk)
        }
        deviceStates.delete(silk)
      }
      if (closeUrl.pathname === '/ws/console') {
        unsubscribeAll(silk)
      }
    },
  }

  /** ---------- 连接生命周期处理 ---------- */
  function handleOpen(silk: SilkWs) {
    const url = new URL(getUrlFromSocket(silk), 'http://localhost')
    const pathname = url.pathname

    /** ---------- 设备端连接 ---------- */
    if (pathname === '/ws/device') {
      deviceStates.set(silk, { deviceId: '', device: undefined })
    }

    /** ---------- 控制台连接 ---------- */
    if (pathname === '/ws/console') {
      consoleSubscriptions.set(silk, new Set())

      /** 控制台连上后立即推送当前设备列表（按项目过滤） */
      const consoleProjectId = silk.authCtx.role === 'project' ? silk.authCtx.projectId : undefined
      silk.send(
        JSON.stringify({
          type: 'device-list',
          devices: registry.listByProject(consoleProjectId),
        } satisfies ServerToConsoleMessage)
      )
    }
  }

  /** 每个设备连接的状态（device 路径专用） */
  const deviceStates = new Map<SilkWs, { deviceId: string; device: Device | undefined }>()

  function handleMessage(silk: SilkWs, raw: string): void {
    const url = new URL(getUrlFromSocket(silk), 'http://localhost')
    const pathname = url.pathname

    /** ---------- 设备端消息 ---------- */
    if (pathname === '/ws/device') {
      const state = deviceStates.get(silk)
      if (!state) return
      let { deviceId } = state
      let { device } = state

      {
        let msg: DeviceMessage
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }

        {
          switch (msg.type) {
          case 'register': {
            /** 设备首次注册：分配/复用 id，建立映射 */
            deviceId = msg.device.id || generateDeviceId()
            /** 从 WS 连接的鉴权上下文获取 projectId */
            const wsAuthCtx = silk.authCtx
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
            const registered = registry.register(info, silk, msg.sessionToken ?? '')
            if (!registered) {
              /** deviceId 已被另一个活着的标签页占用（复制标签页，Web Locks 不可用时的
               *  server 端仲裁）：告知设备换新 id 重连。此连接不再接受消息。 */
              silk.send(JSON.stringify({ type: 'device-id-conflict' } satisfies import('@silkpulse/shared').ServerToDeviceMessage))
              return
            }
            device = registered
            deviceSockets.set(silk, device)
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
              /** 框架探测结果（DevTools 面板自动选插件用，SPA 路由变化后可能更新） */
              frameworks: msg.device.frameworks,
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
          case 'network-update': {
            /**
             * 已有 entry 的增量更新（loading→done、流式 body 追加）
             * 按 seq 找到 entry 合并 patch 字段，广播让 console 同步更新
             */
            if (!device) return
            const existing = device.network.findBySeq(msg.seq)
            if (existing) {
              Object.assign(existing, msg.patch)
              broadcast(deviceId, {
                type: 'network-update',
                deviceId,
                seq: msg.seq,
                patch: msg.patch,
              })
            }
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
          case 'network-body': {
            /** 设备返回完整 body（懒加载响应），转发给订阅该设备的控制台 */
            if (!device) return
            /**
             * 服务端防线：单条 body 超过硬上限就拒发。
             * SDK 层有同款限制，但设备可能跑旧版 SDK 或被恶意仿冒——
             * 不能信任采集端已裁剪；否则一个超大帧能把所有订阅控制台的
             * 解析和 Vue 响应式状态一起拖崩（MAX_BUFFERED 只在超时后才踢线）。
             */
            const bodyText = msg.body
            if (typeof bodyText !== 'string' || bodyText.length > NETWORK_BODY_HARD_MAX) {
              broadcast(deviceId, {
                type: 'network-body',
                deviceId,
                bodySeq: msg.bodySeq,
                body: `[body 过大或类型非法，服务端拒发：${typeof bodyText === 'string' ? `${bodyText.length} 字符` : typeof bodyText}]`,
              })
              break
            }
            broadcast(deviceId, { type: 'network-body', deviceId, bodySeq: msg.bodySeq, body: msg.body })
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
          case 'device-mouse': {
            /** 远端设备鼠标/触摸事件，转发给控制台渲染虚拟光标 */
            if (!device) return
            broadcast(deviceId, {
              type: 'device-mouse',
              deviceId,
              mouse: msg.mouse,
            })
            break
          }
          case 'devtools-relay': {
            /** devtools backend RPC 消息（vue/react）：透传给订阅该设备的控制台（不存缓冲，时效性强） */
            if (!device) return
            broadcast(deviceId, { type: 'devtools-relay', deviceId, plugin: msg.plugin, payload: msg.payload })
            break
          }
        }
        /** 写回 per-socket state（deviceId/device 随 register 更新） */
        state.deviceId = deviceId
        state.device = device
        }
      }
      return
    }

    /** ---------- 控制台消息 ---------- */
    if (pathname === '/ws/console') {
      /**
       * 设备归属校验：项目级控制台只能对自己项目的设备发指令
       *
       * subscribe/set-watchers/start-screen-share/get-network-body/devtools-relay
       * 全部经此入口；未通过时静默忽略（不回报，避免给越权探测者反馈设备存在性）。
       * admin 角色与未启用鉴权时放行（与 broadcast 的项目过滤同规则）。
       */
      const canAccess = (deviceId: string): boolean => {
        const ctx = silk.authCtx
        if (!ctx || ctx.role === 'admin') return true
        if (ctx.role !== 'project') return false
        const target = registry.get(deviceId)
        return target ? ctx.projectId === target.info.projectId : false
      }
      {
        let msg: ConsoleMessage
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }
        const ws = silk
        switch (msg.type) {
          case 'subscribe': {
            if (!canAccess(msg.deviceId)) break
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
            if (!canAccess(msg.deviceId)) break
            /** 控制台通知当前打开的面板，server 汇总所有控制台的 watcher 后下发合并结果 */
            consoleWatcherPrefs.set(ws, { deviceId: msg.deviceId, watchers: new Set(msg.watchers) })
            /** 重新计算该设备的 watcher 并集 */
            const merged = mergeDeviceWatchers(msg.deviceId)
            const device = registry.get(msg.deviceId)
            const sock = device?.latestSocket
            if (sock && sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify({ type: 'set-watchers', watchers: merged }))
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
            if (!canAccess(msg.deviceId)) break
            const device = registry.get(msg.deviceId)
            const sock = device?.latestSocket
            if (sock && sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify({ type: 'start-screen-share' }))
            }
            break
          }
          case 'stop-screen-share': {
            /** 控制台请求设备停止屏幕共享 */
            if (!canAccess(msg.deviceId)) break
            const device = registry.get(msg.deviceId)
            const sock = device?.latestSocket
            if (sock && sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify({ type: 'stop-screen-share' }))
            }
            break
          }
          case 'get-network-body': {
            /** 控制台请求完整 body（懒加载），转发给设备 */
            if (!canAccess(msg.deviceId)) break
            const device = registry.get(msg.deviceId)
            const sock = device?.latestSocket
            if (sock && sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify({ type: 'get-network-body', bodySeq: msg.bodySeq }))
            }
            break
          }
          case 'devtools-relay': {
            /** 控制台 devtools client 的 RPC 消息，透传给对应设备（发 latestSocket：指令类消息单点送达） */
            if (!canAccess(msg.deviceId)) break
            const device = registry.get(msg.deviceId)
            const sock = device?.latestSocket
            if (sock && sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify({ type: 'devtools-relay', plugin: msg.plugin, payload: msg.payload }))
            }
            break
          }
        }
      }
    }
  }

  /** 设备列表变化时推送给所有控制台（按项目隔离） */
  function notifyDeviceListChanged() {
    for (const ws of consoleSubscriptions.keys()) {
      if (ws.readyState !== ws.OPEN) continue
      /** 每个控制台只收到它有权访问的设备列表 */
      const ctx = ws.authCtx
      const pid = ctx?.role === 'project' ? ctx.projectId : undefined
      const msg: ServerToConsoleMessage = { type: 'device-list', devices: registry.listByProject(pid) }
      /** close 后 send 自动 no-op（与 broadcast 保持一致） */
      ws.send(JSON.stringify(msg))
    }
  }

  /**
   * registry 事件 → 控制台推送
   *
   * 主要补宽限期超时下线路径：detachSocket 的 setTimeout 里 unregister
   * 不经过 ws-relay 的 close 回调，没有这里订阅的话设备列表会出现幽灵设备。
   */
  registry.onChange((event) => {
    if (event.type === 'offline') {
      notifyDeviceListChanged()
      return
    }
    if (event.type === 'reconnect') {
      /** 页面 reload 重连：通知所有订阅该设备的控制台重载 devtools 面板（重新握手 backend） */
      broadcast(event.device.id, {
        type: 'device-reconnect',
        deviceId: event.device.id,
      })
    }
  })

  return { behavior, notifyDeviceListChanged }
}

/**
 * 从 SilkWs 取连接时的完整 URL
 *
 * uWS 不在 open 回调里直接给 URL —— upgrade 阶段把 URL 存进 UserData（见 index.ts），
 * 这里读出来解析路径。
 */
export function getUrlFromSocket(silk: SilkWs): string {
  return socketUrls.get(silk) ?? '/'
}

/** SilkWs → 连接 URL（upgrade 阶段由 index.ts 注册） */
const socketUrls = new WeakMap<SilkWs, string>()

/**
 * 单条 network body 转发硬上限（字符数）
 *
 * SDK 侧有同款限制（BODY_HARD_MAX），但设备可能跑旧版 SDK 或被恶意仿冒，
 * 服务端必须有自己的防线：超限帧直接替换为提示文本转发。
 */
const NETWORK_BODY_HARD_MAX = 2 * 1024 * 1024

/** 注册连接 URL（upgrade 阶段调用，open 回调前） */
export function registerSocketUrl(silk: SilkWs, url: string): void {
  socketUrls.set(silk, url)
}


