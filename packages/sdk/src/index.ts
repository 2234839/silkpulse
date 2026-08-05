/**
 * clarosight SDK 入口 —— 装配所有采集器，连接 server
 *
 * 注入方式：
 * 1. IIFE 脚本：<script src="http://server/sdk.js"></script>（自动初始化）
 * 2. 主动调用：ClarosightSDK.init({ server: 'ws://localhost:8080' })
 *
 * 采集器：log-collector / network-collector / error-catcher
 * 通道：ws-client（上报 + exec 回传）
 */

import type { DeviceInfo, ServerToDeviceMessage, LogEntry, NetworkEntry, ErrorEntry } from '@clarosight/shared'
import { connect, send, onMessage, disconnect } from './ws-client.js'
import { installLogCollector } from './log-collector.js'
import { installNetworkCollector } from './network-collector.js'
import { installErrorCatcher, getErrorCount } from './error-catcher.js'
import { pushRecentError } from './snapshot.js'
import { installHelpers, setResultSender, handleExec } from './exec-runner.js'

/** deviceId 在 sessionStorage 的 key（同 tab 刷新不变） */
const DEVICE_ID_KEY = '__clarosight_device_id__'

/** 初始化选项 */
export interface InitOptions {
  /** server 根地址，如 http://localhost:8080（会自动拼 /ws/device） */
  server: string
  /** 是否在页面卸载时断开，默认 true */
  disconnectOnUnload?: boolean
}

/**
 * 生成或复用 deviceId（sessionStorage 持久化）
 */
function getDeviceId(): string {
  try {
    let id = sessionStorage.getItem(DEVICE_ID_KEY)
    if (!id) {
      id = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      sessionStorage.setItem(DEVICE_ID_KEY, id)
    }
    return id
  } catch {
    /** sessionStorage 不可用时（隐私模式）用内存 id */
    return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

/** 收集当前设备元信息 */
function collectDeviceInfo(id: string): DeviceInfo {
  return {
    id,
    url: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    errorCount: getErrorCount(),
    onlineAt: Date.now(),
  }
}

let initialized = false

/**
 * 初始化 SDK —— 装配采集器、连接 server、注册 exec 处理
 */
export function init(options: InitOptions): void {
  if (initialized) return
  initialized = true

  const deviceId = getDeviceId()
  const info = collectDeviceInfo(deviceId)

  /** 拼 WS 地址：server 可能是 http://host:port 或 ws://host:port */
  const wsBase = options.server.replace(/^http/, 'ws')
  const wsUrl = `${wsBase.replace(/\/$/, '')}/ws/device`

  /** 1. 装配采集器，每个 collector 的 sink → WS 上报 */
  installLogCollector((entry: LogEntry) => send({ type: 'log', log: entry }))
  installNetworkCollector((entry: NetworkEntry) => send({ type: 'network', entry }))
  installErrorCatcher((entry: ErrorEntry) => {
    pushRecentError(entry.message)
    send({ type: 'error', error: entry })
  })

  /** 2. 安装 exec 辅助函数（必须在 connect 前挂到 window） */
  installHelpers()

  /** 3. 注册 exec 结果回传器 */
  setResultSender((execId, result) => send({ type: 'exec-result', execId, result }))

  /** 4. 注册 server 消息处理器（目前只有 exec） */
  onMessage((msg: ServerToDeviceMessage) => {
    if (msg.type === 'exec') {
      handleExec(msg.code, msg.execId).catch(() => {
        /** handleExec 内部已捕获错误并回传，这里是兜底 */
      })
    }
  })

  /** 5. 连接 server */
  connect({ url: wsUrl, info })

  /** 6. 页面导航/SPA 路由变化时更新 url（只更新不上报，保持单连接） */
  let lastUrl = location.href
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
    }
  }, 1000)

  /** 7. 页面卸载断开 */
  if (options.disconnectOnUnload !== false) {
    window.addEventListener('beforeunload', () => disconnect())
  }
}

/**
 * 自动初始化（IIFE 注入模式）
 * 当 script 标签带 data-server 属性时，DOMContentLoaded 后自动 init
 * <script src="http://server/sdk.js" data-server="http://server"></script>
 */
function autoInit(): void {
  const script = document.currentScript as HTMLScriptElement | null
  const server = script?.dataset.server
  if (!server) return

  const start = () => init({ server })
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
}

autoInit()
