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
  ServerToConsoleMessage,
} from '@clarosight/shared'

export function useConsoleSocket() {
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

  /** 切换选中的设备（订阅实时数据 + 拉取历史缓冲区） */
  async function selectDevice(id: string | null) {
    selectedDeviceId.value = id
    logs.value = []
    network.value = []
    errors.value = []
    storageKeyTimes.value = {}
    if (!id) return
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', deviceId: id }))
    }
    /** 同时拉取 server 端环形缓冲区的历史数据，让用户立即看到选中前的请求/日志 */
    try {
      const [logsRes, netRes, errRes] = await Promise.all([
        fetch(`/api/devices/${id}/logs`),
        fetch(`/api/devices/${id}/network`),
        fetch(`/api/devices/${id}/errors`),
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
    const url = `${proto}//${location.host}/ws/console`
    ws = new WebSocket(url)

    ws.onopen = () => {
      connected.value = true
    }

    ws.onclose = () => {
      connected.value = false
      /** 断线 2s 重连（跟踪句柄，卸载时清理防幽灵连接） */
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, 2000)
    }

    ws.onmessage = (ev) => {
      let msg: ServerToConsoleMessage
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      handleMessage(msg)
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
        }
        break
      case 'log':
        if (msg.deviceId === selectedDeviceId.value) {
          logs.value = [...logs.value, msg.log].slice(-200)
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
          network.value = [...network.value, msg.entry].slice(-50)
        }
        break
      case 'ws-frame': {
        /** WebSocket 帧追加：按 seq 找到 WS 连接条目，追加帧（浅拷贝触发响应式） */
        if (msg.deviceId === selectedDeviceId.value) {
          const arr = network.value.slice()
          const entry = arr.find((n) => n.seq === msg.seq)
          if (entry && entry.protocol === 'ws') {
            const frames = [...(entry.frames ?? []), msg.frame].slice(-50)
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
      case 'error':
        if (msg.deviceId === selectedDeviceId.value) {
          errors.value = [...errors.value, msg.error].slice(-50)
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
    }
  }

  onUnmounted(() => {
    /** 清理重连定时器，防止卸载后建立幽灵 WS 连接 */
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
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
    selectedDeviceId,
    connected,
    connect,
    selectDevice,
    setWatchers,
  }
}
