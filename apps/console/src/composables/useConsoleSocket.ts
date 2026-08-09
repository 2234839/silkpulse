/**
 * useConsoleSocket —— 控制台 WebSocket 连接 hook
 *
 * 连接 /ws/console，订阅设备实时数据：
 * - 设备列表（上线/下线事件）
 * - 选中设备的 log/network/error 实时推送
 */
import { ref, shallowRef, onUnmounted } from 'vue'
import type {
  DeviceInfo,
  LogEntry,
  NetworkEntry,
  ErrorEntry,
  ScreenFrame,
  ScreenShareStatus,
  MouseEventData,
  ServerToConsoleMessage,
} from '@silkpulse/shared'
import { useAuth } from './useAuth'
import { apiFetch } from '../utils/api'

export function useConsoleSocket() {
  const { apiKey } = useAuth()
  /** 所有在线设备 */
  const devices = ref<DeviceInfo[]>([])
  /** 当前选中设备的实时日志 */
  const logs = shallowRef<LogEntry[]>([])
  /** 当前选中设备的实时 network */
  const network = shallowRef<NetworkEntry[]>([])
  /** 当前选中设备的实时错误 */
  const errors = shallowRef<ErrorEntry[]>([])
  /**
   * storage 变化版本号
   *
   * 收到远程设备 storage-change 推送时递增，StoragePanel watch 它自动重新拉取。
   * 用版本号而非直接传数据：storage 数据量大（IndexedDB 可能几百条），
   * 推送只做信号，拉取走 HTTP（可分页/缓存）。
   */
  const storageVersion = ref(0)
  /** 最后一次 storage 变化的时间戳（面板显示用） */
  const storageUpdateTime = ref<number | null>(null)
  /**
   * DOM 变化版本号（每次收到 dom-change 推送时递增）
   *
   * ElementPanel watch 它判断是否需要刷新已展开节点。
   * 同时携带 parentIdxs + kinds 供 ElementPanel 精确刷新 + 高亮。
   */
  const domChangeVersion = ref(0)
  /** 最近一次 DOM 变化的详细数据（parentIdxs + kinds + timestamp） */
  const domChangeData = ref<{
    parentIdxs: number[]
    kinds: Array<'added' | 'removed' | 'attributes' | 'text'>
    timestamp: number
  } | null>(null)

  /** 最新的屏幕共享帧（ElementPanel watch 后用 FrameCompositor 合成到 canvas） */
  const screenFrame = shallowRef<ScreenFrame | null>(null)
  /** 远端设备屏幕共享状态 */
  const screenShareStatus = shallowRef<ScreenShareStatus | null>(null)
  /**
   * 远端设备最新鼠标事件（归一化坐标 0~1）
   *
   * ElementPanel watch 它在画面/布局预览上渲染虚拟光标。
   * 用 shallowRef：鼠标 move 频率高，浅比较避免深层响应式开销。
   */
  const deviceMouse = shallowRef<MouseEventData | null>(null)
  /**
   * 每个 storage key 的最后修改时间戳（运行期间 SDK 捕获）
   *
   * key = `${storageType}::${storageKey}`，值 = timestamp。
   * 只在 SDK 运行期间有效（页面刷新后重置），不需要持久化。
   */
  const storageKeyTimes = ref<Record<string, number>>({})
  /** 当前选中设备 id */
  const selectedDeviceId = ref<string | null>(null)
  /** 连接状态 */
  const connected = ref(false)

  let ws: WebSocket | null = null
  /**
   * 重连定时器句柄
   *
   * 必须跟踪，否则组件卸载后已调度的重连仍会触发，建立幽灵 WS 连接。
   * 与 SDK ws-client 的同类修复一致：定时器生命周期要显式管理。
   */
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * 重连退避计数器
   *
   * 连续失败时延迟递增（2→4→8→16→30s 上限），避免 server 恢复瞬间连接风暴。
   * 成功连接后重置为 0。
   */
  let reconnectAttempts = 0
  /**
   * 应用层心跳定时器
   *
   * 浏览器 WebSocket API 无法发 ping 帧，只能靠应用层消息做心跳。
   * 每 25s 发 {type:'ping'}，server 回 {type:'pong'}，
   * 超过 35s 未收到 pong → 主动 close 触发重连（检测半开连接）。
   */
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  /** 上次收到 pong 的时间戳 */
  let lastPongTime = Date.now()
  /** 是否主动关闭（组件卸载），避免 close 后重连 */
  let intentionalClose = false

  /** 上次选中的设备 ID（切换设备时先 unsubscribe 旧设备） */
  let lastSubscribedDeviceId: string | null = null

  /** 切换选中的设备（订阅实时数据 + 拉取历史缓冲区） */
  async function selectDevice(id: string | null) {
    selectedDeviceId.value = id
    logs.value = []
    network.value = []
    errors.value = []
    screenShareStatus.value = null
    storageKeyTimes.value = {}
    /** 先取消订阅旧设备，避免带宽浪费（server 会保留旧订阅） */
    if (ws && ws.readyState === WebSocket.OPEN && lastSubscribedDeviceId && lastSubscribedDeviceId !== id) {
      ws.send(JSON.stringify({ type: 'unsubscribe', deviceId: lastSubscribedDeviceId }))
    }
    lastSubscribedDeviceId = id
    if (!id) return
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', deviceId: id }))
    }
    /** 同时拉取 server 端环形缓冲区的历史数据，让用户立即看到选中前的请求/日志 */
    try {
      const [logsRes, netRes, errRes] = await Promise.all([
        apiFetch(`/api/devices/${id}/logs`),
        apiFetch(`/api/devices/${id}/network`),
        apiFetch(`/api/devices/${id}/errors`),
      ])
      logs.value = await logsRes.json()
      network.value = await netRes.json()
      errors.value = await errRes.json()
    } catch {
      /** 拉取失败时保持空，WS 推送仍会补充新数据 */
    }
  }

  /**
   * 通知 server 当前启用的 watcher（按需采集）
   *
   * 控制台打开 Storage/Element 面板时调用，传入对应 watcher 类型。
   * server 汇总所有控制台的请求后，下发 set-watchers 给设备 SDK，
   * 设备端按需启停 MutationObserver / storage 劫持等。
   */
  function setWatchers(deviceId: string, watchers: string[]): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-watchers', deviceId, watchers }))
    }
  }

  /** 连接 server */
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    /** 鉴权模式下在 WS URL query 中携带 token */
    const wsParams = new URLSearchParams()
    if (apiKey.value) wsParams.set('token', apiKey.value)
    const queryStr = wsParams.toString()
    const url = `${proto}//${location.host}/ws/console${queryStr ? '?' + queryStr : ''}`
    intentionalClose = false
    ws = new WebSocket(url)

    ws.onopen = () => {
      connected.value = true
      /** 重置退避计数器 */
      reconnectAttempts = 0
      /** 重连后恢复之前选中的设备订阅 */
      if (lastSubscribedDeviceId) {
        ws!.send(JSON.stringify({ type: 'subscribe', deviceId: lastSubscribedDeviceId }))
      }
      /** 启动应用层心跳（每 25s 发 ping） */
      lastPongTime = Date.now()
      startHeartbeat()
    }

    ws.onclose = () => {
      connected.value = false
      stopHeartbeat()
      /** 组件卸载时主动关闭，不再重连 */
      if (intentionalClose) return
      /** 指数退避重连：2→4→8→16→30s 上限 */
      const delay = Math.min(2000 * 2 ** reconnectAttempts, 30000)
      reconnectAttempts++
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, delay)
    }

    ws.onerror = () => {
      /** onerror 后必然触发 onclose，这里不做重连逻辑，
       *  但如果鉴权失败（403），onclose 的 wasClean 为 false 会继续重连 → 死循环。
       *  通过 onclose 里的退避机制限制频率，不额外处理。 */
    }

    ws.onmessage = (ev) => {
      let msg: ServerToConsoleMessage
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      /** 收到 pong 更新心跳时间戳 */
      if ((msg as { type?: string }).type === 'pong') {
        lastPongTime = Date.now()
        return
      }
      handleMessage(msg)
    }
  }

  /** 启动应用层心跳 */
  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      /** 检查上次 pong 是否超时（35s 未收到 → 半开连接） */
      if (Date.now() - lastPongTime > 35000) {
        ws.close()
        return
      }
      ws.send(JSON.stringify({ type: 'ping' }))
    }, 25000)
  }

  /** 停止心跳定时器 */
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  function handleMessage(msg: ServerToConsoleMessage) {
    switch (msg.type) {
      case 'device-list':
        devices.value = msg.devices
        break
      case 'device-online': {
        /** 新设备 → 追加；已存在 → 更新元信息（SPA 路由变化、tags 修改都会触发） */
        const idx = devices.value.findIndex((d) => d.id === msg.device.id)
        if (idx === -1) {
          devices.value = [...devices.value, msg.device]
        } else {
          const next = devices.value.slice()
          next[idx] = msg.device
          devices.value = next
        }
        break
      }
      case 'device-offline':
        devices.value = devices.value.filter((d) => d.id !== msg.deviceId)
        if (selectedDeviceId.value === msg.deviceId) {
          selectedDeviceId.value = null
          logs.value = []
          network.value = []
          errors.value = []
          screenShareStatus.value = null
        }
        break
      case 'log':
        if (msg.deviceId === selectedDeviceId.value) {
          logs.value = [...logs.value, msg.log]
        }
        break
      case 'log-repeat': {
        /** 连续重复日志：最后一条 repeat +1（浅拷贝触发 shallowRef 响应式） */
        if (msg.deviceId === selectedDeviceId.value && logs.value.length > 0) {
          const arr = logs.value.slice()
          const lastIdx = arr.length - 1
          const last = arr[lastIdx]
          arr[lastIdx] = { ...last, repeat: (last.repeat ?? 1) + 1 }
          logs.value = arr
        }
        break
      }
      case 'network':
        if (msg.deviceId === selectedDeviceId.value) {
          network.value = [...network.value, msg.entry]
        }
        break
      case 'network-update': {
        /** 已有 entry 的增量更新（loading→done）：按 seq 找到并合并 patch */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice()
          const idx = arr.findIndex((n) => n.seq === msg.seq)
          if (idx >= 0) {
            arr[idx] = { ...arr[idx], ...msg.patch }
            network.value = arr
          }
        }
        break
      }
      case 'ws-frame': {
        /** WebSocket 帧追加：按 seq 找到 WS 连接条目，追加帧（浅拷贝触发响应式） */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice()
          const entry = arr.find((n) => n.seq === msg.seq)
          if (entry && entry.protocol === 'ws') {
            const frames = [...(entry.frames ?? []), msg.frame]
            const idx = arr.indexOf(entry)
            arr[idx] = { ...entry, frames }
            network.value = arr
          }
        }
        break
      }
      case 'ws-state': {
        /** WebSocket readyState 变化：更新条目 wsState + status */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice()
          const entry = arr.find((n) => n.seq === msg.seq)
          if (entry && entry.protocol === 'ws') {
            const idx = arr.indexOf(entry)
            arr[idx] = { ...entry, wsState: msg.wsState, status: msg.wsState }
            network.value = arr
          }
        }
        break
      }
      case 'sse-event': {
        /** SSE 事件追加：按 seq 找到 SSE 连接条目，追加事件（浅拷贝触发响应式） */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice()
          const entry = arr.find((n) => n.seq === msg.seq)
          if (entry && entry.sseState) {
            const idx = arr.indexOf(entry)
            if (msg.event.event === '__closed__') {
              arr[idx] = { ...entry, sseState: 'closed' as const }
            } else {
              const events = [...(entry.events ?? []), msg.event]
              arr[idx] = { ...entry, events }
            }
            network.value = arr
          }
        }
        break
      }
      case 'error':
        if (msg.deviceId === selectedDeviceId.value) {
          errors.value = [...errors.value, msg.error]
        }
        break
      case 'storage-change':
        /**
         * 远程设备 storage 变化 → 递增版本号 + 记录时间 + 缓存 key 时间戳
         *
         * msg.key 可能不存在（clear() 无法确定具体 key），此时只刷新不记 key 时间。
         */
        if (msg.deviceId === selectedDeviceId.value) {
          storageVersion.value++
          const ts = msg.timestamp ?? Date.now()
          storageUpdateTime.value = ts
          if (msg.key) {
            storageKeyTimes.value = { ...storageKeyTimes.value, [`${msg.storageType}::${msg.key}`]: ts }
          }
        }
        break
      case 'dom-change':
        /** 远程设备 DOM 变化 → 递增版本号 + 携带 parentIdxs 供 ElementPanel 精确刷新 */
        if (msg.deviceId === selectedDeviceId.value) {
          domChangeVersion.value++
          domChangeData.value = msg.changes
        }
        break
      case 'screen-frame':
        /** 设备屏幕共享帧 → 更新 screenFrame（ElementPanel watch 合成） */
        if (msg.deviceId === selectedDeviceId.value) {
          screenFrame.value = msg.frame
        }
        break
      case 'screen-share-status':
        /** 设备屏幕共享状态变化（等待授权/共享中/被拒绝等） */
        if (msg.deviceId === selectedDeviceId.value) {
          screenShareStatus.value = msg.status
        }
        break
      case 'device-mouse':
        /** 远端鼠标/触摸事件 → 更新 deviceMouse（ElementPanel watch 渲染虚拟光标） */
        if (msg.deviceId === selectedDeviceId.value) {
          deviceMouse.value = msg.mouse
        }
        break
      case 'network-body': {
        /** 设备返回完整 body（懒加载）：合并到对应 entry */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice()
          const idx = arr.findIndex((n) => n.seq === msg.bodySeq)
          if (idx >= 0 && msg.body !== null) {
            /** body 可能是 reqBody 或 resBody，看原始 entry 哪个被截断 */
            const entry = arr[idx]
            arr[idx] = {
              ...entry,
              /** 覆盖被截断的字段，清除 truncated 标记 */
              resBody: entry.resBody ?? msg.body,
              reqBody: entry.bodyTruncated ? msg.body : entry.reqBody,
              bodyTruncated: false,
            }
            network.value = arr
          }
          /** 从 pending 中取出 callback */
          const cb = pendingBodyRequests.get(msg.bodySeq)
          if (cb) {
            pendingBodyRequests.delete(msg.bodySeq)
            cb(msg.body)
          }
        }
        break
      }
    }
  }

  /** 发送控制台消息到 server（start/stop screen-share 等） */
  function sendConsoleMessage(msg: import('@silkpulse/shared').ConsoleMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  /** 懒加载 body 请求的 pending callback 映射 */
  const pendingBodyRequests = new Map<number, (body: string | null) => void>()

  /**
   * 请求完整 body（懒加载）
   *
   * bodyTruncated=true 的 entry 调用此方法，通过 WS 请求设备返回完整 body。
   * 返回 Promise<string | null>，超时 5s 自动 resolve(null)。
   */
  function requestNetworkBody(deviceId: string, bodySeq: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBodyRequests.delete(bodySeq)
        resolve(null)
      }, 5000)

      pendingBodyRequests.set(bodySeq, (body) => {
        clearTimeout(timer)
        resolve(body)
      })

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'get-network-body', deviceId, bodySeq }))
      } else {
        clearTimeout(timer)
        pendingBodyRequests.delete(bodySeq)
        resolve(null)
      }
    })
  }

  onUnmounted(() => {
    /** 标记主动关闭，阻止 onclose 重连 */
    intentionalClose = true
    /** 清理重连定时器，防止卸载后建立幽灵 WS 连接 */
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    stopHeartbeat()
    ws?.close()
  })

  return {
    devices,
    logs,
    network,
    errors,
    storageVersion,
    storageUpdateTime,
    storageKeyTimes,
    domChangeVersion,
    domChangeData,
    screenFrame,
    screenShareStatus,
    deviceMouse,
    selectedDeviceId,
    connected,
    connect,
    selectDevice,
    setWatchers,
    sendConsoleMessage,
    requestNetworkBody,
  }
}
