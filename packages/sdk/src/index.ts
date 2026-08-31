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
import { connect, reconnectWithInfo, send, onMessage, disconnect } from './ws-client.js'
import { installLogCollector } from './log-collector.js'
import { installNetworkCollector, getStoredBody } from './network-collector.js'
import { installErrorCatcher, getErrorCount, setResourceErrorHandler } from './error-catcher.js'
import { pushRecentError } from './snapshot.js'
import { installHelpers, setResultSender, handleExec } from './exec-runner.js'
import { installDevToolsHelpers } from './devtools-helpers.js'
import { installStorageWatcher, setStorageWatcherActive } from './storage-watcher.js'
import { installDomWatcher, disconnectDomWatcher, setDomWatcherActive } from './dom-watcher.js'
import { startScreenShare, stopScreenShare } from './screen-capture.js'
import { startMouseTracker } from './mouse-tracker.js'
import { initVueDevToolsBridge } from './devtools-bridge.js'
import { initReactDevToolsBridge } from './react-devtools-bridge.js'
import { dispatchServerMessage } from './message-router.js'

/**
 * deviceId 的存储 key（sessionStorage 与 localStorage 同名复用，天然按 origin 隔离）：
 * - sessionStorage：本 tab 的 id（reload 延续、tab 关闭即失）
 * - localStorage：持久 id（跨会话延续——关 tab 重开仍是同一设备）
 */
const DEVICE_ID_KEY = '__silkpulse_device_id__'

/**
 * 会话 token：每次页面加载生成一次（内存级，不持久化）
 *
 * reload 后必变、WS 断线重连不变——server 靠这个区分两种同 id 重连场景：
 * - 同 token：reload，应合并回原设备（保留历史缓冲）
 * - 不同 token：复制标签页，应仲裁冲突下发 device-id-conflict
 * 这是 Web Locks 不可用（非安全上下文）时的冲突克星，不依赖浏览器 API。
 */
const sessionToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** 生成新设备 id（时间戳 + 随机后缀） */
function generateDeviceId(): string {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** navigator.locks 的最小形状（Web Locks API，TS dom lib 未含时兜底） */
interface LockManagerLike {
  request: (
    name: string,
    opts: { ifAvailable: boolean },
    holder: (lock: unknown) => Promise<void>,
  ) => Promise<void>
}

/**
 * 尝试持有 tab 锁（页面存活期间不放，随页面关闭自动释放）
 *
 * 返回是否成功；false = 同 id 的锁已被另一个活着的 tab 持有。
 * Web Locks 不可用（非安全上下文等）时返回 true（退化行为，server 连接池兼容）。
 */
function tryHoldTabLock(deviceId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks
    if (!locks?.request) {
      resolve(true)
      return
    }
    locks.request(
      `silkpulse-tab-${deviceId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          resolve(false)
          return
        }
        resolve(true)
        /** 持锁直到页面卸载（永不 settle，锁随页面自动释放） */
        await new Promise<void>(() => {})
      },
    ).catch(() => resolve(true))
  })
}

/**
 * 解析稳定的 deviceId（防多标签页冲突）
 *
 * 三层策略（每层都先通过 Web Locks 确认 id 未被其他活 tab 占用）：
 * 1. 本 tab 历史 id（sessionStorage）：reload 延续
 * 2. 持久 id（localStorage）：当前没有相同网址的其他 tab 时使用——
 *    关 tab 重开、换会话仍是同一设备，设备列表长期稳定
 * 3. 随机 id：持久 id 被占用（已存在相同网址的 tab）→ 本 tab 用独立随机 id
 *
 * 复制标签页：Chromium 快照复制 sessionStorage → 同 id 的锁被原 tab 持有
 * → 逐层下落到随机 id。Web Locks 不可用时锁恒可得，两个 tab 首开会同拿
 * 持久 id → 由 server 的 sessionToken 仲裁下发 device-id-conflict 兜底。
 */
async function resolveDeviceId(): Promise<string> {
  /** 1. 本 tab 的历史 id（reload 场景） */
  let sid = ''
  try {
    sid = sessionStorage.getItem(DEVICE_ID_KEY) ?? ''
  } catch {
    sid = ''
  }
  if (sid && (await tryHoldTabLock(sid))) return sid

  /** 2. 持久 id：锁可得 = 没有相同网址的其他 tab 在用它 */
  let persisted = ''
  try {
    persisted = localStorage.getItem(DEVICE_ID_KEY) ?? ''
  } catch {
    persisted = ''
  }
  if (!persisted) persisted = generateDeviceId()
  if (await tryHoldTabLock(persisted)) {
    try {
      localStorage.setItem(DEVICE_ID_KEY, persisted)
      sessionStorage.setItem(DEVICE_ID_KEY, persisted)
    } catch {
      /** 存储不可用（隐私模式）就用内存 id */
    }
    return persisted
  }

  /** 3. 持久 id 被占 → 已有相同网址的 tab，本 tab 用随机 id */
  const id = generateDeviceId()
  try {
    sessionStorage.setItem(DEVICE_ID_KEY, id)
  } catch {
    /** 忽略：内存 id 兜底 */
  }
  void tryHoldTabLock(id)
  return id
}

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
  /** 项目 ID（设备接入凭据：项目存在且启用即放行；控制台权限归项目密钥管，与设备无关） */
  projectId?: string
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

/**
 * 探测页面框架（DevTools 面板自动选插件 + 不支持提示用）
 *
 * 两个来源融合：
 * 1. hook 注册（正常时序 + 后注入恢复补注册后）：
 *    - vue：__VUE_DEVTOOLS_GLOBAL_HOOK__ 的 apps 有实例
 *    - react：__REACT_DEVTOOLS_GLOBAL_HOOK__ 的 renderers 有值
 * 2. DOM 锚点（恢复前的过渡态、5s 补扫间隙）：
 *    - vue：根容器 __vue_app__（apiCreateApp.ts 无条件挂载，prod 也在）
 *    - react：容器自有属性 __reactContainer$ 前缀（React 18+ 挂 FiberRoot）
 */
function detectFrameworks(): string[] {
  const fw: string[] = []
  const vueHook = (window as unknown as { __VUE_DEVTOOLS_GLOBAL_HOOK__?: { apps?: unknown[] } }).__VUE_DEVTOOLS_GLOBAL_HOOK__
  if (vueHook?.apps?.length) {
    fw.push('vue')
  } else {
    for (const el of document.querySelectorAll('#app, #root, body *')) {
      if ((el as unknown as { __vue_app__?: unknown }).__vue_app__) { fw.push('vue'); break }
    }
  }
  const reactHook = (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: { renderers?: Map<string, unknown> | unknown[] } }).__REACT_DEVTOOLS_GLOBAL_HOOK__
  let reactRegistered = false
  if (reactHook?.renderers) {
    const count = reactHook.renderers instanceof Map ? reactHook.renderers.size : (reactHook.renderers as unknown[]).length
    reactRegistered = count > 0
  }
  if (!reactRegistered) {
    for (const el of document.querySelectorAll('#root, #app, #__next, body *')) {
      if (Object.getOwnPropertyNames(el).some((k) => k.startsWith('__reactContainer$'))) { reactRegistered = true; break }
    }
  }
  if (reactRegistered) fw.push('react')
  return fw
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
    frameworks: detectFrameworks(),
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
 *
 * deviceId 的 Web Locks 确认是异步的：init 同步返回（采集器装配不阻塞），
 * id 就绪后再建立 WS 连接（早期日志由 sendQueue 离线缓冲，连上即 flush）。
 */
export function init(options: InitOptions): void {
  if (initialized) return
  initialized = true

  /** 记录 server origin（react-devtools-bridge 等模块按需推导资源 URL 用） */
  ;(window as unknown as Record<string, unknown>).__SILKPULSE_SERVER__ = options.server.replace(/\/$/, '')

  void initWithDeviceId(options)
}

/** id 就绪后的实际装配流程 */
async function initWithDeviceId(options: InitOptions): Promise<void> {
  let deviceId = await resolveDeviceId()
  let info = collectDeviceInfo(deviceId, options.tags, options.note)

  /** 拼 WS 地址：server 可能是 http://host:port 或 ws://host:port
   *  设备接入凭 projectId（公开标识，可随注入代码外发；项目存在且启用即放行） */
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

  /** 2. 安装 exec 辅助函数（必须在 connect 前挂到 window）
   *
   * devtools 辅助函数（__silkpulse_devtools_*）独立安装：
   * 组件树读取 / state 读写（React overrideValueAtPath + Vue editInspectorState） */
  installHelpers()
  installDevToolsHelpers()

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
    } else if (msg.type === 'get-network-body') {
      /** 控制台按需拉取完整 body（懒加载） */
      const body = getStoredBody(msg.bodySeq)
      send({ type: 'network-body', bodySeq: msg.bodySeq, body })
    }
    /** 分发给扩展监听器（devtools-bridge / react-devtools-bridge 等） */
    dispatchServerMessage(msg)
  })

  /** 5. 连接 server（携带 sessionToken；server 仲裁出复制标签页冲突时换 id 重连） */
  connect({
    url: wsUrl,
    info,
    sessionToken,
    onIdConflict: () => {
      /**
       * server 判定本 tab 是复制出来的（同 id 不同 token 的活连接已存在）。
       * 换新 id：写 sessionStorage + 持新锁 + 重采设备信息重连。
       * deviceId/info 闭包变量重赋值后，路由监听等后续上报自动用新 id。
       */
      deviceId = generateDeviceId()
      try {
        sessionStorage.setItem(DEVICE_ID_KEY, deviceId)
      } catch {
        /** 写不进就纯内存 id */
      }
      void tryHoldTabLock(deviceId)
      info = collectDeviceInfo(deviceId, options.tags, options.note)
      reconnectWithInfo(info)
    },
  })

  /** 5.0 启动鼠标采集（始终开启，轻量数据，价值高） */
  startMouseTracker((mouse) => send({ type: 'device-mouse', mouse }))

  /** 5.1 异步采集 base64 icon（避免跨域 ORB/CORS 拦截，控制台直接渲染 data URL） */
  collectPageIconDataUrl().then((iconDataUrl) => {
    if (iconDataUrl) {
      send({ type: 'update-info', device: { id: deviceId, icon: iconDataUrl } })
    }
  })
  /**
   * 5.2 框架定期重报（变化才上报）
   *
   * 为什么需要：script 标签先注入的接入方式下，SDK 在 <head> 同步执行时
   * 真实 vite build 的 Vue/React app 尚未 mount（ESM chunk 异步加载），
   * collectDeviceInfo 探到 frameworks=[] 上报后，只有 SPA 路由变化才会重报。
   * 控制台 DevTools 面板据 frameworks 判定「不支持」直接拒绝连接（不加载
   * client iframe），页面 app 起来后也无法自愈。
   *
   * 自适应间隔（setTimeout 链）：
   * - 未探到框架：1s 高频——SPA 启动窗口内（chunk 加载 + mount）尽快上报，
   *   用户在面板上几乎无感等待
   * - 已探到框架：5s 低频——兜底后续动态 mount 的 app（路由级 createApp、
   *   微前端子应用），稳态开销可忽略
   *
   * detectFrameworks 是纯 DOM/hook 检查，结果与上次相同（join 比较）时
   * 零流量；不用 MutationObserver 是因为框架在容器上挂的是 JS expando
   * 属性（__vue_app__ / __reactContainer$），attribute 观察不到。
   */
  let lastFrameworks = (info.frameworks ?? []).join(',')
  const probeFrameworks = (): void => {
    const current = detectFrameworks()
    const joined = current.join(',')
    if (joined !== lastFrameworks) {
      lastFrameworks = joined
      send({ type: 'update-info', device: { id: deviceId, frameworks: current } })
    }
    setTimeout(probeFrameworks, current.length > 0 ? 5000 : 1000)
  }
  setTimeout(probeFrameworks, 1000)

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
    /** 路由变化后也异步采集 base64 icon + 重探框架（SPA 懒加载组件可能后挂 React/Vue） */
    collectPageIconDataUrl().then((iconDataUrl) => {
      if (iconDataUrl) {
        send({ type: 'update-info', device: { id: deviceId, icon: iconDataUrl } })
      }
    })
    const currentFws = detectFrameworks()
    lastFrameworks = currentFws.join(',')
    send({ type: 'update-info', device: { id: deviceId, frameworks: currentFws } })
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
  /** 项目归属：data-project-id（鉴权部署下的设备接入凭据，公开标识非密钥） */
  const projectId = script?.dataset.projectId || undefined

  const start = () => init({ server, tags, note, projectId })
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
}

autoInit()

/**
 * Vue DevTools backend 初始化（同步、尽早执行）
 *
 * 必须在 Vue app 创建前创建 __VUE_DEVTOOLS_GLOBAL_HOOK__：
 * Vue global build 加载时同步初始化 renderer，检查全局 hook 是否存在：
 *   - 已存在 → 直接注册 app，组件树实时同步
 *   - 不存在 → push 到 3 秒超时 replay buffer，超时后放弃
 *
 * SDK 脚本通过 <script> 标签加载（同步 IIFE），本行在脚本解析时即执行，
 * 天然早于后续 <script> 中的 Vue createApp()。
 * channel.post 依赖 ws-client.send，send 有离线缓冲队列，
 * WS 连上前消息暂存，连上后自动 flush。
 */
initVueDevToolsBridge()

/**
 * React DevTools hook stub 初始化（同步、尽早执行）
 *
 * 在 window 上安装终身不可替换的 __REACT_DEVTOOLS_GLOBAL_HOOK__ 代理 stub：
 * react-dom 加载时同步读取这个 hook，stub 提前在位才能接到 renderer inject 和
 * fiber root commit；控制台激活时动态 fetch backend bundle，stub 把暂存的
 * renderers/roots 转交给真 backend（天然支持后注入）。
 */
initReactDevToolsBridge()
