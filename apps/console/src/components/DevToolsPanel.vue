<script setup lang="ts">
/**
 * DevTools 面板 —— 在控制台内嵌 Vue DevTools client（iframe）远程调试目标页
 *
 * 架构（Vue devtools-kit iframe preset 的远程化）：
 *
 *   ┌─ Console 页 ────────────────────────────────────────────┐
 *   │  ┌─ iframe（官方 vue-devtools client SPA）─┐            │
 *   │  │ client channel（iframe preset）          │            │
 *   │  │   post → window.parent.postMessage      │            │
 *   │  │   on   ← message event                  │            │
 *   │  └──────────────┬──────────────────────────┘            │
 *   │                 │ postMessage（官方信封 SuperJSON 字符串）│
 *   │  本组件：校验 e.source === iframe.contentWindow          │
 *   │                 ↓                                        │
 *   │  sendDevtoolsRelay → WS devtools-relay → server → 设备  │
 *   │  onDevtoolsRelay  ← WS devtools-relay ← server ← 设备   │
 *   │                 ↓                                        │
 *   │  iframe.contentWindow.postMessage（原样回传）             │
 *   └──────────────────────────────────────────────────────────┘
 *
 * 关键点：
 * - client SPA 检测 self !== top 自动启用 iframe preset，无需修改官方产物
 * - 双向消息 payload 就是官方 SuperJSON 信封字符串，纯透传零解析
 * - e.source 校验防止其他 iframe/窗口消息串扰
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'

/**
 * devtools relay 桥接函数（由父组件从 useConsoleSocket 传入，避免重复建连） */
const props = defineProps<{
  /** 当前选中设备 ID（devtools-relay 路由用） */
  deviceId: string
  /** devtools 插件类型（当前只支持 vue） */
  plugin?: 'vue'
  /** 注册 devtools relay 监听器（useConsoleSocket 的 onDevtoolsRelay） */
  onRelay: (listener: (msg: { deviceId: string; plugin: string; payload: string }) => void) => () => void
  /** 发送 devtools relay 消息（useConsoleSocket 的 sendDevtoolsRelay） */
  send: (deviceId: string, plugin: 'vue' | 'react', payload: string) => void
}>()

/** 插件静态资源路径（server public/plugins/ 下，构建时从 plugins/ 复制） */
const PLUGIN_SRC: Record<string, string> = {
  vue: '/plugins/vue-devtools/index.html',
}

/** 与官方 iframe channel 一致的消息信封 key */
const IFRAME_MESSAGING_EVENT_KEY = '__devtools-kit-iframe-messaging-event-key__'

const iframeRef = ref<HTMLIFrameElement | null>(null)
/** 连接状态：收到第一条 backend 消息即认为链路通 */
const relayActive = ref(false)

/** 官方信封的最小结构校验（SuperJSON 字符串，不解析内容） */
function isDevtoolsEnvelope(data: unknown): data is string {
  return typeof data === 'string' && data.includes(IFRAME_MESSAGING_EVENT_KEY)
}

/** iframe → 设备：client 发来的 RPC 消息，转发到 WS */
function onWindowMessage(event: MessageEvent) {
  const iframe = iframeRef.value
  /** 只接受我们自己 iframe 的消息（防串扰） */
  if (!iframe || event.source !== iframe.contentWindow) return
  if (!isDevtoolsEnvelope(event.data)) return
  props.send(props.deviceId, props.plugin ?? 'vue', event.data as string)
}

/** 设备 → iframe：backend 的 RPC 响应，postMessage 回 iframe */
const unsubscribeRelay = props.onRelay((msg) => {
  if (msg.deviceId !== props.deviceId || msg.plugin !== (props.plugin ?? 'vue')) return
  relayActive.value = true
  const iframe = iframeRef.value
  iframe?.contentWindow?.postMessage(msg.payload, '*')
})

/** 设备切换时重置连接状态（client 会自动重新握手） */
watch(() => props.deviceId, () => {
  relayActive.value = false
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
    <!-- 状态条：链路未通时提示 -->
    <div
      v-if="!relayActive"
      class="px-3 py-1.5 text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 border-b border-base flex items-center gap-2"
    >
      <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      正在连接目标页的 Vue DevTools backend…（需要目标页注入了 SilkPulse SDK 且运行 Vue 3 应用）
    </div>
    <!-- 官方 client SPA：iframe preset 自动生效 -->
    <iframe
      ref="iframeRef"
      :src="PLUGIN_SRC[plugin ?? 'vue']"
      class="flex-1 w-full border-0 bg-white"
      title="Vue DevTools"
      allow="clipboard-write"
    />
  </div>
</template>
