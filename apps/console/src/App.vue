<script setup lang="ts">
/**
 * clarosight 控制台主组件
 *
 * 布局：左侧设备列表，右侧选中设备的 console / network / errors / snapshot 面板
 */
import { ref, computed, watch, onMounted, useTemplateRef, nextTick } from 'vue'
import type { NetworkEntry } from '@clarosight/shared'
import { useConsoleSocket } from './composables/useConsoleSocket'
import { useSnapshot } from './composables/useSnapshot'
import { useAiContext } from './composables/useAiContext'
import { useTheme } from './composables/useTheme'
import { useExecHistory } from './composables/useExecHistory'
import { copyText } from './utils/clipboard'

const { theme, toggleTheme } = useTheme()
const { history: execHistory, record: recordExec, remove: removeExecHistory, clear: clearExecHistory } = useExecHistory()

const {
  devices,
  logs,
  network,
  errors,
  selectedDeviceId,
  connected,
  connect,
  selectDevice,
} = useConsoleSocket()

const { snapshotText, loading: snapLoading, fetchSnapshot } = useSnapshot()
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

/** 设备类型 → emoji 图标 */
const deviceTypeIcon = (t: string): string => {
  if (t === 'mobile') return '📱'
  if (t === 'tablet') return '📲'
  return '🖥️'
}

/** network 面板：选中的请求条目（点击展开详情） */
const selectedNetwork = ref<NetworkEntry | null>(null)

/** network 面板：cURL 复制状态（用于按钮反馈） */
const curlCopyState = ref<'idle' | 'copied'>('idle')

/**
 * 把 NetworkEntry 转成 cURL 命令
 *
 * 让 AI/开发者能直接在本地复现远程设备的请求。
 * 单引号转义：shell 单引号内用 '\'' 闭合再开。
 */
/** 格式化 headers 对象为 "k: v" 多行文本 */
function formatHeaders(h: Record<string, string>): string {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n')
}

function toCurl(n: NetworkEntry): string {
  const parts: string[] = [`curl -X ${n.method}`]
  if (n.reqHeaders) {
    for (const [k, v] of Object.entries(n.reqHeaders)) {
      const esc = v.replaceAll("'", "'\"'\"'")
      parts.push(`-H '${k}: ${esc}'`)
    }
  }
  if (n.reqBody) {
    const esc = n.reqBody.replaceAll("'", "'\"'\"'")
    parts.push(`--data '${esc}'`)
  }
  const urlEsc = n.url.replaceAll("'", "'\"'\"'")
  parts.push(`'${urlEsc}'`)
  return parts.join(' \\\n  ')
}

/** 复制选中请求的 cURL 命令到剪贴板 */
async function copyCurl() {
  if (!selectedNetwork.value) return
  const cmd = toCurl(selectedNetwork.value)
  await copyText(cmd)
  curlCopyState.value = 'copied'
  setTimeout(() => { curlCopyState.value = 'idle' }, 1500)
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
/** 当前激活的面板 */
const activeTab = ref<'console' | 'network' | 'errors' | 'snapshot' | 'exec'>('console')

/** 日志级别 → tailwind 颜色 */
const logColor = (type: string): string => {
  if (type === 'error') return 'text-red-600'
  if (type === 'warn') return 'text-amber-600'
  if (type === 'debug') return 'text-faint'
  return 'text-primary'
}

/**
 * 日志级别筛选按钮选中时的语义色
 *
 * 与日志文本配色对齐：error 红、warn 橙、info 蓝、debug 灰、all 深灰。
 * 让用户一眼分辨当前筛选级别，而非全灰色靠文字辨认。
 */
function levelActiveClass(lvl: string): string {
  if (lvl === 'error') return 'bg-red-600 text-white'
  if (lvl === 'warn') return 'bg-amber-500 text-white'
  if (lvl === 'info') return 'bg-blue-600 text-white'
  if (lvl === 'debug') return 'bg-gray-500 text-white'
  return 'bg-gray-800 text-white'
}

/** 某级别的日志条数（筛选按钮上显示计数） */
function levelCount(lvl: string): number {
  return logs.value.filter((l) => l.type === lvl).length
}

/** Console 面板：级别筛选 + 搜索 */
const logLevelFilter = ref<'all' | 'error' | 'warn' | 'info' | 'debug'>('all')
const logSearch = ref('')
/**
 * Console 清空阈值：只展示此时间戳之后的日志。
 *
 * 不删除 server 真相，只在前端视图层面隐藏 —— 用户"清空"后再来的新日志正常出现，
 * 切设备/刷新后阈值重置（logs.value 被重置，阈值也应重置）。
 * 与浏览器 DevTools 的 🚫 按钮语义一致。
 */
const clearedBeforeTs = ref(0)

/** 清空当前 Console 视图（仅前端隐藏，server 缓冲不受影响） */
function clearLogs() {
  clearedBeforeTs.value = Date.now()
}

/** Exec 面板：在控制台直接执行诊断代码 */
const execCode = ref('return document.title')
const execResult = ref('')
/** exec 执行后快照（独立展示，默认折叠，避免快照撑满结果区） */
const execSnapshot = ref('')
/** exec 执行状态：null 未执行 / true 成功 / false 失败（控制结果区配色） */
const execOk = ref<boolean | null>(null)
const execRunning = ref(false)

/** 执行诊断代码 */
async function runExec() {
  if (!selectedDeviceId.value || execRunning.value) return
  execRunning.value = true
  execResult.value = '执行中...'
  execSnapshot.value = ''
  execOk.value = null
  let ok = false
  try {
    const res = await fetch(`/api/devices/${selectedDeviceId.value}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: execCode.value }),
    })
    const data = await res.json()
    if (data.success) {
      ok = true
      const parts = [`=== 返回值 ===`, data.result ?? 'undefined']
      if (data.logs?.length) parts.push('', '=== 执行期间日志 ===', ...data.logs)
      execResult.value = parts.join('\n')
      /** 快照独立存储，渲染时折叠展示（快照几百字符，不该和返回值混排） */
      execSnapshot.value = data.snapshotText ?? ''
    } else {
      execResult.value = `✗ 执行失败: ${data.error}`
    }
  } catch (e) {
    execResult.value = `✗ 请求失败: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    execOk.value = ok
    /** 记录执行历史（成功/失败都记，失败也是试错过程的一部分） */
    recordExec(execCode.value, ok)
    execRunning.value = false
  }
}

/** 点击历史项回填到编辑区 */
function pickHistory(code: string) {
  execCode.value = code
}

/** Tab 键在 textarea 中插入两空格缩进（而非跳焦），方便写代码 */
function handleExecKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === 'Enter') {
    runExec()
    return
  }
  if (e.metaKey && e.key === 'Enter') {
    runExec()
    return
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    const ta = e.target as HTMLTextAreaElement
    const { selectionStart: start, selectionEnd: end, value } = ta
    execCode.value = value.slice(0, start) + '  ' + value.slice(end)
    /** 恢复光标位置（Vue 更新后） */
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + 2
    })
  }
}
/** 筛选后的日志（级别 + 关键词 + 清空阈值） */
const filteredLogs = computed(() => {
  let result = logs.value
  /** 清空阈值：隐藏"清空"之前的日志（前端视图层，server 缓冲不变） */
  if (clearedBeforeTs.value > 0) {
    result = result.filter((l) => new Date(l.timestamp).getTime() >= clearedBeforeTs.value)
  }
  if (logLevelFilter.value !== 'all') {
    result = result.filter((l) => l.type === logLevelFilter.value)
  }
  const q = logSearch.value.trim().toLowerCase()
  if (q) {
    result = result.filter((l) => l.message.toLowerCase().includes(q))
  }
  return result
})

/** console 面板日志列表 DOM 引用（自动滚动用） */
const logListEl = useTemplateRef<HTMLDivElement>('logListEl')

/**
 * 日志变化时自动滚动到底部
 *
 * 仅在用户已接近底部时自动滚（避免用户向上翻看历史时被强制拉回）。
 * 阈值 80px：离底部不足此值视为"在看最新"。
 */
watch(filteredLogs, async () => {
  await nextTick()
  const el = logListEl.value
  if (!el) return
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  if (distanceFromBottom < 80) {
    el.scrollTop = el.scrollHeight
  }
})

/** Errors 面板：关键词搜索（按 message / stack / mapped.source） */
const errorSearch = ref('')
const filteredErrors = computed(() => {
  const q = errorSearch.value.trim().toLowerCase()
  if (!q) return errors.value
  return errors.value.filter((e) => {
    if (e.message.toLowerCase().includes(q)) return true
    if (e.stack && e.stack.toLowerCase().includes(q)) return true
    if (e.mapped && e.mapped.source.toLowerCase().includes(q)) return true
    return false
  })
})

/** Network 面板：关键词搜索（按 URL / 方法 / 状态码）+ 状态码筛选 */
const networkSearch = ref('')
/**
 * 状态筛选：all 全部 / success 成功（2xx-3xx）/ error 失败（4xx-5xx 或未完成 status=0）
 *
 * 调试网络问题时最常用的维度 —— 失败请求和成功请求混在一起时，
 * 用户需要快速过滤出"哪些请求挂了"。status=0（请求未完成/网络中断）归入失败。
 */
const networkStatusFilter = ref<'all' | 'success' | 'error'>('all')
/**
 * 耗时排序：time（默认时间正序）/ desc（耗时降序，慢请求在最上）/ asc（耗时升序）
 *
 * 诊断"页面慢/卡"时，失败请求往往不是根因——真正的瓶颈是那些 status 200
 * 但耗时 2-3s 的慢请求。点"耗时"表头切到降序即可一眼定位，与 inspect CLI 的慢请求 Top 对齐。
 */
const networkDurationSort = ref<'time' | 'desc' | 'asc'>('time')
/** 慢请求阈值（ms），与 skill CLI inspect 的 SLOW_THRESHOLD 保持一致 */
const SLOW_THRESHOLD = 500
function toggleDurationSort() {
  if (networkDurationSort.value === 'time') networkDurationSort.value = 'desc'
  else if (networkDurationSort.value === 'desc') networkDurationSort.value = 'asc'
  else networkDurationSort.value = 'time'
}
const filteredNetwork = computed(() => {
  let result = network.value
  if (networkStatusFilter.value === 'success') {
    result = result.filter((n) => n.status >= 200 && n.status < 400)
  } else if (networkStatusFilter.value === 'error') {
    /** status=0 表示请求未完成（网络中断/CORS 失败），诊断时视为失败 */
    result = result.filter((n) => n.status === 0 || n.status >= 400)
  }
  const q = networkSearch.value.trim().toLowerCase()
  if (q) {
    result = result.filter((n) =>
      n.url.toLowerCase().includes(q) ||
      n.method.toLowerCase().includes(q) ||
      String(n.status).includes(q),
    )
  }
  /** 耗时排序：默认 time 不排（保持时间正序），desc/asc 按 duration 排 */
  if (networkDurationSort.value === 'desc') {
    result = [...result].sort((a, b) => b.duration - a.duration)
  } else if (networkDurationSort.value === 'asc') {
    result = [...result].sort((a, b) => a.duration - b.duration)
  }
  return result
})

/** 选中设备变化时拉取快照 + 清空 network 详情选中 + 重置 Console 清空阈值 */
watch(selectedDeviceId, (id) => {
  selectedNetwork.value = null
  clearedBeforeTs.value = 0
  if (id && activeTab.value === 'snapshot') {
    fetchSnapshot(id)
  }
})

/** 切到 snapshot 面板时拉取 */
watch(activeTab, (tab) => {
  if (tab === 'snapshot' && selectedDeviceId.value) {
    fetchSnapshot(selectedDeviceId.value)
  }
})

/** 刷新快照 */
function refreshSnapshot() {
  if (selectedDeviceId.value) fetchSnapshot(selectedDeviceId.value)
}

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
 * Snapshot 面板：行级搜索过滤
 *
 * 快照几百字符压缩整页结构，诊断"某个按钮在哪""表单有没有 disabled"时，
 * 用户输入关键词（如 "button" "disabled" "idx=12"）只显示匹配行，快速定位元素。
 * 空搜索展示全部。按行分割而非按字符——compact 快照每行一个元素，行是天然边界。
 */
const snapshotSearch = ref('')
const filteredSnapshotLines = computed(() => {
  const q = snapshotSearch.value.trim().toLowerCase()
  if (!q) return null /** null 表示无搜索，直接展示原文 */
  return snapshotText.value.split('\n').filter((line) => line.toLowerCase().includes(q))
})

/** Snapshot 复制状态（按钮反馈） */
const snapCopyState = ref<'idle' | 'copied'>('idle')
async function copySnapshot() {
  await copyText(snapshotText.value)
  snapCopyState.value = 'copied'
  setTimeout(() => { snapCopyState.value = 'idle' }, 1500)
}

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
              <span class="mr-1">{{ deviceTypeIcon(d.deviceType) }}</span>{{ d.title }}
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
              <span class="text-xs text-faint">{{ d.deviceType }} · {{ d.viewportWidth }}×{{ d.viewportHeight }}</span>
              <span v-if="d.onlineAt" class="text-xs text-faint" :title="new Date(d.onlineAt).toLocaleString()">· 在线 {{ relativeTime(d.onlineAt) }}</span>
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
              v-for="tab in (['console', 'network', 'errors', 'snapshot', 'exec'] as const)"
              :key="tab"
              @click="activeTab = tab"
              class="px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-1.5"
              :class="activeTab === tab
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-muted hover:text-primary'"
            >
              {{ tab === 'console' ? 'Console' : tab === 'network' ? 'Network' : tab === 'errors' ? 'Errors' : tab === 'snapshot' ? 'Snapshot' : 'Exec' }}
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

          <!-- Console 面板（含级别筛选 + 搜索） -->
          <div v-if="activeTab === 'console'" class="flex-1 flex flex-col overflow-hidden bg-base">
            <!-- 工具栏 -->
            <div class="flex items-center gap-2 px-4 py-2 border-b border-base bg-surface">
              <div class="flex gap-1">
                <button
                  v-for="lvl in (['all', 'error', 'warn', 'info', 'debug'] as const)"
                  :key="lvl"
                  @click="logLevelFilter = lvl"
                  class="px-2 py-0.5 text-xs rounded font-medium"
                  :class="logLevelFilter === lvl
                    ? levelActiveClass(lvl)
                    : 'bg-elevated text-secondary bg-elevated-hover'"
                >
                  {{ lvl === 'all' ? '全部' : lvl.toUpperCase() }}
                  <span v-if="lvl !== 'all' && levelCount(lvl) > 0" class="ml-1 opacity-75">{{ levelCount(lvl) }}</span>
                </button>
              </div>
              <input
                v-model="logSearch"
                placeholder="搜索日志..."
                class="ml-auto px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400 w-48"
              />
              <span class="text-xs text-faint">{{ filteredLogs.length }}/{{ logs.length }}</span>
              <!-- 清空视图（仅前端隐藏，server 缓冲不变，新日志正常出现） -->
              <button
                @click="clearLogs"
                class="px-2 py-0.5 text-xs rounded bg-elevated text-secondary hover:bg-elevated-hover"
                title="清空当前视图（新日志仍会出现）"
              >清空</button>
            </div>
            <!-- 日志列表 -->
            <div ref="logListEl" class="flex-1 overflow-y-auto p-4 font-mono text-sm">
              <div v-for="(log, i) in filteredLogs" :key="i" class="py-0.5 border-b border-light">
                <span class="text-faint text-xs mr-2">{{ new Date(log.timestamp).toLocaleTimeString() }}</span>
                <span class="text-faint text-xs mr-2 uppercase">{{ log.type }}</span>
                <span :class="logColor(log.type)">{{ log.message }}</span>
              </div>
              <div v-if="filteredLogs.length === 0" class="text-faint text-center py-8">
                {{ logs.length === 0 ? '暂无日志' : '无匹配日志' }}
              </div>
            </div>
          </div>

          <!-- Network 面板（主从布局：请求列表 + 详情） -->
          <div v-else-if="activeTab === 'network'" class="flex-1 flex overflow-hidden bg-base">
            <!-- 请求列表 -->
            <div class="w-2/5 flex flex-col border-r border-base">
              <!-- 搜索 + 状态筛选栏 -->
              <div class="p-2 border-b border-light bg-surface space-y-2">
                <input
                  v-model="networkSearch"
                  placeholder="搜索请求（URL / 方法 / 状态码）"
                  class="w-full text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
                />
                <!-- 状态筛选：全部 / 成功 / 失败 -->
                <div class="flex items-center gap-1">
                  <button
                    v-for="sf in (['all', 'success', 'error'] as const)"
                    :key="sf"
                    @click="networkStatusFilter = sf"
                    class="px-2 py-0.5 text-xs rounded font-medium"
                    :class="networkStatusFilter === sf
                      ? sf === 'error' ? 'bg-red-600 text-white' : 'bg-gray-800 text-white'
                      : 'bg-elevated text-secondary bg-elevated-hover'"
                  >{{ sf === 'all' ? '全部' : sf === 'success' ? '成功' : '失败' }}</button>
                  <span class="ml-auto text-xs text-faint">{{ filteredNetwork.length }}/{{ network.length }}</span>
                </div>
              </div>
              <div class="flex-1 overflow-y-auto">
                <table class="w-full text-sm">
                  <thead class="bg-elevated text-secondary text-xs uppercase sticky top-0">
                    <tr>
                      <th class="text-left px-3 py-2">时间</th>
                      <th class="text-left px-3 py-2">方法</th>
                      <th class="text-left px-3 py-2">状态</th>
                      <th class="text-left px-3 py-2">URL</th>
                      <th class="text-right px-3 py-2">
                        <button
                          @click="toggleDurationSort"
                          class="inline-flex items-center gap-0.5 hover:text-primary transition-colors"
                          :class="networkDurationSort !== 'time' ? 'text-primary' : ''"
                          :title="networkDurationSort === 'time' ? '点击按耗时降序' : networkDurationSort === 'desc' ? '当前：耗时降序（慢请求在上）' : '当前：耗时升序'"
                        >耗时<span class="text-[10px]">{{ networkDurationSort === 'desc' ? '▼' : networkDurationSort === 'asc' ? '▲' : '↕' }}</span></button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(n, i) in filteredNetwork"
                      :key="i"
                      @click="selectedNetwork = n"
                      class="border-b border-light cursor-pointer hover:bg-blue-soft"
                      :class="selectedNetwork === n ? 'bg-blue-soft' : ''"
                    >
                      <td class="px-3 py-2 text-faint text-xs font-mono whitespace-nowrap">{{ new Date(n.timestamp).toLocaleTimeString() }}</td>
                      <td class="px-3 py-2 text-secondary font-mono text-xs">{{ n.method }}</td>
                      <td class="px-3 py-2 font-mono text-xs" :class="n.status >= 400 ? 'text-red-500' : n.status >= 200 ? 'text-green-600' : 'text-faint'">
                        {{ n.status || '—' }}
                      </td>
                      <td class="px-3 py-2 text-primary truncate max-w-[160px] text-xs">{{ n.url.split('/').pop() || n.url }}</td>
                      <td
                        class="px-3 py-2 text-right text-xs font-mono"
                        :class="n.duration > SLOW_THRESHOLD ? 'text-amber-500 font-semibold' : 'text-muted'"
                        :title="n.duration > SLOW_THRESHOLD ? `慢请求（> ${SLOW_THRESHOLD}ms）` : ''"
                      >{{ n.duration }}ms</td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="filteredNetwork.length === 0" class="text-faint text-center py-8 text-sm">{{ network.length === 0 ? '暂无网络请求' : '无匹配请求' }}</div>
              </div>
            </div>

            <!-- 详情面板 -->
            <div class="flex-1 overflow-y-auto p-4">
              <template v-if="selectedNetwork">
                <div class="space-y-4">
                  <!-- 工具栏：复制为 cURL -->
                  <div class="flex justify-end">
                    <button
                      @click="copyCurl"
                      class="px-3 py-1.5 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary transition-colors"
                    >{{ curlCopyState === 'copied' ? '✓ 已复制' : '复制为 cURL' }}</button>
                  </div>
                  <!-- 基本信息 -->
                  <div>
                    <div class="text-xs text-faint mb-1">URL</div>
                    <div class="text-sm font-mono text-primary break-all bg-surface p-2 rounded border border-base">{{ selectedNetwork.url }}</div>
                  </div>
                  <div class="flex gap-6 text-sm">
                    <div><span class="text-faint">时间：</span><span class="font-mono text-primary">{{ new Date(selectedNetwork.timestamp).toLocaleString() }}</span></div>
                    <div><span class="text-faint">方法：</span><span class="font-mono text-primary">{{ selectedNetwork.method }}</span></div>
                    <div>
                      <span class="text-faint">状态：</span>
                      <span class="font-mono" :class="selectedNetwork.status >= 400 ? 'text-red-500' : 'text-green-600'">{{ selectedNetwork.status || '—' }}</span>
                    </div>
                    <div><span class="text-faint">耗时：</span><span class="font-mono text-primary">{{ selectedNetwork.duration }}ms</span></div>
                  </div>

                  <!-- 错误 -->
                  <div v-if="selectedNetwork.error" class="bg-red-soft border border-red-soft rounded p-3">
                    <div class="text-xs text-red-400 mb-1">错误</div>
                    <div class="text-sm text-red-key font-mono">{{ selectedNetwork.error }}</div>
                  </div>

                  <!-- 请求头 -->
                  <div v-if="selectedNetwork.reqHeaders">
                    <div class="text-xs text-faint mb-1">请求头</div>
                    <pre class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all">{{ formatHeaders(selectedNetwork.reqHeaders) }}</pre>
                  </div>

                  <!-- 响应头 -->
                  <div v-if="selectedNetwork.resHeaders">
                    <div class="text-xs text-faint mb-1">响应头</div>
                    <pre class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all">{{ formatHeaders(selectedNetwork.resHeaders) }}</pre>
                  </div>

                  <!-- 请求体 -->
                  <div v-if="selectedNetwork.reqBody">
                    <div class="text-xs text-faint mb-1">请求体</div>
                    <pre class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all">{{ selectedNetwork.reqBody }}</pre>
                  </div>

                  <!-- 响应体 -->
                  <div v-if="selectedNetwork.resBody">
                    <div class="text-xs text-faint mb-1">响应体</div>
                    <pre class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all">{{ selectedNetwork.resBody }}</pre>
                  </div>

                  <!-- 无 body 提示 -->
                  <div v-if="!selectedNetwork.reqBody && !selectedNetwork.resBody && !selectedNetwork.error" class="text-xs text-faint">
                    此请求无请求体/响应体（可能是 GET 请求或响应未完成）
                  </div>
                </div>
              </template>
              <div v-else class="text-faint text-center py-8 text-sm">点击左侧请求查看详情</div>
            </div>
          </div>

          <!-- Errors 面板 -->
          <div v-else-if="activeTab === 'errors'" class="flex-1 flex flex-col overflow-hidden bg-base">
            <!-- 搜索栏 -->
            <div class="p-2 border-b border-base bg-surface">
              <input
                v-model="errorSearch"
                placeholder="搜索错误（message / 堆栈 / 源码位置）"
                class="w-full text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
              />
            </div>
            <!-- 错误列表 -->
            <div class="flex-1 overflow-y-auto p-4 space-y-3">
              <div v-for="(e, i) in filteredErrors" :key="i" class="bg-red-soft border border-red-soft rounded p-3">
              <div class="text-sm text-red-key font-medium break-all">{{ e.message }}</div>
              <div class="text-xs text-faint mt-1">{{ new Date(e.timestamp).toLocaleTimeString() }}</div>
              <!-- source map 解析后的原始位置（AI 诊断关键信息） -->
              <div v-if="e.mapped" class="mt-1 text-xs text-blue-key bg-blue-soft border border-blue-soft rounded px-2 py-1 font-mono">
                ↳ {{ e.mapped.source }}:{{ e.mapped.line }}:{{ e.mapped.column }}<span v-if="e.mapped.name" class="text-blue-400"> ({{ e.mapped.name }})</span>
              </div>
              <div v-else-if="e.source" class="mt-1 text-xs text-faint font-mono">
                ↳ {{ e.source }}:{{ e.line }}:{{ e.col }}
              </div>
              <!-- 堆栈可折叠（<details> 原生组件，默认收起，点击展开） -->
              <details v-if="e.stack" class="mt-2">
                <summary class="text-xs text-red-400 cursor-pointer hover:text-red-600 select-none">堆栈</summary>
                <pre class="text-xs text-red-500 mt-1 whitespace-pre-wrap">{{ e.stack }}</pre>
              </details>
              </div>
              <div v-if="filteredErrors.length === 0" class="text-faint text-center py-8">{{ errors.length === 0 ? '暂无错误' : '无匹配错误' }}</div>
            </div>
          </div>

          <!-- Snapshot 面板（搜索过滤 + 复制） -->
          <div v-else-if="activeTab === 'snapshot'" class="flex-1 flex flex-col overflow-hidden bg-base">
            <!-- 工具栏：搜索 + 复制 + 刷新 -->
            <div class="flex items-center gap-2 px-4 py-2 border-b border-base bg-surface">
              <input
                v-model="snapshotSearch"
                placeholder="搜索快照（元素名 / idx / 状态 token）"
                class="flex-1 px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
              />
              <span v-if="filteredSnapshotLines" class="text-xs text-faint whitespace-nowrap">{{ filteredSnapshotLines.length }} 行</span>
              <button
                @click="copySnapshot"
                class="px-2 py-0.5 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary"
              >{{ snapCopyState === 'copied' ? '✓ 已复制' : '复制' }}</button>
              <button
                @click="refreshSnapshot"
                class="px-2 py-0.5 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary"
              >刷新</button>
            </div>
            <!-- 快照内容 -->
            <div class="flex-1 overflow-y-auto p-4">
              <div v-if="snapLoading" class="text-faint text-center py-8">加载中...</div>
              <template v-else>
                <!-- 搜索模式：只展示匹配行 -->
                <pre v-if="filteredSnapshotLines" class="text-xs font-mono text-primary whitespace-pre-wrap">{{ filteredSnapshotLines.join('\n') }}</pre>
                <!-- 无搜索：展示完整快照 -->
                <pre v-else class="text-xs font-mono text-primary whitespace-pre-wrap">{{ snapshotText }}</pre>
              </template>
              <div v-if="filteredSnapshotLines && filteredSnapshotLines.length === 0" class="text-faint text-center py-8 text-sm">无匹配行</div>
            </div>
          </div>

          <!-- Exec 面板（在控制台直接执行诊断代码） -->
          <div v-else-if="activeTab === 'exec'" class="flex-1 flex overflow-hidden bg-base">
            <!-- 主区：编辑 + 结果 -->
            <div class="flex-1 flex flex-col overflow-hidden">
              <!-- 代码编辑区 -->
              <div class="p-3 border-b border-base bg-surface">
                <textarea
                  v-model="execCode"
                  rows="5"
                  placeholder="输入诊断代码，如：return document.title"
                  class="w-full text-xs font-mono p-2 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400 resize-y"
                  @keydown="handleExecKeydown"
                />
                <div class="flex items-center gap-2 mt-2">
                  <button
                    @click="runExec"
                    :disabled="execRunning"
                    class="px-3 py-1 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {{ execRunning ? '执行中...' : '执行 (Ctrl+↵)' }}
                  </button>
                  <span class="text-xs text-faint">Tab 缩进 · 辅助函数：__clarosight_click / setValue / type / wait / snapshot / sourcemap</span>
                </div>
              </div>
              <!-- 结果展示区 -->
              <div class="flex-1 overflow-y-auto p-3">
                <template v-if="execResult">
                  <!-- 失败时红色，成功/执行中正常色 -->
                  <pre
                    class="text-xs font-mono whitespace-pre-wrap"
                    :class="execOk === false ? 'text-red-500' : 'text-primary'"
                  >{{ execResult }}</pre>
                  <!-- 执行后快照：默认折叠（快照几百字符，不该和返回值混排撑满屏） -->
                  <details v-if="execSnapshot" class="mt-3">
                    <summary class="text-xs text-blue-600 cursor-pointer select-none hover:text-blue-700">▶ 执行后快照（{{ execSnapshot.length }} 字符，点击展开）</summary>
                    <pre class="text-xs font-mono text-secondary whitespace-pre-wrap mt-2 p-2 bg-surface rounded border border-base">{{ execSnapshot }}</pre>
                  </details>
                </template>
                <div v-else class="text-faint text-center py-8 text-sm">输入代码后点击执行</div>
              </div>
            </div>
            <!-- 历史侧栏 -->
            <div class="w-56 border-l border-base bg-surface flex flex-col overflow-hidden">
              <div class="flex items-center justify-between px-3 py-2 border-b border-light">
                <span class="text-xs font-medium text-secondary">执行历史</span>
                <button
                  v-if="execHistory.length"
                  @click="clearExecHistory"
                  class="text-xs text-faint hover:text-red-500"
                  title="清空历史"
                >清空</button>
              </div>
              <div class="flex-1 overflow-y-auto">
                <div
                  v-for="h in execHistory"
                  :key="h.code"
                  class="group px-3 py-2 border-b border-light cursor-pointer hover:bg-elevated"
                  @click="pickHistory(h.code)"
                >
                  <div class="flex items-center justify-between mb-0.5">
                    <span
                      class="text-[10px] font-mono"
                      :class="h.ok ? 'text-green-600' : 'text-red-500'"
                    >{{ h.ok ? '✓' : '✗' }}</span>
                    <button
                      @click.stop="removeExecHistory(h.code)"
                      class="text-[10px] text-faint hover:text-red-500 opacity-0 group-hover:opacity-100"
                      title="删除此条"
                    >✕</button>
                  </div>
                  <div class="text-xs font-mono text-muted truncate" :title="h.code">{{ h.code }}</div>
                </div>
                <div v-if="!execHistory.length" class="text-xs text-faint text-center py-6">
                  执行过的代码会出现在这里<br>点击可回填
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- 未选中设备时的占位 -->
        <div v-else class="flex-1 flex items-center justify-center text-faint">
          <div class="text-center">
            <p class="text-sm">从左侧选择一个设备查看详情</p>
            <p class="text-xs mt-2">接入新设备：在目标页面注入 <code class="bg-elevated px-1 rounded">&lt;script src="/sdk.js"&gt;&lt;/script&gt;</code></p>
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
  </div>
</template>
