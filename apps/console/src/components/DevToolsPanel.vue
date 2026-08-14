<script setup lang="ts">
/**
 * DevTools 面板 —— 在控制台内嵌 Vue/React DevTools client（iframe）远程调试目标页
 *
 * 架构（Vue devtools-kit iframe preset 的远程化）：
 *
 *   ┌─ Console 页 ────────────────────────────────────────────┐
 *   │  ┌─ iframe（devtools client）────────────┐            │
 *   │  │ vue: 官方 SPA（iframe preset）         │            │
 *   │  │ react: frontend.bundle + custom Wall   │            │
 *   │  └──────────────┬─────────────────────────┘            │
 *   │                 │ postMessage                             │
 *   │  本组件：校验 e.source === iframe.contentWindow          │
 *   │                 ↓                                        │
 *   │  sendDevtoolsRelay → WS devtools-relay → server → 设备  │
 *   │  onDevtoolsRelay  ← WS devtools-relay ← server ← 设备   │
 *   │                 ↓                                        │
 *   │  iframe.contentWindow.postMessage（原样回传）             │
 *   └──────────────────────────────────────────────────────────┘
 *
 * 消息协议（两种插件不同）：
 * - vue：官方 SuperJSON 信封字符串（含 iframe-messaging-event-key），纯透传
 * - react：{ event, payload, fromBackend? } 对象；控制台首次发 { activate: true }
 *   请求设备端激活 backend Agent
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'

/**
 * devtools relay 桥接函数（由父组件从 useConsoleSocket 传入，避免重复建连） */
const props = defineProps<{
  /** 当前选中设备 ID（devtools-relay 路由用） */
  deviceId: string
  /** devtools 插件类型（vue / react） */
  plugin?: 'vue' | 'react'
  /** 注册 devtools relay 监听器（useConsoleSocket 的 onDevtoolsRelay） */
  onRelay: (listener: (msg: { deviceId: string; plugin: string; payload: unknown }) => void) => () => void
  /** 发送 devtools relay 消息（useConsoleSocket 的 sendDevtoolsRelay） */
  send: (deviceId: string, plugin: 'vue' | 'react', payload: unknown) => void
}>()

/** 插件静态资源路径（server public/plugins/ 下，构建时从 plugins/ 复制） */
const PLUGIN_SRC: Record<string, string> = {
  vue: '/plugins/vue-devtools/index.html',
  react: '/plugins/react-devtools/index.html',
}

/** 插件中文名（状态条提示用） */
const PLUGIN_LABEL: Record<string, string> = {
  vue: 'Vue',
  react: 'React',
}

/** 与官方 iframe channel 一致的消息信封 key */
const IFRAME_MESSAGING_EVENT_KEY = '__devtools-kit-iframe-messaging-event-key__'

const iframeRef = ref<HTMLIFrameElement | null>(null)
/** 连接状态：收到第一条 backend 消息即认为链路通 */
const relayActive = ref(false)
/** 当前插件（默认 vue，可切换） */
const activePlugin = ref<'vue' | 'react'>((props.plugin as 'vue' | 'react') ?? 'vue')

/** vue 官方信封的最小结构校验（SuperJSON 字符串，不解析内容） */
function isVueEnvelope(data: unknown): data is string {
  return typeof data === 'string' && data.includes(IFRAME_MESSAGING_EVENT_KEY)
}

/** react 消息校验：{ event: string, ... } 对象（fromBackend 标记来自设备端） */
function isReactFromFrontend(data: unknown): data is { event: string; payload?: unknown } {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  return typeof obj.event === 'string' && obj.fromBackend !== true
}

/** react frontend 就绪信号（宿主 HTML 发的内部事件） */
function isReactFrontendReady(data: unknown): boolean {
  return (
    typeof data === 'object' && data !== null &&
    (data as Record<string, unknown>).event === '__silkpulse_frontend_ready__'
  )
}

/** iframe → 设备：client 发来的消息，转发到 WS */
function onWindowMessage(event: MessageEvent) {
  const iframe = iframeRef.value
  /** 只接受我们自己 iframe 的消息（防串扰） */
  if (!iframe || event.source !== iframe.contentWindow) return

  if (activePlugin.value === 'vue') {
    if (!isVueEnvelope(event.data)) return
    props.send(props.deviceId, 'vue', event.data)
    return
  }

  /** react：frontend 就绪信号 → 请求设备激活 backend */
  if (isReactFrontendReady(event.data)) {
    relayActive.value = false
    props.send(props.deviceId, 'react', { activate: true })
    return
  }
  /** react：普通消息 → 透传给设备 backend */
  if (!isReactFromFrontend(event.data)) return
  const { event: evt, payload } = event.data
  props.send(props.deviceId, 'react', { event: evt, payload })
}

/** 设备 → iframe：backend 的响应，postMessage 回 iframe */
const unsubscribeRelay = props.onRelay((msg) => {
  if (msg.deviceId !== props.deviceId || msg.plugin !== activePlugin.value) return
  const iframe = iframeRef.value
  if (!iframe) return

  if (activePlugin.value === 'react') {
    /** react：backend 消息 { event, payload, fromBackend } → 原样 postMessage 给 frontend */
    const data = msg.payload as { event?: string; fromBackend?: boolean } | undefined
    if (typeof data !== 'object' || data === null || typeof data.event !== 'string') return
    relayActive.value = true
    iframe.contentWindow?.postMessage(data, '*')
    return
  }

  /** vue：backend 消息是 SuperJSON 信封字符串 → 原样回传 */
  relayActive.value = true
  iframe.contentWindow?.postMessage(msg.payload, '*')
})

/** 设备/插件切换时重置连接状态（client 会重新握手） */
watch([() => props.deviceId, activePlugin], () => {
  relayActive.value = false
  /** react：iframe 重载（frontend 需重新 initialize + 重发 activate） */
  if (activePlugin.value === 'react') {
    const iframe = iframeRef.value
    if (iframe) iframe.src = PLUGIN_SRC.react
    /** 新 iframe load 后会重发 frontend-ready → 触发 activate 流程 */
  }
})

onMounted(() => {
  window.addEventListener('message', onWindowMessage)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onWindowMessage)
  unsubscribeRelay()
})
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- 插件切换（vue / react） -->
    <div class="px-3 py-1.5 border-b border-base flex items-center gap-3 text-xs bg-surface">
      <button
        v-for="p in (['vue', 'react'] as const)"
        :key="p"
        :class="[
          'px-2.5 py-1 rounded-md transition-colors',
          activePlugin === p
            ? 'bg-blue-600 text-white font-medium'
            : 'text-muted hover:bg-base',
        ]"
        @click="activePlugin = p"
      >
        {{ PLUGIN_LABEL[p] }}
      </button>
      <span v-if="relayActive" class="ml-auto text-green-600 dark:text-green-400 flex items-center gap-1">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
        已连接
      </span>
      <span v-else class="ml-auto text-amber-600 dark:text-amber-400 flex items-center gap-1">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
        连接中…
      </span>
    </div>
    <!-- 状态条：链路未通时提示 -->
    <div
      v-if="!relayActive"
      class="px-3 py-1.5 text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 border-b border-base flex items-center gap-2"
    >
      <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      正在连接目标页的 {{ PLUGIN_LABEL[activePlugin] }} DevTools backend…（需要目标页注入了 SilkPulse SDK 且运行 {{ PLUGIN_LABEL[activePlugin] }} 应用）
    </div>
    <!-- devtools client：vue 官方 SPA / react 自建 frontend -->
    <iframe
      ref="iframeRef"
      :src="PLUGIN_SRC[activePlugin]"
      class="flex-1 w-full border-0 bg-white"
      :title="PLUGIN_LABEL[activePlugin] + ' DevTools'"
      allow="clipboard-write"
    />
  </div>
</template>
