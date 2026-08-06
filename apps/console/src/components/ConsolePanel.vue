<script setup lang="ts">
/**
 * ConsolePanel —— 日志面板
 *
 * 展示远程设备 console.* 输出，支持级别筛选（all/error/warn/info/debug）、
 * 关键词搜索、点击复制单条、清空视图（仅前端隐藏，server 缓冲不变）。
 *
 * 底部输入行：直接在远程设备 console 上下文执行代码（回车执行，↑/↓ 翻阅历史），
 * 复用 /api/devices/:id/exec 端点，结果以日志样式展示在列表下方。
 *
 * 数据由 App.vue 通过 useConsoleSocket() 单源传入。
 */
import { ref, computed, useTemplateRef, watch, nextTick } from 'vue'
import type { LogEntry, SerializedValue } from '@clarosight/shared'
import { copyText } from '../utils/clipboard'
import { apiFetch } from '../utils/api'
import { useExecHistory } from '../composables/useExecHistory'
import {
  getCompletions,
  applyCompletion,
  clearCache,
  contextLoading as acLoading,
  type CompletionItem,
} from '../composables/useAutocomplete'
import CompletionDropdown from './CompletionDropdown.vue'
import ObjectInspector from './ObjectInspector.vue'

const props = defineProps<{
  /** 远程设备日志列表 */
  logs: LogEntry[]
  /** 当前选中设备 id（底部输入行执行代码用） */
  deviceId: string
}>()

/** 日志级别 → tailwind 颜色 */
const logColor = (type: string): string => {
  if (type === 'error' || type === 'assert') return 'text-red-600'
  if (type === 'warn') return 'text-amber-600'
  if (type === 'debug') return 'text-faint'
  if (type === 'table') return 'text-purple-600'
  if (type === 'trace') return 'text-gray-500'
  if (type === 'group' || type === 'groupEnd') return 'text-blue-500 font-semibold'
  if (type === 'count') return 'text-cyan-600'
  if (type === 'time') return 'text-green-600'
  if (type === 'dir') return 'text-indigo-600'
  if (type === 'clear') return 'text-faint italic'
  return 'text-primary'
}

/**
 * 正在复制的日志 timestamp（标识哪条显示"✓ 已复制"反馈）
 *
 * 日志可能极多，用 timestamp 标识单条（比用数组索引稳定，过滤后索引会漂移）。
 * 复制完整一条：[时间] LEVEL message —— 粘贴给 AI/同事时保留上下文。
 */
const copyingLogTs = ref<string | null>(null)
async function copyLog(log: LogEntry) {
  const text = `[${new Date(log.timestamp).toLocaleTimeString()}] ${log.type.toUpperCase()} ${log.message}`
  const ok = await copyText(text)
  if (ok) {
    copyingLogTs.value = log.timestamp
    setTimeout(() => {
      if (copyingLogTs.value === log.timestamp) copyingLogTs.value = null
    }, 1500)
  }
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
  return props.logs.filter((l) => l.type === lvl).length
}

/** Console 面板：级别筛选 + 搜索 */
const logLevelFilter = ref<'all' | 'error' | 'warn' | 'info' | 'debug'>('all')
const logSearch = ref('')
/**
 * Console 清空阈值：只展示此时间戳之后的日志。
 *
 * 不删除 server 真相，只在前端视图层面隐藏 —— 用户"清空"后再来的新日志正常出现。
 * 与浏览器 DevTools 的 🚫 按钮语义一致。
 */
const clearedBeforeTs = ref(0)

/** 清空当前 Console 视图（仅前端隐藏，server 缓冲不受影响） */
function clearLogs() {
  clearedBeforeTs.value = Date.now()
}

/** 筛选后的日志（级别 + 关键词 + 清空阈值） */
const filteredLogs = computed(() => {
  let result = props.logs
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

/**
 * 渲染用日志：在 filteredLogs 基础上处理 clear 信号 + 计算 group 缩进层级
 *
 * - clear：遇到 console.clear 时，清空之前所有已显示的日志（视图层，server 缓冲不变）
 * - group/groupEnd：维护 depth 计数器，每条日志附带 groupDepth 用于渲染缩进
 *
 * 返回类型：LogEntry & { groupDepth: number }
 */
interface DisplayLog extends LogEntry {
  /** 该条日志所在的 group 缩进层级（0 = 不在任何 group 内） */
  groupDepth: number
}
const displayLogs = computed<DisplayLog[]>(() => {
  const result: DisplayLog[] = []
  let depth = 0
  for (const log of filteredLogs.value) {
    if (log.type === 'clear') {
      /** clear 清空之前所有显示（包括 result 里已累积的），depth 归零 */
      result.length = 0
      depth = 0
      /** clear 本身也显示一条"Console was cleared"提示（与 DevTools 行为一致） */
      result.push({ ...log, message: 'Console was cleared', groupDepth: 0 })
      continue
    }
    if (log.type === 'groupEnd') {
      depth = Math.max(0, depth - 1)
      /** groupEnd 本身不显示（与 DevTools 行为一致：结束标记无视觉输出） */
      continue
    }
    result.push({ ...log, groupDepth: depth })
    if (log.type === 'group') {
      depth++
    }
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
watch(displayLogs, async () => {
  await nextTick()
  const el = logListEl.value
  if (!el) return
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  if (distanceFromBottom < 80) {
    el.scrollTop = el.scrollHeight
  }
})

/** 设备切换时重置清空阈值（切到新设备的日志历史应完整展示） */
watch(() => props.logs, () => {
  clearedBeforeTs.value = 0
})

/**
 * 设备切换时清空补全缓存（新设备的全局变量 / 属性不同）
 *
 * 补全改为实时探测模式：每次输入都走 exec 通道，不再需要提前采集。
 */
watch(() => props.deviceId, () => {
  clearCache()
})

/* ==================== 底部输入行：在远程设备 console 上下文执行代码 ==================== */

const { history: execHistory, record: recordExec } = useExecHistory()

/** 输入框当前代码 */
const execInput = ref('')
/** 执行中标记（防重复提交） */
const execRunning = ref(false)

/* -------- 代码补全（autocomplete） -------- */

/** 输入框 ref（获取光标位置） */
const execInputEl = useTemplateRef<HTMLInputElement>('execInputEl')
/** 补全建议列表 */
const completionItems = ref<CompletionItem[]>([])
/** 当前选中的补全项索引（-1 = 未选中） */
const completionActive = ref(-1)
/** 补全列表是否显示 */
const completionVisible = ref(false)
/** 异步补全的 AbortController（避免快速输入时旧请求覆盖新结果） */
let completionAbort: { cancelled: boolean } | null = null

/**
 * 输入变化时触发补全
 *
 * 解析当前光标位置的上下文，同步展示静态词表匹配，
 * 若是属性链（xxx.）则异步 exec 获取远程对象属性。
 */
function triggerCompletion() {
  const el = execInputEl.value
  if (!el) return
  const text = el.value
  const cursorPos = el.selectionStart ?? text.length

  /** 新版回调模式：getCompletions 同步返回静态词表匹配，异步远程探测通过 onAsync 回调 */
  const syncItems = getCompletions(text, cursorPos, props.deviceId, (asyncItems) => {
    if (asyncItems.length === 0) {
      /** 远程也没结果：如果同步也是空的，隐藏 */
      if (completionItems.value.length === 0) {
        completionVisible.value = false
      }
      return
    }
    completionItems.value = asyncItems
    completionActive.value = 0
    completionVisible.value = true
  })

  if (!syncItems.length) {
    /** 同步无结果——可能远程异步会补充，暂不隐藏（等 onAsync 回调决定） */
    completionItems.value = []
    /** 短暂等待后如果异步没来再隐藏 */
    if (completionAbort) completionAbort.cancelled = true
    const myToken = { cancelled: false }
    completionAbort = myToken
    setTimeout(() => {
      if (!myToken.cancelled && completionItems.value.length === 0) {
        completionVisible.value = false
      }
    }, 300)
    return
  }

  /** 同步结果立即展示 */
  if (completionAbort) completionAbort.cancelled = true
  completionItems.value = syncItems
  completionActive.value = syncItems.length ? 0 : -1
  completionVisible.value = syncItems.length > 0
}

/**
 * 确认选中补全项（Tab / Enter / click）
 *
 * 将补全文本应用到输入框，光标移到补全文本末尾。
 */
function acceptCompletion(item: CompletionItem) {
  const el = execInputEl.value
  if (!el) return
  const cursorPos = el.selectionStart ?? el.value.length
  const { text, cursorPos: newPos } = applyCompletion(el.value, cursorPos, item)
  execInput.value = text
  completionVisible.value = false
  completionItems.value = []
  /** nextTick 后设置光标位置（等 DOM 更新） */
  nextTick(() => {
    el.focus()
    el.setSelectionRange(newPos, newPos)
  })
}

/** 关闭补全列表 */
function closeCompletion() {
  completionVisible.value = false
  completionItems.value = []
  completionActive.value = -1
}

/**
 * 输入框失焦时延迟关闭补全列表
 *
 * 延迟 150ms 是为了让 mousedown/click 选择补全项先触发，
 * 否则 blur 先执行关掉列表，补全项的 click 就点不到了。
 */
function onInputBlur() {
  setTimeout(() => closeCompletion(), 150)
}

/**
 * 单条执行结果（展示在日志列表下方的"执行结果区"）
 *
 * 与日志分开存：日志是设备被动上报的，执行结果是用户主动触发的，
 * 混在一起会污染日志筛选/计数。
 */
interface ExecResultItem {
  /** 执行的代码 */
  code: string
  /** 返回值（成功）或错误信息（失败） */
  output: string
  /** 结构化返回值（成功时可能有，用于对象树展示） */
  resultValue?: SerializedValue
  /** 是否成功（控制配色） */
  ok: boolean
  /** 时间戳 */
  time: number
}
/** 执行结果列表（最新在底部，与日志流方向一致） */
const execResults = ref<ExecResultItem[]>([])

/** ↑/↓ 翻阅历史：historyCursor 标记当前翻到第几条（-1 = 未翻阅，输入框是用户新输入） */
const historyCursor = ref(-1)
/** 翻阅历史前暂存用户正在输入的内容（按 ↓ 翻到底时恢复） */
const inputDraft = ref('')

/** 执行输入框中的代码（eval 模式：纯表达式自动返回，不需要手动 return） */
async function runExecInput() {
  const code = execInput.value.trim()
  if (!code || !props.deviceId || execRunning.value) return
  execRunning.value = true
  const time = Date.now()
  let ok = false
  let output = ''
  let resultValue: SerializedValue | undefined
  try {
    const res = await apiFetch(`/api/devices/${props.deviceId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const data = await res.json()
    if (data.success) {
      ok = true
      output = data.result ?? 'undefined'
      resultValue = data.resultValue
    } else {
      output = data.error ?? '未知错误'
    }
  } catch (e) {
    output = e instanceof Error ? e.message : String(e)
  } finally {
    execResults.value = [...execResults.value, { code, output, resultValue, ok, time }]
    recordExec(code, ok)
    execInput.value = ''
    historyCursor.value = -1
    inputDraft.value = ''
    execRunning.value = false
    /** 结果出来后滚到底部 */
    await nextTick()
    const el = logListEl.value
    if (el) el.scrollTop = el.scrollHeight
  }
}

/**
 * 输入框键盘事件：回车执行，↑/↓ 翻阅执行历史
 *
 * ↑：向更老的历史翻（cursor 递增）；↓：向更新的翻（cursor 递减），
 * 翻到底（cursor 回到 -1）恢复用户之前正在输入的草稿。
 */
function handleExecKeydown(e: KeyboardEvent) {
  /**
   * 补全列表打开时的键位处理：
   * - Tab：选中补全项
   * - Enter：关闭补全列表，继续执行代码（和 DevTools 一致）
   * - ↑/↓：导航补全列表
   * - Escape：关闭补全列表
   */
  if (completionVisible.value && completionItems.value.length) {
    if (e.key === 'Tab') {
      e.preventDefault()
      const item = completionItems.value[completionActive.value]
      if (item) acceptCompletion(item)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      completionActive.value = completionActive.value <= 0
        ? completionItems.value.length - 1
        : completionActive.value - 1
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      completionActive.value = completionActive.value >= completionItems.value.length - 1
        ? 0
        : completionActive.value + 1
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closeCompletion()
      return
    }
    /** Enter 关闭补全列表，不 return——继续走下面的执行逻辑 */
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      closeCompletion()
    }
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    runExecInput()
    return
  }
  /** 补全列表关闭时 ↑/↓ 翻阅执行历史 */
  if (e.key === 'ArrowUp') {
    if (!execHistory.value.length) return
    e.preventDefault()
    if (historyCursor.value === -1) {
      inputDraft.value = execInput.value
      historyCursor.value = 0
    } else if (historyCursor.value < execHistory.value.length - 1) {
      historyCursor.value++
    }
    execInput.value = execHistory.value[historyCursor.value]?.code ?? ''
    return
  }
  if (e.key === 'ArrowDown') {
    if (historyCursor.value === -1) return
    e.preventDefault()
    if (historyCursor.value > 0) {
      historyCursor.value--
      execInput.value = execHistory.value[historyCursor.value]?.code ?? ''
    } else {
      historyCursor.value = -1
      execInput.value = inputDraft.value
    }
  }
}

/** 清空执行结果区（与日志清空独立） */
function clearExecResults() {
  execResults.value = []
}
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden bg-base">
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
      <span class="text-xs text-faint">{{ filteredLogs.length }}/{{ props.logs.length }}</span>
      <!-- 清空视图（仅前端隐藏，server 缓冲不变，新日志正常出现） -->
      <button
        @click="clearLogs"
        class="px-2 py-0.5 text-xs rounded bg-elevated text-secondary hover:bg-elevated-hover"
        title="清空当前视图（新日志仍会出现）"
      >清空</button>
    </div>
    <!-- 日志列表 -->
    <div ref="logListEl" class="flex-1 overflow-y-auto p-4 font-mono text-sm">
      <div
        v-for="(log, i) in displayLogs"
        :key="i"
        @click="copyLog(log)"
        class="py-0.5 border-b border-light cursor-pointer hover:bg-blue-soft px-1 -mx-1 rounded transition-colors group"
        :class="copyingLogTs === log.timestamp ? 'bg-blue-soft' : ''"
        :style="log.groupDepth > 0 ? { paddingLeft: `${log.groupDepth * 16 + 4}px` } : undefined"
        :title="copyingLogTs === log.timestamp ? '✓ 已复制' : '点击复制'"
      >
        <span class="text-faint text-xs mr-2">{{ new Date(log.timestamp).toLocaleTimeString() }}</span>
        <span class="text-faint text-xs mr-2 uppercase">{{ log.type }}</span>
        <!-- 有 styledSegments 时渲染带样式的文本段（console.log %c），否则降级纯文本 -->
        <span v-if="log.styledSegments?.length" :class="logColor(log.type)" class="break-all whitespace-pre-wrap">
          <span
            v-for="(seg, si) in log.styledSegments"
            :key="si"
            :style="seg.style"
          >{{ seg.text }}</span>
        </span>
        <span v-else :class="logColor(log.type)" class="break-all whitespace-pre-wrap">{{ log.message }}</span>
        <span v-if="log.repeat" class="text-[10px] text-faint ml-1 shrink-0">×{{ log.repeat }}</span>
        <span class="text-[10px] text-blue-key opacity-0 group-hover:opacity-60 ml-1">{{ copyingLogTs === log.timestamp ? '✓' : '复制' }}</span>
      </div>
      <div v-if="displayLogs.length === 0 && execResults.length === 0" class="text-faint text-center py-8">
        {{ props.logs.length === 0 ? '暂无日志' : '无匹配日志' }}
      </div>

      <!-- 执行结果区（日志流下方，与日志同向滚动） -->
      <div v-if="execResults.length" class="mt-2 border-t border-light pt-2">
        <div class="flex items-center justify-between mb-1 px-1">
          <span class="text-[10px] text-faint uppercase">执行结果</span>
          <button
            @click="clearExecResults"
            class="text-[10px] text-faint hover:text-red-500"
            title="清空执行结果"
          >清空</button>
        </div>
        <div
          v-for="(r, i) in execResults"
          :key="i"
          class="py-1 px-1 -mx-1 rounded border-b border-light"
        >
          <!-- 代码行（> 前缀，模拟终端提示符） -->
          <div class="flex items-baseline gap-2">
            <span class="text-faint text-xs shrink-0">{{ new Date(r.time).toLocaleTimeString() }}</span>
            <span class="text-blue-500 shrink-0">›</span>
            <span class="text-secondary break-all">{{ r.code }}</span>
          </div>
          <!-- 结果行（缩进对齐代码，成功绿/失败红） -->
          <div class="flex items-baseline gap-2 mt-0.5">
            <span class="text-faint text-xs shrink-0 opacity-0">{{ new Date(r.time).toLocaleTimeString() }}</span>
            <span :class="r.ok ? 'text-green-600' : 'text-red-500'" class="shrink-0">{{ r.ok ? '←' : '✗' }}</span>
            <!-- 有结构化值时用对象树，否则降级纯文本 -->
            <div v-if="r.ok && r.resultValue" class="flex-1 min-w-0">
              <ObjectInspector :value="r.resultValue" />
            </div>
            <span v-else :class="r.ok ? 'text-green-600' : 'text-red-500'" class="break-all whitespace-pre-wrap">{{ r.output }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部输入行：在远程设备 console 上下文执行代码（带 autocomplete 补全） -->
    <div class="border-t border-base bg-surface px-3 py-2 flex items-center gap-2 shrink-0 relative">
      <!-- 补全下拉列表（悬浮在输入行上方） -->
      <CompletionDropdown
        v-if="completionVisible"
        :items="completionItems"
        :active-index="completionActive"
        @select="acceptCompletion"
        @hover="completionActive = $event"
      />
      <span class="text-blue-500 font-mono text-sm select-none">›</span>
      <input
        ref="execInputEl"
        v-model="execInput"
        @keydown="handleExecKeydown"
        @input="triggerCompletion"
        @blur="onInputBlur"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        :disabled="execRunning || !deviceId"
        :placeholder="deviceId ? '输入代码，回车执行 · Tab 补全 · ↑↓ 历史' : '请先选择设备'"
        class="flex-1 text-sm font-mono bg-transparent text-primary focus:outline-none placeholder:text-faint disabled:opacity-50"
      />
      <span v-if="acLoading" class="text-xs text-faint shrink-0">采集上下文...</span>
      <span v-else-if="execRunning" class="text-xs text-faint shrink-0">执行中...</span>
    </div>
  </div>
</template>
