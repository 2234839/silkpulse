<script setup lang="ts">
/**
 * clarosight 控制台主组件
 *
 * 布局：左侧设备列表，右侧选中设备的 console / network / errors / snapshot 面板
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useConsoleSocket } from './composables/useConsoleSocket'
import SnapshotPanel from './components/SnapshotPanel.vue'
import ErrorsPanel from './components/ErrorsPanel.vue'
import ConsolePanel from './components/ConsolePanel.vue'
import NetworkPanel from './components/NetworkPanel.vue'
import ExecPanel from './components/ExecPanel.vue'
import ElementPanel from './components/ElementPanel.vue'
import StoragePanel from './components/StoragePanel.vue'
import { useAiContext } from './composables/useAiContext'
import { useTheme } from './composables/useTheme'
import { copyText } from './utils/clipboard'

const { theme, toggleTheme } = useTheme()

/**
 * 接入新设备：四种注入方式
 *
 * 部署地址动态取 location.origin（用户把 server 部署到任何 IP/端口都自动正确），
 * 不再写死 localhost。
 */
const serverOrigin = location.origin

/** script 标签方式（前端自己拼，最简单） */
/**
 * ⚠️ 不能直接写 script 标签字符串字面量：
 * Vue SFC 解析器扫整个文件找 script 结束标签来定位 script 块结束位置，
 * 字符串里的该标签会被误认为 script 块结束，导致后续 TS 全被当成 HTML 解析。
 * 拆开拼接绕开这个陷阱。
 */
const scriptSnippet = ['<script src="', serverOrigin, '/sdk.js"></s', 'cript>'].join('')

/** iife / bookmarklet / userscript 从 server 拉现成代码（前后端一处真相，未来改代码只改 server） */
const iifeSnippet = ref('')
const bookmarkletSnippet = ref('')
const userscriptSnippet = ref('')
fetch('/inject/iife').then((r) => r.text()).then((t) => { iifeSnippet.value = t })
fetch('/inject/bookmarklet').then((r) => r.text()).then((t) => { bookmarkletSnippet.value = t })
fetch('/inject/userscript').then((r) => r.text()).then((t) => { userscriptSnippet.value = t })

/** 当前激活的接入方式 Tab */
type InjectTab = 'script' | 'iife' | 'bookmarklet' | 'userscript'
const injectTab = ref<InjectTab>('script')

/** 当前正在复制的代码块（标识哪个按钮显示 ✓） */
const copyingInject = ref<InjectTab | null>(null)

/** 复制当前 Tab 对应的代码 */
async function copyInject() {
  const code =
    injectTab.value === 'script'
      ? scriptSnippet
      : injectTab.value === 'iife'
        ? iifeSnippet.value
        : injectTab.value === 'bookmarklet'
          ? bookmarkletSnippet.value
          : userscriptSnippet.value
  if (!code) return
  const ok = await copyText(code)
  if (ok) {
    copyingInject.value = injectTab.value
    setTimeout(() => {
      if (copyingInject.value === injectTab.value) copyingInject.value = null
    }, 1500)
  }
}

/** 当前 Tab 对应的代码内容（只读展示用） */
const currentInjectSnippet = computed(() => {
  if (injectTab.value === 'script') return scriptSnippet
  if (injectTab.value === 'iife') return iifeSnippet.value
  if (injectTab.value === 'bookmarklet') return bookmarkletSnippet.value
  return userscriptSnippet.value
})

const {
  devices,
  logs,
  network,
  errors,
  storageVersion,
  storageUpdateTime,
  storageKeyTimes,
  domChangeVersion,
  domChangeData,
  selectedDeviceId,
  connected,
  connect,
  selectDevice,
  setWatchers,
} = useConsoleSocket()

const {
  contextText,
  generating,
  copyState,
  generate: generateAiContext,
  copyToClipboard,
} = useAiContext()

/** 当前选中的设备对象（供 AI 上下文取 title/url） */
const selectedDevice = computed(() =>
  devices.value.find((d) => d.id === selectedDeviceId.value) ?? null
)

/** favicon 加载失败时隐藏 img，露出后备 emoji */
function onFaviconError(e: Event) {
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
}

/** 从 User-Agent 解析操作系统名称 */
function detectOS(ua: string): string {
  if (/Windows NT 10/.test(ua)) return 'Windows'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Mac OS X ([\d_]+)/.test(ua)) {
    const m = ua.match(/Mac OS X ([\d_]+)/)
    return 'macOS ' + (m?.[1]?.replace(/_/g, '.') ?? '')
  }
  if (/Android ([\d.]+)/.test(ua)) {
    const m = ua.match(/Android ([\d.]+)/)
    return 'Android ' + (m?.[1] ?? '')
  }
  if (/iPhone OS ([\d_]+)/.test(ua)) {
    const m = ua.match(/iPhone OS ([\d_]+)/)
    return 'iOS ' + (m?.[1]?.replace(/_/g, '.') ?? '')
  }
  if (/iPad.*OS ([\d_]+)/.test(ua)) {
    const m = ua.match(/OS ([\d_]+)/)
    return 'iPadOS ' + (m?.[1]?.replace(/_/g, '.') ?? '')
  }
  if (/Linux/.test(ua)) return 'Linux'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  return 'Unknown'
}

/** 设备类型 → emoji 图标（favicon 加载失败时后备） */
const deviceTypeIcon = (t: string): string => {
  if (t === 'mobile') return '📱'
  if (t === 'tablet') return '📲'
  return '🖥️'
}



/** 设备列表搜索（按标题/URL/类型 筛选） */
const deviceSearch = ref('')
const filteredDevices = computed(() => {
  const q = deviceSearch.value.trim().toLowerCase()
  if (!q) return devices.value
  return devices.value.filter((d) =>
    d.title.toLowerCase().includes(q)
    || d.url.toLowerCase().includes(q)
    || (d.deviceType ?? '').toLowerCase().includes(q)
    || (d.tags ?? []).some((t) => t.toLowerCase().includes(q))
    || (d.note ?? '').toLowerCase().includes(q)
  )
})

/** AI 诊断弹窗 */
const showAiModal = ref(false)

/** 接入新设备引导弹窗 */
const showInjectModal = ref(false)

/** 标签编辑：editingTagDeviceId 标记正在编辑哪台设备的标签 */
const editingTagDeviceId = ref<string | null>(null)
const tagDraft = ref('')
const noteDraft = ref('')

/** 进入标签编辑模式（预填当前 tags/note） */
function startEditTags(deviceId: string) {
  const d = devices.value.find((x) => x.id === deviceId)
  editingTagDeviceId.value = deviceId
  tagDraft.value = d?.tags?.join(', ') ?? ''
  noteDraft.value = d?.note ?? ''
}

/** 保存标签到 server（POST /api/devices/:id/tags） */
async function saveTags() {
  const id = editingTagDeviceId.value
  if (!id) return
  const tags = tagDraft.value.split(',').map((t) => t.trim()).filter(Boolean)
  const note = noteDraft.value.trim() || undefined
  try {
    await fetch(`/api/devices/${id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags, note }),
    })
  } catch {
    /** server 会广播 device-list 更新；失败也关闭编辑态 */
  }
  editingTagDeviceId.value = null
}

/** 取消编辑 */
function cancelEditTags() {
  editingTagDeviceId.value = null
}

/** 生成 AI 诊断上下文并弹窗展示 */
async function openAiContext() {
  if (!selectedDevice.value) return
  showAiModal.value = true
  await generateAiContext({
    deviceId: selectedDevice.value.id,
    title: selectedDevice.value.title,
    url: selectedDevice.value.url,
    errors: errors.value,
    network: network.value,
    logs: logs.value,
  })
}

/** 当前激活的面板 */
const activeTab = ref<'console' | 'network' | 'errors' | 'snapshot' | 'exec' | 'element' | 'storage'>('console')

/**
 * 面板切换时按需启停远程采集器
 *
 * 只有打开 Storage / Element 面板时才通知 SDK 采集对应数据，
 * 其他面板时关闭采集器减少不必要的 WS 消息。
 */
watch([activeTab, selectedDeviceId], () => {
  const id = selectedDeviceId.value
  if (!id) return
  const watchers: string[] = []
  if (activeTab.value === 'storage') watchers.push('storage')
  if (activeTab.value === 'element') watchers.push('dom')
  setWatchers(id, watchers)
})



/** Exec 面板：在控制台直接执行诊断代码 */











/**
 * 设备在线时长显示 —— 每 30 秒刷新 now，驱动相对时间重算
 *
 * 诊断时"设备接入了多久"是判断问题性质的关键线索（刚接入就报错 vs 接入 1 小时后才报错）。
 * 30 秒粒度够用：相对时间（"5 分钟前"）不需要秒级精度，低频刷新省 CPU。
 */
const now = ref(Date.now())
setInterval(() => { now.value = Date.now() }, 30000)

/** 把时间戳格式化为相对时长（"刚刚" / "3 分钟" / "1 小时" / "2 天") */
function relativeTime(ts: number): string {
  /** 依赖 now 让 Vue 在刷新时重算 */
  const elapsed = Math.max(0, now.value - ts)
  const mins = Math.floor(elapsed / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}



/**
 * Element 面板：DOM 树 + 元素诊断
 *
 * 设计（A+B 方案）：
 * - 左侧 DOM 树：懒加载，点展开时拉子元素（/element/tree?idx=N）
 * - 右侧诊断卡：点节点时拉详细诊断（/element/inspect?idx=N）
 *   返回可见性诊断 / 关键计算样式 / 盒模型 / 祖先链
 *
 * 复用 exec 通道下发诊断 JS，不新增 WS 协议。SDK 端 __clarosight_ensureIdx
 * 给所有元素打稳定 idx（不只交互元素），保证树节点和操作能对上。
 */



/**
 * Storage 面板：读写远程设备存储
 *
 * 设计：三个子 Tab（localStorage / sessionStorage / cookie），
 * 每条记录一行（key + value + 编辑/删除），顶部"新增"按钮。
 * 编辑/新增用行内 input（不弹窗，轻快）。
 *
 * 复用 server 的 /storage 端点（GET 读 / POST set|delete），
 * 底层走 exec 通道下发 localStorage.setItem 等代码，不新增 WS 协议。
 */

onMounted(() => connect())
</script>

<template>
  <div class="h-screen flex flex-col">
    <!-- 顶部栏 -->
    <header class="bg-gray-900 text-white px-6 py-3 flex items-center gap-4">
      <h1 class="text-lg font-semibold">clarosight</h1>
      <span class="text-xs text-gray-400">远程设备调试控制台</span>
      <span
        class="ml-auto flex items-center gap-2 text-xs"
        :class="connected ? 'text-green-400' : 'text-red-400'"
      >
        <span
          class="w-2 h-2 rounded-full"
          :class="connected ? 'bg-green-400' : 'bg-red-400'"
        />
        {{ connected ? '已连接' : '断开中' }}
      </span>
      <!-- 主题切换 -->
      <button
        @click="toggleTheme"
        class="px-2 py-1 text-xs rounded text-gray-300 hover:text-white hover:bg-white/10"
        :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'"
      >{{ theme === 'dark' ? '☀️' : '🌙' }}</button>
      <!-- 接入新设备引导 -->
      <button
        @click="showInjectModal = true"
        class="px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 flex items-center gap-1"
        title="查看三种方式把设备接入到本控制台"
      >➕ 接入新设备</button>
      <button
        v-if="selectedDevice"
        @click="openAiContext"
        :disabled="generating"
        class="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
      >
        <span v-if="generating">生成中...</span>
        <span v-else>✨ 复制 AI 诊断上下文</span>
      </button>
    </header>

    <div class="flex-1 flex overflow-hidden">
      <!-- 左侧：设备列表 -->
      <aside class="w-72 border-r border-base bg-surface overflow-y-auto flex flex-col">
        <div class="px-4 py-3 border-b border-base">
          <h2 class="text-sm font-semibold text-secondary">
            在线设备
            <span class="text-faint font-normal">({{ devices.length }})</span>
          </h2>
          <input
            v-model="deviceSearch"
            placeholder="搜索设备（标题/URL/类型）..."
            class="mt-2 w-full px-2 py-1 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
          />
        </div>
        <ul>
          <li
            v-for="d in filteredDevices"
            :key="d.id"
            @click="selectDevice(d.id)"
            class="px-4 py-3 border-b border-light cursor-pointer hover:bg-base relative"
            :class="selectedDeviceId === d.id ? 'bg-blue-soft border-l-2 border-l-blue-500' : ''"
          >
            <!-- 有错误时左侧红条 -->
            <span
              v-if="d.errorCount > 0"
              class="absolute left-0 top-0 bottom-0 w-1 bg-red-400"
            />
            <div class="text-sm font-medium text-primary truncate">
              <img
                v-if="d.icon"
                :src="d.icon"
                @error="onFaviconError"
                class="inline-block w-4 h-4 mr-1 align-text-bottom rounded-sm"
                alt=""
              /><span v-else class="mr-1">{{ deviceTypeIcon(d.deviceType) }}</span>{{ d.title }}
              <!-- 编辑标签按钮（仅选中时显示） -->
              <button
                v-if="selectedDeviceId === d.id && editingTagDeviceId !== d.id"
                @click.stop="startEditTags(d.id)"
                class="ml-1 text-faint hover:text-blue-500 text-xs align-middle"
                title="编辑标签/备注"
              >🏷️</button>
            </div>
            <div class="text-xs text-muted truncate">{{ d.url }}</div>
            <!-- tags 徽章 + 备注 -->
            <div v-if="(d.tags?.length || d.note) && editingTagDeviceId !== d.id" class="flex flex-wrap items-center gap-1 mt-1">
              <span
                v-for="tag in (d.tags ?? [])"
                :key="tag"
                class="px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-soft text-blue-key"
              >{{ tag }}</span>
              <span v-if="d.note" class="text-[10px] text-faint italic truncate max-w-[140px]" :title="d.note">{{ d.note }}</span>
            </div>
            <!-- 内联编辑态 -->
            <div v-if="editingTagDeviceId === d.id" class="mt-1 space-y-1" @click.stop>
              <input
                v-model="tagDraft"
                placeholder="标签（逗号分隔）"
                class="w-full px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
                @keydown.enter="saveTags"
                @keydown.escape="cancelEditTags"
              />
              <input
                v-model="noteDraft"
                placeholder="备注（可选）"
                class="w-full px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
                @keydown.enter="saveTags"
                @keydown.escape="cancelEditTags"
              />
              <div class="flex gap-1">
                <button @click="saveTags" class="px-2 py-0.5 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-700">保存</button>
                <button @click="cancelEditTags" class="px-2 py-0.5 text-[10px] bg-elevated text-secondary rounded bg-elevated-hover">取消</button>
              </div>
            </div>
            <div class="flex items-center gap-2 mt-1">
              <span class="text-xs text-faint">{{ detectOS(d.userAgent) }}</span>
              <span class="text-xs text-faint">· {{ d.deviceType }} {{ d.viewportWidth }}×{{ d.viewportHeight }}</span>
              <span v-if="d.onlineAt" class="text-xs text-faint" :title="new Date(d.onlineAt).toLocaleString()">· {{ relativeTime(d.onlineAt) }}</span>
              <span v-if="d.errorCount > 0" class="text-xs text-red-500 font-medium">{{ d.errorCount }} 错误</span>
            </div>
          </li>
          <li v-if="devices.length === 0" class="px-4 py-8 text-center text-sm text-faint">
            暂无在线设备
          </li>
          <li v-else-if="filteredDevices.length === 0" class="px-4 py-8 text-center text-sm text-faint">
            无匹配设备
          </li>
        </ul>
      </aside>

      <!-- 右侧：面板 -->
      <main class="flex-1 flex flex-col overflow-hidden">
        <template v-if="selectedDeviceId">
          <!-- Tab 栏 -->
          <nav class="flex border-b border-base bg-surface">
            <button
              v-for="tab in (['console', 'network', 'errors', 'snapshot', 'exec', 'element', 'storage'] as const)"
              :key="tab"
              @click="activeTab = tab"
              class="px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-1.5"
              :class="activeTab === tab
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-muted hover:text-primary'"
            >
              {{ tab === 'console' ? 'Console' : tab === 'network' ? 'Network' : tab === 'errors' ? 'Errors' : tab === 'snapshot' ? 'Snapshot' : tab === 'exec' ? 'Exec' : tab === 'element' ? 'Element' : 'Storage' }}
              <!-- 数量徽标：Console/Network/Errors 显示条数，Errors 有错误时红色高亮 -->
              <span
                v-if="tab === 'console' && logs.length > 0"
                class="text-xs px-1.5 py-0.5 rounded bg-blue-soft text-secondary"
              >{{ logs.length }}</span>
              <span
                v-else-if="tab === 'network' && network.length > 0"
                class="text-xs px-1.5 py-0.5 rounded bg-blue-soft text-secondary"
              >{{ network.length }}</span>
              <span
                v-else-if="tab === 'errors' && errors.length > 0"
                class="text-xs px-1.5 py-0.5 rounded font-medium"
                :class="activeTab === 'errors' ? 'bg-red-600 text-white' : 'bg-red-100 text-red-600'"
              >{{ errors.length }}</span>
            </button>
          </nav>

          <!-- Console 面板（含级别筛选 + 搜索 + 底部代码执行输入行） -->
          <ConsolePanel
            v-if="activeTab === 'console'"
            :logs="logs"
            :device-id="selectedDeviceId"
          />

          <!-- Network 面板（主从布局：请求列表 + 详情） -->
          <NetworkPanel
            v-else-if="activeTab === 'network'"
            :network="network"
          />

          <!-- Errors 面板 -->
          <ErrorsPanel
            v-else-if="activeTab === 'errors'"
            :errors="errors"
          />

          <!-- Snapshot 面板（搜索过滤 + 复制） -->
          <SnapshotPanel
            v-else-if="activeTab === 'snapshot'"
            :device-id="selectedDeviceId"
          />

          <!-- Element 面板（DOM 树 + 元素诊断卡） -->
          <ElementPanel
            v-else-if="activeTab === 'element'"
            :device-id="selectedDeviceId"
            :dom-change-version="domChangeVersion"
            :dom-change-data="domChangeData"
          />

          <!-- Storage 面板（读写远程设备 localStorage/sessionStorage/Cookie） -->
          <StoragePanel
            v-else-if="activeTab === 'storage'"
            :device-id="selectedDeviceId"
            :storage-version="storageVersion"
            :storage-update-time="storageUpdateTime"
            :storage-key-times="storageKeyTimes"
          />

          <!-- Exec 面板（在控制台直接执行诊断代码） -->
          <ExecPanel
            v-else-if="activeTab === 'exec'"
            :device-id="selectedDeviceId"
          />
        </template>

        <!-- 未选中设备时的占位 -->
        <div v-else class="flex-1 flex items-center justify-center text-faint overflow-y-auto">
          <div class="text-center max-w-lg w-full px-6 py-8">
            <p class="text-sm mb-6">从左侧选择一个设备查看详情</p>

            <!-- 接入新设备 -->
            <div class="bg-surface border border-base rounded-lg p-4 text-left">
              <h3 class="text-sm font-semibold text-primary mb-3">接入新设备</h3>

              <!-- Tab 切换 -->
              <div class="flex gap-1 mb-3 border-b border-light">
                <button
                  v-for="tab in (['script', 'iife', 'bookmarklet', 'userscript'] as const)"
                  :key="tab"
                  @click="injectTab = tab"
                  class="px-3 py-1.5 text-xs font-medium border-b-2 -mb-px"
                  :class="injectTab === tab
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-muted hover:text-primary'"
                >
                  {{ tab === 'script' ? 'Script 标签' : tab === 'iife' ? 'IIFE 立即执行' : tab === 'bookmarklet' ? 'Bookmarklet' : 'Userscript' }}
                </button>
              </div>

              <!-- 场景说明 -->
              <p class="text-xs text-muted mb-2">
                {{
                  injectTab === 'script'
                    ? '适合：能改源码的项目（自己的网站 / App）'
                    : injectTab === 'iife'
                      ? '适合：临时调试某个页面，F12 打开 console 粘贴即注入'
                      : injectTab === 'bookmarklet'
                        ? '适合：改不了源码的线上站，临时接入一次'
                        : '适合：长期调试某个站，Tampermonkey 自动注入'
                }}
              </p>

              <!-- 代码块 + 复制按钮 -->
              <div class="relative">
                <pre class="bg-base border border-input rounded p-3 pr-16 text-[11px] font-mono text-primary overflow-x-auto whitespace-pre-wrap break-all max-h-48">{{ currentInjectSnippet || '加载中...' }}</pre>
                <button
                  @click="copyInject"
                  :disabled="!currentInjectSnippet"
                  class="absolute top-2 right-2 px-2 py-1 text-[10px] font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >{{ copyingInject === injectTab ? '✓ 已复制' : '复制' }}</button>
              </div>

              <!-- 粘贴位置 -->
              <p class="text-[11px] text-faint mt-2">
                {{
                  injectTab === 'script'
                    ? '→ 粘贴到目标页面的 HTML 里（如 index.html 的 <head> 或 <body> 顶部），重新部署/刷新即接入'
                    : injectTab === 'iife'
                      ? '→ F12 打开目标页面的 DevTools console，粘贴上面代码回车即注入（页面刷新后失效）'
                      : injectTab === 'bookmarklet'
                        ? '→ 复制后新建书签，URL 粘贴为上面的代码；在目标页面点这个书签即注入'
                        : '→ 粘贴到 Tampermonkey/Greasemonkey 新建的脚本里，保存后自动在所有页面生效'
                }}
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>

    <!-- AI 诊断上下文弹窗 -->
    <div
      v-if="showAiModal"
      class="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      @click.self="showAiModal = false"
    >
      <div class="bg-surface rounded-lg shadow-xl w-[720px] max-h-[80vh] flex flex-col">
        <div class="flex items-center justify-between px-5 py-3 border-b border-base">
          <h3 class="text-sm font-semibold text-primary">AI 诊断上下文</h3>
          <div class="flex items-center gap-2">
            <button
              @click="copyToClipboard"
              class="px-3 py-1 text-xs rounded font-medium"
              :class="copyState === 'copied'
                ? 'bg-green-100 text-green-700'
                : copyState === 'error'
                ? 'bg-red-100 text-red-700'
                : 'bg-elevated text-secondary bg-elevated-hover'"
            >
              {{ copyState === 'copied' ? '✓ 已复制' : copyState === 'error' ? '复制失败' : '复制全部' }}
            </button>
            <button
              @click="showAiModal = false"
              class="px-3 py-1 text-xs rounded bg-elevated text-secondary bg-elevated-hover"
            >
              关闭
            </button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto p-5">
          <pre v-if="generating" class="text-sm text-faint">正在拉取设备快照...</pre>
          <pre v-else class="text-xs font-mono text-primary whitespace-pre-wrap">{{ contextText }}</pre>
        </div>
      </div>
    </div>

    <!-- 接入新设备引导弹窗 -->
    <div
      v-if="showInjectModal"
      class="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      @click.self="showInjectModal = false"
    >
      <div class="bg-surface rounded-lg shadow-xl w-[560px] max-h-[80vh] flex flex-col">
        <div class="flex items-center justify-between px-5 py-3 border-b border-base">
          <h3 class="text-sm font-semibold text-primary">接入新设备</h3>
          <button
            @click="showInjectModal = false"
            class="px-3 py-1 text-xs rounded bg-elevated text-secondary bg-elevated-hover"
          >
            关闭
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-5">
          <!-- Tab 切换 -->
          <div class="flex gap-1 mb-3 border-b border-light">
            <button
              v-for="tab in (['script', 'iife', 'bookmarklet', 'userscript'] as const)"
              :key="tab"
              @click="injectTab = tab"
              class="px-3 py-1.5 text-xs font-medium border-b-2 -mb-px"
              :class="injectTab === tab
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-muted hover:text-primary'"
            >
              {{ tab === 'script' ? 'Script 标签' : tab === 'iife' ? 'IIFE 立即执行' : tab === 'bookmarklet' ? 'Bookmarklet' : 'Userscript' }}
            </button>
          </div>

          <!-- 场景说明 -->
          <p class="text-xs text-muted mb-2">
            {{
              injectTab === 'script'
                ? '适合：能改源码的项目（自己的网站 / App）'
                : injectTab === 'iife'
                  ? '适合：临时调试某个页面，F12 打开 console 粘贴即注入'
                  : injectTab === 'bookmarklet'
                    ? '适合：改不了源码的线上站，临时接入一次'
                    : '适合：长期调试某个站，Tampermonkey 自动注入'
            }}
          </p>

          <!-- 代码块 + 复制按钮 -->
          <div class="relative">
            <pre class="bg-base border border-input rounded p-3 pr-16 text-[11px] font-mono text-primary overflow-x-auto whitespace-pre-wrap break-all max-h-48">{{ currentInjectSnippet || '加载中...' }}</pre>
            <button
              @click="copyInject"
              :disabled="!currentInjectSnippet"
              class="absolute top-2 right-2 px-2 py-1 text-[10px] font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >{{ copyingInject === injectTab ? '✓ 已复制' : '复制' }}</button>
          </div>

          <!-- 粘贴位置 -->
          <p class="text-[11px] text-faint mt-2">
            {{
              injectTab === 'script'
                ? '→ 粘贴到目标页面的 HTML 里（如 index.html 的 <head> 或 <body> 顶部），重新部署/刷新即接入'
                : injectTab === 'iife'
                  ? '→ F12 打开目标页面的 DevTools console，粘贴上面代码回车即注入（页面刷新后失效）'
                  : injectTab === 'bookmarklet'
                    ? '→ 复制后新建书签，URL 粘贴为上面的代码；在目标页面点这个书签即注入'
                    : '→ 粘贴到 Tampermonkey/Greasemonkey 新建的脚本里，保存后自动在所有页面生效'
            }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
