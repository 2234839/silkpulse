/**
 * React DevTools backend 桥接 —— 在目标页安装 react-devtools hook + 按需激活 Agent
 *
 * 架构：
 *   目标页（本文件）                SilkPulse server           控制台 iframe
 *   ┌────────────────────┐         ┌────────────┐         ┌──────────────────┐
 *   │ hook stub（同步）   │         │            │         │ frontend.bundle  │
 *   │ + backend bundle   │ devtools-relay        │ devtools-relay │ initialize() │
 *   │   （按需 fetch）    │◄───────►│  透传      │◄───────►│ <DevTools />     │
 *   │ Agent + Wall       │   (WS)  │            │   (WS)  │ custom Wall      │
 *   └────────────────────┘         └────────────┘         └──────────────────┘
 *
 * React 时序约束（与 Vue 不同，React 没有 replay 机制）：
 *   react-dom 模块执行时同步调 hook.inject(internals) 并缓存 hook 引用，
 *   所以 __REACT_DEVTOOLS_GLOBAL_HOOK__ 必须在 react-dom 加载前同步存在。
 *   而 backend bundle（700KB）异步 fetch 太慢，所以：
 *
 *   1. SDK 顶层同步装「委托式 hook stub」—— 收集 renderer（inject 调用）
 *      + fiberRoots（onCommitFiberRoot 调用）+ 事件订阅
 *   2. 控制台打开 React DevTools → WS 请求 activate
 *   3. SDK fetch backend.bundle.js → 在 shadow target 上 installHook 装真 hook
 *   4. replay 收集的 renderer 到真 hook（attachRenderer 重建 rendererInterface）
 *   5. 激活 Agent（createBridge(wall) + activate）→ initBackend 读 hook 上已
 *      注册的 rendererInterfaces → flushInitialOperations → 全量树推给前端
 *   6. stub 的所有方法从激活起委托给真 hook（react-dom 持有的引用不变，
 *      因为 stub 对象本身一直是 window.__REACT_DEVTOOLS_GLOBAL_HOOK__）
 *
 * 消息协议（Wall）：
 *   { event: string, payload: unknown, fromBackend?: boolean }
 *   fromBackend 标记方向，避免 SDK 把自己发出的消息又转发回 backend
 */

import { send } from './ws-client.js'
import { registerServerMessageHandler } from './message-router.js'

/** backend bundle 加载后的全局名（IIFE global-name） */
const BACKEND_GLOBAL = 'ReactDevToolsBackend'

/** backend bundle URL（server 静态服务，SDK 与目标页同源时直接用相对路径） */
const BACKEND_URL = '/plugins/react-devtools/assets/backend.bundle.js'

/** backend bundle 模块形状（react-devtools-inline/backend 的导出） */
interface BackendModule {
  initialize: (target: Window) => unknown
  activate: (target: Window, opts?: { bridge?: unknown }) => void
  createBridge: (target: Window, wall?: unknown) => unknown
}

/** hook 上的事件订阅回调 */
type HookListener = (data: unknown) => void

/** react-dom 通过 inject 传入的 renderer internals */
interface RendererInternals {
  version?: string
  bundleType?: number
  [key: string]: unknown
}

/** 真 hook 的形状（installHook 装上的完整对象） */
interface RealHook {
  rendererInterfaces: Map<number, unknown>
  renderers: Map<number, RendererInternals>
  hasUnsupportedRendererAttached: boolean
  emit: (event: string, data?: unknown) => void
  on: (event: string, fn: HookListener) => void
  off: (event: string, fn: HookListener) => void
  sub: (event: string, fn: HookListener) => () => void
  inject: (renderer: RendererInternals) => number
  getFiberRoots: (rendererID: number) => Set<unknown>
  onCommitFiberRoot: (rendererID: number, root: unknown, priorityLevel?: unknown) => void
  onCommitFiberUnmount: (rendererID: number, fiber: unknown) => void
  onPostCommitFiberRoot?: (rendererID: number, root: unknown) => void
  setStrictMode?: (isStrictMode: boolean) => void
  checkDCE: (fn: unknown) => void
  supportsFiber: boolean
  supportsFlight: boolean
  settings?: unknown
  reactDevtoolsAgent?: unknown
  [key: string]: unknown
}

/** 真 hook（backend bundle 加载后赋值，之前为 null） */
let realHook: RealHook | null = null

/** stub 阶段收集的 renderer（inject 被调用时存起来，激活时 replay） */
const pendingRenderers: Array<{ id: number; renderer: RendererInternals }> = []

/** stub 阶段的 uid 计数器（与官方 installHook 一致，从 0 自增） */
let stubUid = 0

/** stub 阶段收集的 fiberRoots（rendererID → Set<root>） */
const stubFiberRoots: Record<number, Set<unknown>> = {}

/** stub 阶段的事件监听器（激活后合并进真 hook） */
const stubListeners: Record<string, HookListener[]> = {}

/**
 * 委托式 hook stub —— 同步装到 window，react-dom 加载时调 inject 注册
 *
 * 职责：
 * - inject(renderer)：暂存 renderer（真 hook 就绪前 react-dom 就会调）
 * - onCommitFiberRoot：暂存 root（commit 时 react-dom 持续调用，终身有效）
 * - on/off/emit/sub：事件订阅暂存，激活后转发给真 hook
 * - 其余属性（checkDCE 等）在激活后委托真 hook，激活前为安全 no-op
 *
 * 关键：这个对象终身是 window.__REACT_DEVTOOLS_GLOBAL_HOOK__（不可替换，
 * 因为 react-dom 已缓存引用），所有方法在激活后内部转发到 realHook。
 */
function installDelegatingHookStub(): void {
  const target = window as unknown as Record<string, unknown>

  /** 已有 hook（别的 devtools 扩展或重复注入）就不动 */
  if (target.__REACT_DEVTOOLS_GLOBAL_HOOK__ != null) return

  const stub = {
    _isSilkPulseStub: true,
    rendererInterfaces: new Map<number, unknown>(),
    renderers: new Map<number, RendererInternals>(),
    backends: new Map<number, unknown>(),
    listeners: stubListeners,
    hasUnsupportedRendererAttached: false,
    supportsFiber: true,
    supportsFlight: true,
    checkDCE: (_fn: unknown) => {},
    settings: {
      appendComponentStack: true,
      breakOnConsoleErrors: false,
      showInlineWarningsAndErrors: true,
      hideConsoleLogsInStrictMode: false,
    },

    emit(event: string, data?: unknown) {
      /** 激活后直接走真 hook 的 emit；激活前广播给 stub 订阅者 */
      if (realHook) { realHook.emit(event, data); return }
      for (const fn of stubListeners[event] ?? []) fn(data)
    },

    on(event: string, fn: HookListener) {
      if (realHook) { realHook.on(event, fn); return }
      ;(stubListeners[event] ??= []).push(fn)
    },

    off(event: string, fn: HookListener) {
      if (realHook) { realHook.off(event, fn); return }
      const arr = stubListeners[event]
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },

    sub(event: string, fn: HookListener) {
      stub.on(event, fn)
      return () => stub.off(event, fn)
    },

    inject(renderer: RendererInternals): number {
      if (realHook) return realHook.inject(renderer) as number
      /** stub 阶段：暂存，等真 hook 就绪后 replay */
      const id = ++stubUid
      pendingRenderers.push({ id, renderer })
      stub.renderers.set(id, renderer)
      return id
    },

    getFiberRoots(rendererID: number): Set<unknown> {
      if (realHook) return realHook.getFiberRoots(rendererID)
      return (stubFiberRoots[rendererID] ??= new Set())
    },

    onCommitFiberRoot(rendererID: number, root: unknown, priorityLevel?: unknown) {
      if (realHook) { realHook.onCommitFiberRoot(rendererID, root, priorityLevel); return }
      /** stub 阶段把 root 记下来（react-dom 每次 commit 都会调，天然增量收集） */
      stub.getFiberRoots(rendererID).add(root)
    },

    onCommitFiberUnmount(rendererID: number, fiber: unknown) {
      if (realHook) realHook.onCommitFiberUnmount(rendererID, fiber)
      /** stub 阶段无法处理 unmount 增量（没有 rendererInterface），激活后全量重建 */
    },

    onPostCommitFiberRoot(rendererID: number, root: unknown) {
      if (realHook) realHook.onPostCommitFiberRoot?.(rendererID, root)
    },

    setStrictMode(isStrictMode: boolean) {
      if (realHook) realHook.setStrictMode?.(isStrictMode)
    },
  }

  Object.defineProperty(target, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
    configurable: false,
    enumerable: false,
    get() {
      return stub
    },
  })
}

/** backend bundle 加载 Promise（防重复 fetch） */
let backendLoadPromise: Promise<BackendModule> | null = null

/**
 * 后注入恢复：DOM 扫描已存在的 React root，合成 renderer 注册进 stub
 *
 * 场景：SDK 在 react-dom 之后才注入。react-dom 模块求值时同步调
 * hook.inject(internals) 并缓存 hook 引用——我们 stub 装晚了收不到
 * inject，pendingRenderers 为空，激活后 backend 无 renderer 可 attach。
 *
 * 恢复路径：React 18+ 在每个 root 容器上挂 `__reactContainer$<random>`
 * （值即 FiberRoot）。扫出来后合成 renderer 对象（backend 的
 * attachRenderer 只要求 version/bundleType + findFiberByHostInstance
 * 或 currentDispatcherRef 走 fiber 分支），激活时与真实 inject 一样
 * replay 进真 hook。fiberRoots 也一并注入，flushInitialOperations
 * 会从 getFiberRoots 建全量树；后续 commit 走 stub.onCommitFiberRoot
 * （react-dom 持有的是 stub 引用）持续增量。
 *
 * findFiberByHostInstance 用 hostInstance 上的 __reactFiber$ 回溯实现
 * （官方 renderer 是从 fiber 树反查，我们正查等价）。version 优先取
 * React 全局版本（__SECRET_INTERNALS 或 18 的 React.__VERSION 不在
 * 页面全局时兜底 '18.0.0'——fiber 常量表按版本分支，18+ 的 tag 体系
 * 18/19 一致，19 专属 tag（Activity 31 等）在旧常量表里是 -1 会被
 * 当未知类型跳过显示，树仍可用）。
 */
function recoverReactRoots(): void {
  const target = window as unknown as Record<string, unknown>
  /** stub 已有 renderer（react-dom 在 stub 之后加载，inject 走到了）则无需恢复 */
  if (stubRenderersRecovered) return
  if (pendingRenderers.length > 0) return

  const roots = new Set<unknown>()
  for (const el of document.querySelectorAll('*')) {
    for (const key of Object.getOwnPropertyNames(el)) {
      if (!key.startsWith('__reactContainer$')) continue
      const container = (el as unknown as Record<string, unknown>)[key]
      /** FiberRoot 形状：{ current: HostRootFiber, ... }；只收非空 root */
      if (container && (container as { current?: unknown }).current) roots.add(container)
    }
  }
  if (roots.size === 0) return

  /** 探测 React 版本（页面全局可能有 React 挂载信息） */
  const reactGlobal = (target.React ?? target.__REACT__) as { version?: string } | undefined
  const version = reactGlobal?.version ?? '18.0.0'

  const syntheticRenderer: RendererInternals = {
    version,
    reconcilerVersion: version,
    /** 1 = development build（fiber 里有 _debugSource 等字段，backend 会展示源码定位） */
    bundleType: 1,
    rendererPackageName: 'react-dom',
    findFiberByHostInstance(instance: unknown) {
      /** hostInstance 上的 __reactFiber$ 属性即所属 fiber（React 17+ 恒有） */
      if (!instance || typeof instance !== 'object') return null
      for (const key of Object.getOwnPropertyNames(instance)) {
        if (key.startsWith('__reactFiber$')) {
          return (instance as Record<string, unknown>)[key] ?? null
        }
      }
      return null
    },
  }

  /** 注入 stub（与 react-dom 主动 inject 同路径），fiberRoots 一并登记 */
  const rendererID = stubInjectForRecovery(syntheticRenderer)
  if (rendererID == null) return
  const fiberRoots = stubFiberRoots[rendererID] ??= new Set()
  for (const root of roots) fiberRoots.add(root)
  stubRenderersRecovered = true
}

/** 恢复是否已执行过（一个页面生命周期只做一次 DOM 全扫） */
let stubRenderersRecovered = false

/**
 * 恢复路径专用 inject：绕过 realHook 判断（恢复可能发生在激活之后）
 *
 * 返回分配的 rendererID，hook 不可用时返回 null。
 */
function stubInjectForRecovery(renderer: RendererInternals): number | null {
  /** 激活后直接走真 hook（backend 立即 attachRenderer + 从 fiberRoots 建树） */
  if (realHook) return realHook.inject(renderer)
  const stub = (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: { inject?: (r: RendererInternals) => number } }).__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (!stub?.inject) return null
  const id = stub.inject(renderer)
  pendingRenderers.push({ id, renderer })
  return id
}

/**
 * 推导 server origin（backend bundle 的下载地址）
 *
 * 优先级：
 * 1. window.__SILKPULSE_SERVER__（init 时写入，最可靠）
 * 2. 当前 SDK script 标签的 src origin（data-server 未指定时）
 * 3. 空字符串（同源部署，直接用相对路径 /plugins/...）
 */
function resolveServerOrigin(): string {
  const target = window as unknown as Record<string, unknown>
  const fromInit = target.__SILKPULSE_SERVER__
  if (typeof fromInit === 'string' && fromInit) return fromInit
  try {
    const script = document.currentScript as HTMLScriptElement | null
    if (script?.src) return new URL(script.src).origin
  } catch { /** script.src 解析失败忽略 */ }
  return ''
}

/**
 * 动态加载 react-devtools-inline backend bundle
 *
 * fetch + new Function 执行 IIFE。注意：bundle 用 `var ReactDevToolsBackend = (...)()`
 * 导出，var 在 Function 体内是局部作用域（.call(window) 也救不了 var），必须在
 * 函数尾部 return 出来再手动挂 window。
 * 失败静默（React devtools 是可选功能，不阻塞 SDK），但打 error 日志方便排查。
 */
function loadBackendBundle(): Promise<BackendModule> {
  if (backendLoadPromise) return backendLoadPromise
  backendLoadPromise = (async () => {
    const target = window as unknown as Record<string, unknown>
    const existing = target[BACKEND_GLOBAL]
    if (existing) return existing as BackendModule

    const url = resolveServerOrigin() + BACKEND_URL
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`React DevTools backend 加载失败: HTTP ${resp.status}`)
    const code = await resp.text()

    const mod = new Function(`${code}\n;return typeof ReactDevToolsBackend !== 'undefined' ? ReactDevToolsBackend : undefined`).call(window)
    if (!mod) throw new Error('React DevTools backend bundle 未导出全局')
    target[BACKEND_GLOBAL] = mod
    return mod as BackendModule
  })()
  return backendLoadPromise
}

/** backend 是否已激活（Agent 只启动一次） */
let backendActivated = false

/** 激活后绑定的「控制台消息 → backend Wall」转发函数 */
let frontendToBackend: ((msg: { event: string; payload: unknown }) => void) | null = null

/** 当前活跃的 Bridge（reactivate 时 shutdown 旧的，避免双 agent 重复发消息） */
let activeBridge: { shutdown: () => void } | null = null

/** 当前活跃 wall 的静音函数（reactivate 时先吞掉旧 bridge 的 shutdown 广播） */
let muteActiveWall: (() => void) | null = null

/**
 * 自定义 Relay Wall：backend Bridge ↔ SilkPulse WS
 *
 * 可静音（mute）：reactivate 关闭旧 bridge 前必须先静音——
 * bridge.shutdown() 会向 wall 广播 `shutdown` 事件，而此时控制台侧已换成新重载的
 * frontend，其 Store 收到 `shutdown` 会摘掉 operations 等全部监听，之后即使重新
 * 握手成功、初始树也永远无人处理（组件树卡 Loading）。静音后 shutdown 广播被
 * 吞掉，旧 agent 的本地清理（摘 hook 监听防双发）不受影响。
 */
function createRelayWall() {
  let muted = false
  const wallListeners: Array<(msg: { event: string; payload: unknown }) => void> = []
  const wall = {
    listen(fn: (msg: { event: string; payload: unknown }) => void) {
      wallListeners.push(fn)
      return () => {
        const i = wallListeners.indexOf(fn)
        if (i >= 0) wallListeners.splice(i, 1)
      }
    },
    send(event: string, payload: unknown) {
      /** 静音后丢弃（旧 agent 的残余消息不再到达任何 frontend） */
      if (muted) return
      send({
        type: 'devtools-relay',
        plugin: 'react',
        payload: { event, payload, fromBackend: true },
      })
    },
  }
  return {
    wall,
    /** 控制台 frontend → backend：把路由层消息分发给当前 wall 的 listeners */
    dispatch(msg: { event: string; payload: unknown }) {
      for (const fn of wallListeners) fn(msg)
    },
    /** 后续 send 全部丢弃（listen 不动，bridge.shutdown 会自己 removeAllListeners） */
    mute() { muted = true },
  }
}

/**
 * 合成 savedPreferences 握手回包
 *
 * activate → startActivation 会发 getSavedPreferences 并等 frontend 回 savedPreferences
 * 才 finishActivation（建 Agent + flush 初始树）。真实回包链路依赖：新 frontend 的
 * 一次性监听还在 + WS 往返不丢 + iframe 未处于重载中途——任一环错位即死锁（树永久
 * Loading）。这里在 activate 后同步补一帧合成回包，让握手确定性完成；frontend 稍后
 * 到达的真实回包因监听已被消耗而被忽略，无副作用（过滤项后续可通过
 * overrideComponentFilters 动态更新）。
 */
function completeActivationHandshake(dispatch: (msg: { event: string; payload: unknown }) => void): void {
  dispatch({
    event: 'savedPreferences',
    payload: {
      appendComponentStack: true,
      breakOnConsoleErrors: false,
      /** 空过滤器 = 不隐藏任何组件（默认最大可见性） */
      componentFilters: [],
      showInlineWarningsAndErrors: true,
      hideConsoleLogsInStrictMode: false,
    },
  })
}

/** reactivate 防抖（多次 activate 请求合并为一次重建） */
let reactivatePromise: Promise<void> | null = null

/**
 * 激活 React DevTools backend
 *
 * 1. fetch backend bundle
 * 2. 在 shadow 对象上 installHook（拿真 hook，不动 window 上的 stub）
 * 3. replay stub 收集的 renderer → 真 hook.inject
 * 4. 合并 stub 阶段的 fiberRoots 到真 hook
 * 5. createBridge(自定义 Wall) + activate → initBackend → flushInitialOperations
 */
async function activateBackend(): Promise<void> {
  if (backendActivated) {
    /** 已激活：控制台重载了 frontend（切设备/插件页重开），需要重新握手——
     * 旧 agent 的初始 operations 只发给旧 frontend，新 frontend 收不到，树会永远 Loading。
     * 重建 bridge+agent → initBackend → flushInitialOperations 重发初始树。 */
    if (!reactivatePromise) {
      reactivatePromise = reactivateBackend().finally(() => { reactivatePromise = null })
    }
    return reactivatePromise
  }
  backendActivated = true
  try {
    /** 后注入兜底：react-dom 早于 SDK 加载时（stub 没收到 inject），
     *  DOM 扫描合成 renderer——必须在 loadBackendBundle 之前，
     *  让 replay 与真实 inject 走同一条路 */
    recoverReactRoots()
    const backend = await loadBackendBundle()

    /** shadow target：一个空对象，installHook 会把真 hook defineProperty 到它上面 */
    const shadowTarget: Record<string, unknown> = {}
    backend.initialize(shadowTarget as unknown as Window)
    const hook = shadowTarget.__REACT_DEVTOOLS_GLOBAL_HOOK__ as RealHook | undefined
    if (!hook) throw new Error('installHook 未在 shadow target 上创建 hook')

    /** replay stub 阶段的 renderer 注册（react-dom 早已调过 stub.inject） */
    for (const { renderer } of pendingRenderers) {
      hook.inject(renderer)
    }

    /** 合并 stub 收集的 fiberRoots（真 hook 的 attachRenderer 会读它们重建树） */
    for (const [rendererID, roots] of Object.entries(stubFiberRoots)) {
      const realRoots = hook.getFiberRoots(Number(rendererID))
      for (const root of roots) realRoots.add(root)
    }

    /** 合并 stub 阶段的事件订阅（若有） */
    for (const [event, fns] of Object.entries(stubListeners)) {
      for (const fn of fns) hook.on(event, fn)
    }

    /** 自定义 Wall：backend ↔ SilkPulse WS（dispatch 即「控制台消息 → backend」路由） */
    const { wall, dispatch, mute } = createRelayWall()
    muteActiveWall = mute
    frontendToBackend = dispatch

    /** 激活：Agent 创建 + initBackend（读 hook.rendererInterfaces → flushInitialOperations） */
    const bridge = backend.createBridge(shadowTarget as unknown as Window, wall)
    backend.activate(shadowTarget as unknown as Window, { bridge })
    activeBridge = bridge as unknown as { shutdown: () => void }
    completeActivationHandshake(dispatch)

    /** stub 从此委托给真 hook（window 上的 stub 对象引用不变） */
    realHook = hook
  } catch {
    backendActivated = false
  }
}

/**
 * 重新握手：为重载后的 frontend 重建 bridge + agent
 *
 * shutdown 旧 bridge（agent 会摘掉自己的 hook 监听）→ 重新 createBridge/activate。
 * hook/renderer 注册都在 shadow hook 上未动，activate 内部 initBackend 会重新
 * registerRendererInterface + flushInitialOperations，新 frontend 即收到初始树。
 */
async function reactivateBackend(): Promise<void> {
  try {
    if (!realHook) return
    const backend = await loadBackendBundle()

    /** 旧 agent 停摆：先静音 wall（吞掉 shutdown 广播，防新 frontend 的 Store 摘监听），
     * 再 shutdown（agent 本地清理：摘 hook 监听防双发） */
    muteActiveWall?.()
    try { activeBridge?.shutdown() } catch { /** 已关闭忽略 */ }
    activeBridge = null

    const { wall, dispatch, mute } = createRelayWall()
    muteActiveWall = mute
    frontendToBackend = dispatch

    const shadowTarget = { __REACT_DEVTOOLS_GLOBAL_HOOK__: realHook } as Record<string, unknown>
    const bridge = backend.createBridge(shadowTarget as unknown as Window, wall)
    backend.activate(shadowTarget as unknown as Window, { bridge })
    activeBridge = bridge as unknown as { shutdown: () => void }
    completeActivationHandshake(dispatch)
  } catch {
    /** 重建失败保留旧状态（下次 activate 再试） */
  }
}

/**
 * Agent DevTools 能力用：确保 backend 已激活（幂等）
 *
 * 无控制台 frontend 时也可激活——本地直调 rendererInterface/agent 不依赖 bridge 对端，
 * bridge 发出的消息经 WS 透传无人接收，无副作用。
 */
export async function ensureReactBackendActive(): Promise<void> {
  if (backendActivated && realHook) return
  await activateBackend()
}

/** Agent DevTools 能力用：拿激活后的真 hook（含 rendererInterfaces / reactDevtoolsAgent） */
export function getActiveReactHook(): RealHook | null {
  return realHook
}

/**
 * 初始化 React DevTools bridge（SDK 顶层同步调用）
 *
 * 同步装 hook stub（react-dom 加载前），异步注册 server 消息处理。
 */
export function initReactDevToolsBridge(): void {
  installDelegatingHookStub()

  /** 后注入兜底：react-dom 已加载（inject 已飞走）时立即恢复一次。
   *  react-dom 在 SDK 之后加载的场景由 stub.inject 自然覆盖 */
  recoverReactRoots()

  registerServerMessageHandler((msg) => {
    if (msg.type !== 'devtools-relay' || msg.plugin !== 'react') return
    const data = msg.payload as { event?: string; payload?: unknown; activate?: boolean; fromBackend?: boolean }

    /** 控制台打开面板时请求激活（幂等，backendActivated 守卫）
     *
     * payload 可能是 SuperJSON 信封字符串（vue 串扰）或普通对象，只认对象形态 */
    if (typeof data === 'object' && data?.activate === true) {
      void activateBackend()
      return
    }

    /** 控制台 frontend 发来的消息 → 转给 backend 的 Wall listener */
    if (frontendToBackend && typeof data === 'object' && data?.fromBackend !== true && typeof data?.event === 'string') {
      frontendToBackend({ event: data.event, payload: data.payload })
    }
  })
}
