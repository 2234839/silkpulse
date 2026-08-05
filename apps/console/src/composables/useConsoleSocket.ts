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
  /** 当前选中设备 id */
  const selectedDeviceId = ref<string | null>(null)
  /** 连接状态 */
  const connected = ref(false)

  let ws: WebSocket | null = null

  /** 切换选中的设备（订阅实时数据 + 拉取历史缓冲区） */
  async function selectDevice(id: string | null) {
    selectedDeviceId.value = id
    logs.value = []
    network.value = []
    errors.value = []
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
      /** 断线 2s 重连 */
      setTimeout(() => connect(), 2000)
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
      case 'network':
        if (msg.deviceId === selectedDeviceId.value) {
          network.value = [...network.value, msg.entry].slice(-50)
        }
        break
      case 'error':
        if (msg.deviceId === selectedDeviceId.value) {
          errors.value = [...errors.value, msg.error].slice(-50)
        }
        break
    }
  }

  onUnmounted(() => {
    ws?.close()
  })

  return {
    devices,
    logs,
    network,
    errors,
    selectedDeviceId,
    connected,
    connect,
    selectDevice,
  }
}
