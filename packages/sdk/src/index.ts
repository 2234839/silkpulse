/**
 * silkpulse SDK 入口 —— 装配所有采集器，连接 server
 *
 * 注入方式：
 * 1. IIFE 脚本：<script src="http://server/sdk.js"></script>（自动初始化）
 * 2. 主动调用：SilkPulseSDK.init({ server: 'ws://localhost:8080' })
 *
 * 采集器：log-collector / network-collector / error-catcher
 * 通道：ws-client（上报 + exec 回传）
 */

import type { DeviceInfo, ServerToDeviceMessage, LogEntry, NetworkEntry, ErrorEntry } from '@silkpulse/shared'
import { connect, send, onMessage, disconnect } from './ws-client.js'
import { installLogCollector } from './log-collector.js'
import { installNetworkCollector } from './network-collector.js'
import { installErrorCatcher, getErrorCount, setResourceErrorHandler } from './error-catcher.js'
import { pushRecentError } from './snapshot.js'
import { installHelpers, setResultSender, handleExec } from './exec-runner.js'
import { installStorageWatcher, setStorageWatcherActive } from './storage-watcher.js'
import { installDomWatcher, disconnectDomWatcher, setDomWatcherActive } from './dom-watcher.js'
import { startScreenShare, stopScreenShare } from './screen-capture.js'
import { startMouseTracker } from './mouse-tracker.js'

/** deviceId 在 sessionStorage 的 key（同 tab 刷新不变） */
const DEVICE_ID_KEY = '__silkpulse_device_id__'

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
  /** 项目 ID（标记设备归属哪个项目，设备端无需密钥） */
  projectId?: string
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

/** 采集页面图标 URL（优先 meta link，兜底 /favicon.ico） */
function collectPageIconUrl(): string | undefined {
  /** 优先：<link rel="icon" / "shortcut icon" / "apple-touch-icon"> */
  const linkSel = 'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
  const linkEl = document.querySelector<HTMLLinkElement>(linkSel)
  if (linkEl?.href) return linkEl.href

  /** 兜底：/favicon.ico（用绝对路径，避免相对路径解析错误） */
  try {
    return new URL('/favicon.ico', location.origin).href
  } catch {
    return undefined
  }
}

/**
 * 异步采集页面图标并转为 base64 data URL
 *
 * 直接传 URL 给控制台会遇到跨域 ORB/CORS 阻塞。
 * 在 SDK 端转成 data URL：优先用同源 /favicon.ico（fetch 无跨域问题），
 * 不行再试 <link> icon 的 fetch（跨域 CDN 可能失败），都失败兜底返回原始 URL。
 */
async function collectPageIconDataUrl(): Promise<string | undefined> {
  const linkIconUrl = collectPageIconUrl()
  if (!linkIconUrl) return undefined

  /** 候选 URL 列表：同源 favicon 优先（最可能 fetch 成功），再试 link 指向的 URL */
  const candidates: string[] = []
  try {
    candidates.push(new URL('/favicon.ico', location.origin).href)
  } catch { /* ignore */ }
  if (linkIconUrl) candidates.push(linkIconUrl)

  for (const url of candidates) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const blob = await res.blob()
      /** 小于 32KB 才转 base64（避免超大图浪费带宽） */
      if (blob.size > 32 * 1024) continue
      const dataUrl = await new Promise<string | null>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(blob)
      })
      if (dataUrl) return dataUrl
    } catch {
      /** fetch 失败（跨域/网络）：试下一个候选 */
    }
  }
  /** 所有候选都失败：兜底返回 link URL（至少控制台还能尝试加载） */
  return linkIconUrl
}

/** 收集当前设备元信息 */
function collectDeviceInfo(id: string, tags: string[] = [], note?: string): DeviceInfo {
  return {
    id,
    url: location.href,
    title: document.title,
    icon: collectPageIconUrl(),
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

  /** 拼 WS 地址：server 可能是 http://host:port 或 ws://host:port
   *  设备端只携带 projectId 标记归属，不需要密钥（密钥不暴露到设备端） */
  const wsBase = options.server.replace(/^http/, 'ws').replace(/\/$/, '')
  const wsParams = new URLSearchParams()
  if (options.projectId) wsParams.set('projectId', options.projectId)
  const queryStr = wsParams.toString()
  const wsUrl = `${wsBase}/ws/device${queryStr ? '?' + queryStr : ''}`

  /** 1. 装配采集器，每个 collector 的 sink → WS 上报 */
  installLogCollector(
    (entry: LogEntry) => send({ type: 'log', log: entry }),
    () => send({ type: 'log-repeat' }),
  )
  installNetworkCollector(
    (entry: NetworkEntry) => send({ type: 'network', entry }),
    (seq, frame) => send({ type: 'ws-frame', seq, frame }),
    (seq, wsState) => send({ type: 'ws-state', seq, wsState }),
    (seq, event) => send({ type: 'sse-event', seq, event }),
    (seq, patch) => send({ type: 'network-update', seq, patch }),
  )
  installErrorCatcher((entry: ErrorEntry) => {
    pushRecentError(entry.message)
    send({ type: 'error', error: entry })
  })
  /** 资源加载失败（404 图片/脚本等）转给 snapshot 的 recentErrors，
   *  不进 error 流、不计 errorCount，避免一个 404 资源就让设备亮红条误导诊断 */
  setResourceErrorHandler((msg) => pushRecentError(msg))

  /** storage 变化采集：劫持 setItem/removeItem/clear + 跨 tab storage 事件 */
  installStorageWatcher((storageType, key, timestamp) => send({ type: 'storage-change', storageType, key, timestamp }))

  /** DOM 变化采集：MutationObserver 监听子树增删/属性/文本变化（Element 面板实时刷新用） */
  installDomWatcher((changes) => send({ type: 'dom-change', changes }))

  /** 2. 安装 exec 辅助函数（必须在 connect 前挂到 window） */
  installHelpers()

  /** 3. 注册 exec 结果回传器 */
  setResultSender((execId, result) => send({ type: 'exec-result', execId, result }))

  /** 4. 注册 server 消息处理器（exec + set-watchers 按需采集） */
  onMessage((msg: ServerToDeviceMessage) => {
    if (msg.type === 'exec') {
      handleExec(msg.code, msg.execId).catch(() => {
        /** handleExec 内部已捕获错误并回传，这里是兜底 */
      })
    } else if (msg.type === 'set-watchers') {
      /** 控制台打开对应面板时启用采集器，关闭时停用（按需采集减少不必要的数据传输） */
      const watchers = msg.watchers
      setStorageWatcherActive(watchers.includes('storage'))
      setDomWatcherActive(watchers.includes('dom'))
    } else if (msg.type === 'start-screen-share') {
      /**
       * 控制台请求屏幕共享
       * SDK 用 SnapDOM 直接截取页面视口，无需用户授权/手势，
       * 收到指令后立即开始增量推帧。
       */
      startScreenShare(
        (frame) => send({ type: 'screen-frame', frame }),
        (status) => send({ type: 'screen-share-status', status }),
      )
    } else if (msg.type === 'stop-screen-share') {
      stopScreenShare()
    }
  })

  /** 5. 连接 server */
  connect({ url: wsUrl, info })

  /** 5.0 启动鼠标采集（始终开启，轻量数据，价值高） */
  startMouseTracker((mouse) => send({ type: 'device-mouse', mouse }))

  /** 5.1 异步采集 base64 icon（避免跨域 ORB/CORS 拦截，控制台直接渲染 data URL） */
  collectPageIconDataUrl().then((iconDataUrl) => {
    if (iconDataUrl) {
      send({ type: 'update-info', device: { id: deviceId, icon: iconDataUrl } })
    }
  })

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
    /** 路由变化后也异步采集 base64 icon */
    collectPageIconDataUrl().then((iconDataUrl) => {
      if (iconDataUrl) {
        send({ type: 'update-info', device: { id: deviceId, icon: iconDataUrl } })
      }
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

  /** 监听 document.title 变化（JS 动态修改 title 时实时上报） */
  const titleEl = document.querySelector('title')
  if (titleEl) {
    const titleObserver = new MutationObserver(() => reportUrlChange())
    titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true })
  }

  /** 监听 head 子节点变化（捕获 <link rel="icon"> 动态添加/修改，SPA 切换 icon） */
  if (document.head) {
    const headObserver = new MutationObserver((mutations) => {
      /** 只在有 link/icon 相关节点变化时才上报 */
      const relevant = mutations.some((m) => {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLLinkElement) return true
        }
        if (m.target instanceof HTMLLinkElement) return true
        return false
      })
      if (relevant) reportUrlChange()
    })
    headObserver.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'rel'] })
  }

  /** 7. 页面卸载断开 */
  if (options.disconnectOnUnload !== false) {
    window.addEventListener('beforeunload', () => {
      disconnectDomWatcher()
      disconnect()
    })
  }
}

/**
 * 自动初始化（IIFE 注入模式）
 * 当 script 标签带 data-server 属性时，DOMContentLoaded 后自动 init
 * <script src="http://server/sdk.js" data-server="http://server"></script>
 */
function autoInit(): void {
  const script = document.currentScript as HTMLScriptElement | null
  /** 优先用 data-server；未指定时从 script.src 推导（同源部署场景） */
  const server = script?.dataset.server ?? (script?.src ? new URL(script.src).origin : '')
  if (!server) return

  /** data-tags 用逗号分隔，data-note 为单行备注 */
  const tagsRaw = script?.dataset.tags ?? ''
  const tags = tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
  const note = script?.dataset.note || undefined
  /** 项目归属：data-project-id */
  const projectId = script?.dataset.projectId || undefined

  const start = () => init({ server, tags, note, projectId })
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
}

autoInit()
