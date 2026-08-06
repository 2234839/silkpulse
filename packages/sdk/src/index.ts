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
import { installErrorCatcher, getErrorCount, setResourceErrorHandler } from './error-catcher.js'
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
  /** 预设标签（区分多设备，如 "生产环境"） */
  tags?: string[]
  /** 预设备注（一句话描述设备身份） */
  note?: string
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
function collectDeviceInfo(id: string, tags: string[] = [], note?: string): DeviceInfo {
  return {
    id,
    url: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    deviceType: detectDeviceType(navigator.userAgent, window.innerWidth),
    errorCount: getErrorCount(),
    onlineAt: Date.now(),
    tags,
    note,
  }
}

/**
 * 推断设备类型：mobile / tablet / desktop
 * 结合 UA 关键词与视口宽度
 */
function detectDeviceType(ua: string, viewportWidth: number): 'mobile' | 'tablet' | 'desktop' {
  const lower = ua.toLowerCase()
  if (/ipad|tablet|playbook|silk/.test(lower)) return 'tablet'
  if (/mobi|iphone|ipod|android.*mobile|windows phone/.test(lower)) return 'mobile'
  /** 大屏 Android 不匹配上面的 mobile 关键词 */
  if (/android/.test(lower) && viewportWidth >= 768) return 'tablet'
  return 'desktop'
}

let initialized = false

/**
 * 初始化 SDK —— 装配采集器、连接 server、注册 exec 处理
 */
export function init(options: InitOptions): void {
  if (initialized) return
  initialized = true

  const deviceId = getDeviceId()
  const info = collectDeviceInfo(deviceId, options.tags, options.note)

  /** 拼 WS 地址：server 可能是 http://host:port 或 ws://host:port */
  const wsBase = options.server.replace(/^http/, 'ws')
  const wsUrl = `${wsBase.replace(/\/$/, '')}/ws/device`

  /** 1. 装配采集器，每个 collector 的 sink → WS 上报 */
  installLogCollector(
    (entry: LogEntry) => send({ type: 'log', log: entry }),
    () => send({ type: 'log-repeat' }),
  )
  installNetworkCollector(
    (entry: NetworkEntry) => send({ type: 'network', entry }),
    (seq, frame) => send({ type: 'ws-frame', seq, frame }),
    (seq, wsState) => send({ type: 'ws-state', seq, wsState }),
  )
  installErrorCatcher((entry: ErrorEntry) => {
    pushRecentError(entry.message)
    send({ type: 'error', error: entry })
  })
  /** 资源加载失败（404 图片/脚本等）转给 snapshot 的 recentErrors，
   *  不进 error 流、不计 errorCount，避免一个 404 资源就让设备亮红条误导诊断 */
  setResourceErrorHandler((msg) => pushRecentError(msg))

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

  /** 6. SPA 路由变化时上报新 url/title（让 server/AI 看到正确的页面位置） */
  /** 劫持 pushState/replaceState 捕获 SPA 路由跳转，popstate 捕获浏览器前进后退 */
  const reportUrlChange = () => {
    send({
      type: 'update-info',
      device: {
        id: deviceId,
        url: location.href,
        title: document.title,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        deviceType: detectDeviceType(navigator.userAgent, window.innerWidth),
      },
    })
  }
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history) as (...args: unknown[]) => void
    history[method] = function (...args: unknown[]) {
      const ret = original(...args)
      setTimeout(reportUrlChange, 0)
      return ret
    }
  }
  window.addEventListener('popstate', reportUrlChange)

  /**
   * 视口尺寸变化（窗口缩放 / 移动端旋转）时上报新尺寸 + 重新推断设备类型
   *
   * 诊断移动端布局错乱时，AI 需知道当前真实视口（如横屏旋转后宽高互换、
   * 缩放后触发断点变化）。不加这个监听，server/AI 看到的永远是接入时的尺寸，
   * 旋转后的布局问题无法关联到正确的视口。
   * resize 防抖 300ms：拖拽缩放期间连续触发，避免刷爆 server。
   */
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(reportUrlChange, 300)
  })

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

  /** data-tags 用逗号分隔，data-note 为单行备注 */
  const tagsRaw = script?.dataset.tags ?? ''
  const tags = tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
  const note = script?.dataset.note || undefined

  const start = () => init({ server, tags, note })
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
}

autoInit()
