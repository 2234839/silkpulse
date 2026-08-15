/**
 * Vue DevTools backend 桥接 —— 在目标页运行 devtools-kit，通过 SilkPulse WS 与控制台通信
 *
 * 架构：
 *   目标页（本文件）                SilkPulse server           控制台
 *   ┌────────────────────┐         ┌────────────┐         ┌──────────────────┐
 *   │ devtools-kit       │ devtools-relay        │ devtools-relay │ iframe:   │
 *   │ initDevTools()     │◄───────►│  透传      │◄───────►│ vue-devtools     │
 *   │ createRpcServer    │   (WS)  │            │   (WS)  │ client (官方SPA) │
 *   └────────────────────┘         └────────────┘         └──────────────────┘
 *
 * payload 约定（与官方 iframe channel 完全一致，控制台侧纯字符串透传）：
 *   payload = SuperJSON.stringify({ event: "__devtools-kit-iframe-messaging-event-key__", data })
 *
 * 关键点：
 * - backend 必须在 Vue app 创建前初始化（hook 会 replay 组件树事件）
 * - 不用 iframe preset（iframe 在控制台页，不在目标页），自定义 channel 对接 ws-client
 * - client SPA 检测 self !== top 自动选 iframe preset，与我们的 Console 桥天然匹配
 */

import { initDevTools, createRpcServer } from '@vue/devtools-kit'
import { functions as devtoolsFunctions } from '@vue/devtools-core'
import SuperJSON from 'superjson'
import { send } from './ws-client.js'
import { registerServerMessageHandler } from './message-router.js'

/** 与官方 iframe channel 一致的消息信封 key */
const IFRAME_MESSAGING_EVENT_KEY = '__devtools-kit-iframe-messaging-event-key__'

/** devtools 桥是否已初始化（防止 SDK 重复注入时双重初始化） */
let bridgeInitialized = false

/**
 * Agent DevTools 能力用：拿 devtools-core 的 RPC 函数集（本地直调，不走网络）
 *
 * getInspectorTree / getInspectorState / editInspectorState 等读写方法
 * 与 createRpcServer 注册的实现是同一份。页面无 Vue 应用时返回 null。
 */
export function getVueDevToolsFunctions(): Record<string, (...args: unknown[]) => Promise<unknown>> | null {
  const target = window as unknown as { __VUE_DEVTOOLS_GLOBAL_HOOK__?: { apps?: unknown[]; devtools?: unknown } }
  const hook = target.__VUE_DEVTOOLS_GLOBAL_HOOK__
  /** 无 app 注册 = 页面没有 Vue 应用（或尚未创建） */
  if (!hook?.apps?.length) return null
  return devtoolsFunctions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
}

/**
 * 后注入恢复：扫描 DOM 找已存在的 Vue app，补注册到 devtools-kit
 *
 * 场景：SDK 在页面 Vue app mount 之后才注入（如 exec 动态注入、
 * SSR 水合完成的页面）。此时 app:init 事件早已错过（甚至 prod 构建
 * 根本不发事件），但 Vue core 无条件在根容器上挂 `__vue_app__`
 * （apiCreateApp.ts），我们扫出来手动补发 app:init 即可。
 *
 * devtools-kit 的组件树是纯拉模式（ComponentWalker 现场遍历
 * instance.subTree），不依赖历史事件——补注册后树立即完整可用。
 *
 * prod 构建的 app 没有 `_instance`，devtools-kit 的 createAppRecord
 * 有 `app._container?._vnode?.component` 兜底（上游为此专门写的）。
 */
function recoverExistingVueApps(): void {
  const target = window as unknown as {
    __VUE_DEVTOOLS_GLOBAL_HOOK__?: { apps?: unknown[]; emit?: (event: string, ...args: unknown[]) => void }
  }
  const hook = target.__VUE_DEVTOOLS_GLOBAL_HOOK__
  if (!hook?.emit) return

  /** Vue3 Fragment/Text/Comment/Static 的 type 符号值（与 runtime-core vnode.ts 一致） */
  const vueTypes = {
    Fragment: Symbol.for('v-fgt'),
    Text: Symbol.for('v-txt'),
    Comment: Symbol.for('v-cmt'),
    Static: Symbol.for('v-stc'),
  }

  /** 全 DOM 扫描根容器（__vue_app__ 挂在 mount 容器上，开销可忽略：
   *  未注册 app 时短路在 includes 检查，无副作用） */
  const seen = new Set<unknown>()
  for (const el of document.querySelectorAll('*')) {
    const app = (el as unknown as { __vue_app__?: unknown }).__vue_app__
    if (!app || seen.has(app)) continue
    seen.add(app)
    /** 已注册过（正常时序注入，或官方 hook 自带）的不重复注册 */
    if (hook.apps?.includes(app)) continue
    const appObj = app as { version?: string }
    try {
      hook.emit('app:init', app, appObj.version ?? '3', vueTypes)
    } catch {
      /** 单个 app 恢复失败不阻塞其余 */
    }
  }
}

/**
 * 初始化 Vue DevTools backend
 *
 * 同步调用。必须在 Vue app 创建前执行（SDK 脚本是同步 IIFE，注入即执行，
 * 天然早于业务代码的 createApp）。
 */
export function initVueDevToolsBridge(): void {
  if (bridgeInitialized) return
  bridgeInitialized = true

  /** RPC server 的 on 回调集合（channel.on 每次调用追加一个 handler） */
  const messageHandlers: Array<(data: unknown) => void> = []

  /** 用官方完整 RPC 函数集（组件树/状态/inspector/路由等 40+ 个方法）注册 server */
  createRpcServer(
    devtoolsFunctions as Record<string, unknown>,
    {
      channel: {
        /** RPC server 要发消息 → 包上官方信封走 WS（用标准 SuperJSON，与 client SPA 的 channel 格式一致） */
        post: (data) => {
          const payload = SuperJSON.stringify({ event: IFRAME_MESSAGING_EVENT_KEY, data })
          send({
            type: 'devtools-relay',
            plugin: 'vue',
            payload,
          })
        },
        on: (handler) => {
          messageHandlers.push(handler)
        },
      },
    }
  )

  /** initDevTools 创建 __VUE_DEVTOOLS_GLOBAL_HOOK__，Vue app 创建时自动注册并回放事件 */
  initDevTools()

  /** 后注入兜底：页面已有 Vue app（prod 构建不发事件）时补注册 */
  recoverExistingVueApps()

  /** 定期补扫：后注入 + 后续动态 mount 的 app（SPA 路由级 createApp、延迟挂载的微前端子应用）
   *  轻量兜底，仅补漏——正常时序下 hook 的事件驱动注册是主路径。
   *  findRegistered 回调跳过已注册 app，扫全部元素开销极低（querySelectorAll + 属性检查） */
  setInterval(recoverExistingVueApps, 5000)

  /** 监听 server 转发的控制台 RPC 消息，解信封后交给 RPC server */
  registerServerMessageHandler((msg) => {
    if (msg.type !== 'devtools-relay' || msg.plugin !== 'vue') return
    if (typeof msg.payload !== 'string') return
    try {
      const parsed = SuperJSON.parse(msg.payload) as { event?: string; data?: unknown }
      if (parsed?.event !== IFRAME_MESSAGING_EVENT_KEY) return
      for (const handler of messageHandlers) handler(parsed.data)
    } catch {
      /** 非 SuperJSON 格式，忽略 */
    }
  })
}

