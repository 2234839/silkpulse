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
import { useI18n } from "vue-i18n";
import { devToolsDocks, getDock } from "../utils/devtools-docks";
import { apiFetch } from "../utils/api";
import type { LogEntry, NetworkEntry } from "@silkpulse/shared";

const { t } = useI18n();

/**
 * devtools relay 桥接函数（由父组件从 useConsoleSocket 传入，避免重复建连） */
const props = defineProps<{
  /** 当前选中设备 ID（devtools-relay 路由用） */
  deviceId: string;
  /** devtools 插件类型（docks 注册表里的 plugin 标识，如 vue / react / elements） */
  plugin?: string;
  /** 锁定单个 dock（如 Element 页签锁 elements）：隐藏切换条且不受框架探测影响 */
  lockedPlugin?: string;
  /** 链路接通后自动把官方 frontend 切到此面板（如 Console 页签锁 elements dock 但聚焦官方面板栏的 Console） */
  focusPanel?: "console" | "elements";
  /** 设备上报的框架探测结果（自动选中用：只探测到一种时默认选它） */
  frameworks?: string[];
  /** 注册 devtools relay 监听器（useConsoleSocket 的 onDevtoolsRelay） */
  onRelay: (
    listener: (msg: { deviceId: string; plugin: string; payload: unknown }) => void,
  ) => () => void;
  /** 注册设备 reload 重连监听器（useConsoleSocket 的 onDeviceReconnect） */
  onReconnect: (listener: (deviceId: string) => void) => () => void;
  /** 发送 devtools relay 消息（useConsoleSocket 的 sendDevtoolsRelay） */
  send: (deviceId: string, plugin: string, payload: string | Record<string, unknown>) => void;
}>();

const iframeRef = ref<HTMLIFrameElement | null>(null);
/** 连接状态：收到第一条 backend 消息即认为链路通 */
const relayActive = ref(false);

/** 当前激活的 dock（由注册表驱动；plugin 取值受限于注册表；lockedPlugin 时恒定） */
const activePlugin = ref<string>(props.lockedPlugin ?? props.plugin ?? devToolsDocks[0].plugin);
const activeDock = computed(() => getDock(activePlugin.value));
/** 用户是否手动切换过插件（手动选择优先于自动探测） */
const userPicked = ref(false);

/** 设备框架探测结果到达 / 变化时：唯一可用的 dock 自动选中（锁定模式不参与） */
watch(
  () => props.frameworks,
  (fws) => {
    if (props.lockedPlugin || userPicked.value || !fws || fws.length !== 1) return;
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
  () => (props.frameworks ?? []).join(" + ") || t("devToolsPanel.none"),
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
    /** 锁定模式（elements）不依赖框架探测，不重载 */
    if (props.lockedPlugin || pluginUnsupported.value) return;
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
  const wasInactive = !relayActive.value;
  relayActive.value = true;
  iframe.contentWindow?.postMessage(data, "*");
  /** 链路首次接通：聚焦指定官方面板（iframe 宿主脚本轮询等面板栏渲染完成后点击） */
  if (wasInactive && props.focusPanel) {
    iframe.contentWindow?.postMessage(
      { event: "__silkpulse_switch_panel__", panel: props.focusPanel },
      "*",
    );
  }
  /** 链路首次接通（elements dock）：把 server 缓冲的日志/网络历史注入官方面板 */
  if (wasInactive && activePlugin.value === "elements") {
    void injectServerHistory();
  }
});

/** CDP 日志级别映射（LogEntry.type → consoleAPICalled.type） */
const CDP_LOG_TYPE: Record<string, string> = {
  info: "info",
  warn: "warning",
  error: "error",
  debug: "debug",
  trace: "trace",
  table: "table",
  dir: "dir",
  time: "log",
  count: "log",
  assert: "error",
  group: "startGroup",
  groupEnd: "endGroup",
  clear: "clear",
};

/**
 * 拉 server 缓冲的日志 + 网络历史并注入官方 Console / Network 面板
 *
 * 官方 Console/Network 只显示 enable 之后收到的 CDP 事件；设备端只回放
 * 本机内存历史（页面 reload 后为空），server 端持久化的历史（含重启恢复
 * + 页面刷新前）由控制台拉 REST API 补齐。
 */
async function injectServerHistory(): Promise<void> {
  const iframe = iframeRef.value;
  if (!iframe) return;
  try {
    const logs = (await (
      await apiFetch(`/api/devices/${props.deviceId}/logs`)
    ).json()) as LogEntry[];
    for (const entry of logs) {
      const event = {
        method: "Runtime.consoleAPICalled",
        params: {
          type: CDP_LOG_TYPE[entry.type] ?? "log",
          args: [{ type: "string", value: entry.message }],
          executionContextId: 1,
          timestamp: Date.parse(entry.timestamp) / 1000 || Date.now() / 1000,
        },
      };
      iframe.contentWindow?.postMessage(JSON.stringify(event), "*");
    }
  } catch {
    /** 历史拉取失败不影响实时链路，官方面板从当下开始收 */
  }
  try {
    const network = (await (
      await apiFetch(`/api/devices/${props.deviceId}/network`)
    ).json()) as NetworkEntry[];
    for (const entry of network) {
      postNetworkHistoryEntry(iframe, entry);
    }
  } catch {
    /** 同上 */
  }
}

/** network 资源类型映射（与 SDK 侧 resourceType 一致，官方 waterfall 图标用） */
function cdpResourceType(entry: NetworkEntry): string {
  if (entry.protocol === "ws" || entry.kind === "ws") return "WebSocket";
  if (entry.kind === "xhr") return "XHR";
  const mime = entry.mimeType ?? entry.resBodyMime ?? "";
  if (mime.includes("javascript")) return "Script";
  if (mime.includes("css")) return "Stylesheet";
  if (mime.startsWith("image")) return "Image";
  return "Fetch";
}

/** 把一条 server 历史 network entry 合成 requestWillBeSent + response/loading 事件注入 iframe */
function postNetworkHistoryEntry(iframe: HTMLIFrameElement, entry: NetworkEntry): void {
  const requestId = `hist-net${entry.seq}`;
  const wallTime = Date.parse(entry.timestamp) / 1000 || Date.now() / 1000;
  const type = cdpResourceType(entry);
  iframe.contentWindow?.postMessage(
    JSON.stringify({
      method: "Network.requestWillBeSent",
      params: {
        requestId,
        loaderId: "",
        documentURL: "",
        request: {
          url: entry.url,
          method: entry.method,
          headers: entry.reqHeaders ?? {},
          initialPriority: "High",
          referrerPolicy: "strict-origin-when-cross-origin",
        },
        timestamp: wallTime,
        wallTime,
        initiator: { type: "other" },
        type,
      },
    }),
    "*",
  );
  if (entry.error) {
    iframe.contentWindow?.postMessage(
      JSON.stringify({
        method: "Network.loadingFailed",
        params: {
          requestId,
          timestamp: wallTime + (entry.duration ?? 0) / 1000,
          type,
          errorText: entry.error,
          canceled: false,
        },
      }),
      "*",
    );
    return;
  }
  const status = entry.status || 200;
  const headers = entry.resHeaders ?? {};
  const contentType = (headers["content-type"] ??
    headers["Content-Type"] ??
    entry.resBodyMime ??
    "") as string;
  const endTs = wallTime + (entry.duration ?? 0) / 1000;
  iframe.contentWindow?.postMessage(
    JSON.stringify({
      method: "Network.responseReceived",
      params: {
        requestId,
        loaderId: "",
        timestamp: endTs,
        type,
        response: {
          url: entry.url,
          status,
          statusText: status === 200 ? "OK" : "",
          headers,
          mimeType: contentType.split(";")[0] || "text/plain",
          connectionReused: false,
          connectionId: 0,
          remoteIPAddress: "",
          remotePort: 0,
          fromDiskCache: false,
          encodedDataLength: entry.resBodySize ?? -1,
          protocol: entry.protocol === "ws" || entry.kind === "ws" ? "websocket" : "http/1.1",
          securityState: "insecure",
        },
      },
    }),
    "*",
  );
  iframe.contentWindow?.postMessage(
    JSON.stringify({
      method: "Network.loadingFinished",
      params: {
        requestId,
        timestamp: endTs,
        encodedDataLength: entry.resBodySize ?? 0,
        shouldReportCorruptBlocking: false,
      },
    }),
    "*",
  );
}

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
    <!-- 插件切换（锁定模式隐藏：Element 页签只渲染官方 Elements 面板） -->
    <div class="px-3 py-1.5 border-b border-base flex items-center gap-3 text-xs bg-surface">
      <template v-if="!lockedPlugin">
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
            :title="t('devToolsPanel.frameworkDetectedTitle')"
          />
        </button>
      </template>
      <div class="ml-auto flex items-center gap-2">
        <!-- 父组件可选插入的动作按钮（如 Console 视图的「返回轻量面板」），与刷新/状态同行 -->
        <slot />
        <!-- 手动刷新：backend 原地广播最新树/状态（保留展开/选中状态，不重载 client）。
             生产构建的页面框架更新事件被编译时移除（无响应式推送），
             面板数据停留在握手时刻——点此拉新（dev 页也可用，等价于触发一次官方更新事件） -->
        <button
          :disabled="pluginUnsupported || refreshing"
          class="px-2 py-1 rounded-md transition-colors text-muted hover:bg-base disabled:opacity-40 disabled:cursor-not-allowed"
          :title="refreshing ? t('devToolsPanel.refreshingTitle') : t('devToolsPanel.refreshTitle')"
          @click="refreshData()"
        >
          <span :class="refreshing ? 'inline-block animate-spin' : 'inline-block'">⟳</span>
          {{ refreshing ? t("devToolsPanel.refreshing") : t("devToolsPanel.refresh") }}
        </button>
        <span v-if="relayActive" class="text-green-600 dark:text-green-400 flex items-center gap-1">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
          {{ t("devToolsPanel.connected") }}
        </span>
        <span v-else class="text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          {{ t("devToolsPanel.connecting") }}
        </span>
      </div>
    </div>
    <!-- 状态条：链路未通时提示（插件明确不支持时不显示，下方有独立提示区） -->
    <div
      v-if="!relayActive && !pluginUnsupported"
      class="px-3 py-1.5 text-xs text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/20 border-b border-base flex items-center gap-2"
    >
      <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      {{ t("devToolsPanel.connectingTo", { dock: activeDock.label }) }}
    </div>
    <!-- 插件明确不支持：明确提示，不加载 client（避免无意义的转圈等待） -->
    <div
      v-if="pluginUnsupported"
      class="flex-1 flex flex-col items-center justify-center gap-2 bg-surface text-muted p-6 text-center"
    >
      <div class="text-3xl">🚫</div>
      <div class="text-sm font-medium">
        {{ t("devToolsPanel.unsupportedTitle", { dock: activeDock.label }) }}
      </div>
      <div v-if="(frameworks ?? []).length > 0" class="text-xs">
        {{ t("devToolsPanel.unsupportedDetected", { detected: detectedLabel }) }}
      </div>
      <div v-else class="text-xs">
        {{ t("devToolsPanel.unsupportedNone") }}
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
