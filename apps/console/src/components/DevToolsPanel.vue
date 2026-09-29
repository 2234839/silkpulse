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
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { devToolsDocks, getDock } from "../utils/devtools-docks";

/**
 * devtools relay 桥接函数（由父组件从 useConsoleSocket 传入，避免重复建连） */
const props = defineProps<{
  /** 当前选中设备 ID（devtools-relay 路由用） */
  deviceId: string;
  /** devtools 插件类型（vue / react） */
  plugin?: "vue" | "react";
  /** 设备上报的框架探测结果（自动选中用：只探测到一种时默认选它） */
  frameworks?: string[];
  /** 注册 devtools relay 监听器（useConsoleSocket 的 onDevtoolsRelay） */
  onRelay: (
    listener: (msg: { deviceId: string; plugin: string; payload: unknown }) => void,
  ) => () => void;
  /** 注册设备 reload 重连监听器（useConsoleSocket 的 onDeviceReconnect） */
  onReconnect: (listener: (deviceId: string) => void) => () => void;
  /** 发送 devtools relay 消息（useConsoleSocket 的 sendDevtoolsRelay） */
  send: (
    deviceId: string,
    plugin: string,
    payload: string | Record<string, unknown>,
  ) => void;
}>();

const iframeRef = ref<HTMLIFrameElement | null>(null);
/** 连接状态：收到第一条 backend 消息即认为链路通 */
const relayActive = ref(false);

/** 当前激活的 dock（由注册表驱动；plugin 取值受限于注册表） */
const activePlugin = ref<string>((props.plugin as string) ?? devToolsDocks[0].plugin);
const activeDock = computed(() => getDock(activePlugin.value));
/** 用户是否手动切换过插件（手动选择优先于自动探测） */
const userPicked = ref(false);

/** 设备框架探测结果到达 / 变化时：唯一可用的 dock 自动选中 */
watch(
  () => props.frameworks,
  (fws) => {
    if (userPicked.value || !fws || fws.length !== 1) return;
    const only = devToolsDocks.find((d) => fws.includes(d.plugin));
    if (only) activePlugin.value = only.plugin;
  },
  { immediate: true },
);

/**
 * 当前 dock 是否不被目标页支持（委托 dock.isSupported 判定）
 */
const pluginUnsupported = computed(() => !activeDock.value.isSupported(props.frameworks));

/** 目标页实际检测到的框架名（不支持提示文案用，未知框架名原样显示） */
const detectedLabel = computed(
  () => (props.frameworks ?? []).join(" + ") || "无",
);

/** 探测结果到达后当前插件已不支持 → 重置连接状态（不再显示「已连接」误导） */
watch(pluginUnsupported, (unsupported) => {
  if (unsupported) relayActive.value = false;
});

/**
 * frameworks 变化时重载 client iframe
 *
 * 场景：script 先注入的 SPA（vite build），SDK 上报 frameworks=[] 后 Vue/React
 * app 才 mount，SDK 定期重报 frameworks=['vue']。若不重载，之前因「不支持」
 * 没加载的 client（或加载了但握不上手的 channel）无法自愈。重载即重新握手。
 *
 * ⚠️ 必须深比较：devices 心跳每次都产生新数组引用，浅 watch 会在用户操作中
 * 意外重载 iframe（选中/展开状态全丢）。只有框架集合内容真正变化才重载。
 */
watch(
  () => props.frameworks,
  (after, before) => {
    if (pluginUnsupported.value) return;
    /** 内容没变（纯引用变化，心跳刷新的常态）→ 不动 iframe */
    if (before && after && before.join(",") === after.join(",")) return;
    reloadIframe();
  },
  { deep: false },
);

/** 手动刷新：让 backend 原地广播最新树/状态（保留用户展开/选中状态）
 *
 * 不重载 iframe——重载会丢失用户在 client 里的操作状态。vue 走官方
 * SEND_INSPECTOR_TREE/STATE 事件流（client 原地更新）；react 走 reactivate
 * （bridge 重建后 flushInitialOperations 重发全量树，frontend 原地消费）。
 * 生产构建页面无框架推送时，这是用户「拉新」的唯一入口。
 *
 * 反馈：点击后 refreshing=true 转圈；backend 广播到达（onRelay 里收到
 * 响应即刷新生效）或 2s 超时自动复位——用户能确认点击已生效 */
const refreshing = ref(false);
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/** 刷新周期结束（backend 广播已到或超时兜底） */
function finishRefresh(): void {
  refreshing.value = false;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}

function refreshData(): void {
  if (pluginUnsupported.value || refreshing.value) return;
  refreshing.value = true;
  refreshTimer = setTimeout(finishRefresh, 2000);
  const dock = activeDock.value;
  if (dock.refreshPayload !== undefined) {
    props.send(props.deviceId, dock.plugin, dock.refreshPayload);
  } else {
    /** 无原地刷新语义的 dock（react）→ 重载 frontend iframe
     *
     * reactivate 虽然单发全量树（backend 侧已修复单次 flush），但 frontend
     * Store 是长驻的——旧树节点不会因新 operations 到达而清理，每次全量
     * mount 都叠加成 N 份树。官方扩展的 reload 语义 = 全新 Store 收初始树，
     * 这里重载 iframe 等价复刻：frontend 重新握手（ready → activate），
     * backend 侧 reactivateBackend 重建 bridge + agent，单次 flush 的初始
     * 树被全新 Store 消费，树恒为 1 份。
     * 代价：丢失面板内展开/选中状态（与官方 reload 一致） */
    reloadIframe();
  }
}

/** iframe → 设备：client 发来的消息，由当前 dock 编码后转发到 WS */
function onWindowMessage(event: MessageEvent) {
  const iframe = iframeRef.value;
  /** 只接受我们自己 iframe 的消息（防串扰） */
  if (!iframe || event.source !== iframe.contentWindow) return;
  const dock = activeDock.value;
  const payload = dock.encodeFromClient(event.data);
  if (payload === undefined) return;
  /** 握手信号（如 react activate 指令）：重置连接状态，等 backend 首条响应点亮 */
  if (dock.isHandshake?.(payload)) relayActive.value = false;
  props.send(props.deviceId, dock.plugin, payload);
}

/** 设备 → iframe：backend 的响应，由当前 dock 校验后 postMessage 回 iframe。
 *  另：刷新周期中收到广播 = 拉新已生效，提前结束转圈 */
const unsubscribeRelay = props.onRelay((msg) => {
  if (msg.deviceId !== props.deviceId || msg.plugin !== activePlugin.value) return;
  const iframe = iframeRef.value;
  if (!iframe) return;
  if (refreshing.value) finishRefresh();
  const data = activeDock.value.decodeFromBackend(msg.payload);
  if (data === undefined) return;
  relayActive.value = true;
  iframe.contentWindow?.postMessage(data, "*");
});

/** 重载 devtools iframe（frontend 重新握手：react 重发 activate，vue 重建 RPC channel） */
function reloadIframe() {
  const iframe = iframeRef.value;
  if (!iframe) return;
  relayActive.value = false;
  iframe.src = activeDock.value.src;
}

/** 设备 reload 重连 → 重载 iframe（react 需重发 activate，vue 需重新握手 RPC channel） */
const unsubscribeReconnect = props.onReconnect((deviceId) => {
  if (deviceId !== props.deviceId) return;
  reloadIframe();
});

/** 设备/插件切换时重载 client iframe（frontend 重新握手）
 *
 * 两种插件都必须重载：
 * - react：frontend 需重新 initialize + 重发 activate
 * - vue：旧设备的树/状态已渲染在 client 里，不重载会继续显示旧设备
 *   数据（「已连接」但内容是上一台设备的）。重载后 client 重新握手
 *   RPC channel 并主动拉新设备的树/状态 */
watch([() => props.deviceId, activePlugin], () => {
  relayActive.value = false;
  reloadIframe();
});

onMounted(() => {
  window.addEventListener("message", onWindowMessage);
});

onBeforeUnmount(() => {
  window.removeEventListener("message", onWindowMessage);
  unsubscribeRelay();
  unsubscribeReconnect();
});
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- 插件切换（vue / react） -->
    <div class="px-3 py-1.5 border-b border-base flex items-center gap-3 text-xs bg-surface">
      <button
        v-for="d in devToolsDocks"
        :key="d.plugin"
        :class="[
          'px-2.5 py-1 rounded-md transition-colors',
          activePlugin === d.plugin
            ? 'bg-blue-600 text-white font-medium'
            : 'text-muted hover:bg-base',
        ]"
        @click="
          userPicked = true;
          activePlugin = d.plugin;
        "
      >
        {{ d.label }}
        <span
          v-if="frameworks?.includes(d.plugin)"
          class="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-green-500 align-middle"
          title="目标页检测到该框架"
        />
      </button>
      <div class="ml-auto flex items-center gap-2">
        <!-- 手动刷新：backend 原地广播最新树/状态（保留展开/选中状态，不重载 client）。
             生产构建的页面框架更新事件被编译时移除（无响应式推送），
             面板数据停留在握手时刻——点此拉新（dev 页也可用，等价于触发一次官方更新事件） -->
        <button
          :disabled="pluginUnsupported || refreshing"
          class="px-2 py-1 rounded-md transition-colors text-muted hover:bg-base disabled:opacity-40 disabled:cursor-not-allowed"
          :title="
            refreshing
              ? '正在拉取最新数据…'
              : '原地拉取最新组件树与数据（保留当前展开/选中状态）。生产构建的页面没有框架更新推送，数据不会自动更新，需要时点此刷新'
          "
          @click="refreshData()"
        >
          <span :class="refreshing ? 'inline-block animate-spin' : 'inline-block'">⟳</span>
          {{ refreshing ? "刷新中…" : "刷新" }}
        </button>
        <span v-if="relayActive" class="text-green-600 dark:text-green-400 flex items-center gap-1">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
          已连接
        </span>
        <span v-else class="text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          连接中…
        </span>
      </div>
    </div>
    <!-- 状态条：链路未通时提示（插件明确不支持时不显示，下方有独立提示区） -->
    <div
      v-if="!relayActive && !pluginUnsupported"
      class="px-3 py-1.5 text-xs text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/20 border-b border-base flex items-center gap-2"
    >
      <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      正在连接目标页的 {{ activeDock.label }} DevTools backend…（需要目标页注入了
      SilkPulse SDK 且运行 {{ activeDock.label }} 应用）
    </div>
    <!-- 插件明确不支持：明确提示，不加载 client（避免无意义的转圈等待） -->
    <div
      v-if="pluginUnsupported"
      class="flex-1 flex flex-col items-center justify-center gap-2 bg-surface text-muted p-6 text-center"
    >
      <div class="text-3xl">🚫</div>
      <div class="text-sm font-medium">
        当前页面不支持 {{ activeDock.label }} DevTools
      </div>
      <div v-if="(frameworks ?? []).length > 0" class="text-xs">
        目标页是 {{ detectedLabel }} 应用，请切换到对应插件
      </div>
      <div v-else class="text-xs">
        目标页未检测到 Vue / React 应用（纯静态页或未接入框架的页面无法使用 DevTools）
      </div>
    </div>
    <!-- devtools client：vue 官方 SPA / react 自建 frontend -->
    <iframe
      v-else
      ref="iframeRef"
      :src="activeDock.src"
      class="flex-1 w-full border-0 bg-white"
      :title="activeDock.label + ' DevTools'"
      allow="clipboard-write"
    />
  </div>
</template>
