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

  /** 切换选中的设备（订阅该设备的实时数据） */
  function selectDevice(id: string | null) {
    selectedDeviceId.value = id
    logs.value = []
    network.value = []
    errors.value = []
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (id) {
      ws.send(JSON.stringify({ type: 'subscribe', deviceId: id }))
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
      case 'device-online':
        if (!devices.value.some((d) => d.id === msg.device.id)) {
          devices.value = [...devices.value, msg.device]
        }
        break
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
