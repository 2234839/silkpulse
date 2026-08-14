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

