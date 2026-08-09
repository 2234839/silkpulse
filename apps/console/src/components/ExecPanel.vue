<script setup lang="ts">
/**
 * ExecPanel —— 远程代码执行面板
 *
 * 在远程设备上下文执行诊断代码（读取 DOM 状态、调用 SDK 辅助函数），
 * 结果区展示返回值 + 执行期间日志 + 执行后快照（折叠）。
 * 代码编辑器支持 Tab 缩进（单行/多行）、Ctrl+↵ 执行。
 *
 * 执行历史通过 useExecHistory() 持久化到 localStorage。
 */
import { ref, nextTick } from 'vue'
import type { SerializedValue } from '@silkpulse/shared'
import { useExecHistory } from '../composables/useExecHistory'
import { apiFetch } from '../utils/api'
import { useResizable } from '../composables/useResizable'
import ObjectInspector from './ObjectInspector.vue'

/** 历史侧栏宽度可拖拽 */
const { width: historyWidth, onDragStart: onHistoryResize } = useResizable({
  initial: 224,
  min: 160,
  max: 400,
  direction: 'left',
  storageKey: 'silkpulse.exec-history-width',
})

const props = defineProps<{
  /** 当前选中设备 id */
  deviceId: string
}>()

const { history: execHistory, record: recordExec, remove: removeExecHistory, clear: clearExecHistory } = useExecHistory()

const execCode = ref('document.title')
const execResult = ref('')
/** exec 返回值的结构化形式（有值时用对象树渲染，比纯文本更直观） */
const execResultValue = ref<SerializedValue | undefined>()
/** exec 执行后快照（独立展示，默认折叠，避免快照撑满结果区） */
const execSnapshot = ref('')
/** 执行期间的日志 */
const execLogs = ref<string[]>([])
/** exec 执行状态：null 未执行 / true 成功 / false 失败（控制结果区配色） */
const execOk = ref<boolean | null>(null)
const execRunning = ref(false)

/** 执行诊断代码 */
async function runExec() {
  if (!props.deviceId || execRunning.value) return
  execRunning.value = true
  execResult.value = '执行中...'
  execSnapshot.value = ''
  execOk.value = null
  let ok = false
  try {
    const res = await apiFetch(`/api/devices/${props.deviceId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: execCode.value }),
    })
    const data = await res.json()
    if (data.success) {
      ok = true
      /** 有结构化值时用对象树，否则降级纯文本 */
      execResultValue.value = data.resultValue
      execResult.value = data.result ?? 'undefined'
      execLogs.value = data.logs ?? []
      /** 快照独立存储，渲染时折叠展示 */
      execSnapshot.value = data.snapshotText ?? ''
    } else {
      execResultValue.value = undefined
      execLogs.value = []
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
    /** 有选区（start !== end）：对选区内每行批量缩进/反缩进 */
    if (start !== end) {
      handleMultilineIndent(ta, start, end, value, e.shiftKey)
      return
    }
    /** 单光标：Tab 加 2 空格，Shift+Tab 移除行首 2 空格（反缩进） */
    if (e.shiftKey) {
      /** 找当前行起始 */
      const lineStart = value.lastIndexOf('\n', start - 1) + 1
      const lineHead = value.slice(lineStart, lineStart + 2)
      if (lineHead === '  ') {
        execCode.value = value.slice(0, lineStart) + value.slice(lineStart + 2)
        /** nextTick 等 v-model 把新 value 同步到 textarea，再恢复光标（rAF 会在 DOM 更新前跑，被 v-model 覆盖） */
        nextTick(() => {
          ta.selectionStart = ta.selectionEnd = start - 2
        })
      }
    } else {
      execCode.value = value.slice(0, start) + '  ' + value.slice(end)
      nextTick(() => {
        ta.selectionStart = ta.selectionEnd = start + 2
      })
    }
  }
}

/**
 * 多行选区的批量缩进/反缩进
 *
 * Tab：选区内每行行首加 2 空格；Shift+Tab：每行行首移除最多 2 空格。
 * 保持选区覆盖同样的行范围（让用户能连续操作）。
 */
function handleMultilineIndent(
  ta: HTMLTextAreaElement,
  start: number,
  end: number,
  value: string,
  shift: boolean,
): void {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const selected = value.slice(lineStart, end)
  const lines = selected.split('\n')
  if (shift) {
    /** 反缩进：每行移除最多 2 个行首空格 */
    const newLines = lines.map((l) => l.replace(/^ {1,2}/, ''))
    execCode.value = value.slice(0, lineStart) + newLines.join('\n') + value.slice(end)
    nextTick(() => {
      ta.selectionStart = lineStart
      ta.selectionEnd = lineStart + newLines.join('\n').length
    })
  } else {
    /** 缩进：每行行首加 2 空格 */
    const newLines = lines.map((l) => '  ' + l)
    execCode.value = value.slice(0, lineStart) + newLines.join('\n') + value.slice(end)
    nextTick(() => {
      ta.selectionStart = lineStart
      ta.selectionEnd = lineStart + newLines.join('\n').length
    })
  }
}
</script>

<template>
  <div class="flex-1 flex overflow-hidden bg-base">
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
          <span class="text-xs text-faint">Tab 缩进 · 辅助函数：__silkpulse_click / setValue / type / wait / snapshot / sourcemap</span>
        </div>
      </div>
      <!-- 结果展示区 -->
      <div class="flex-1 overflow-y-auto p-3">
        <template v-if="execResult">
          <!-- 成功且有结构化值：用对象树 -->
          <div v-if="execOk && execResultValue" class="mb-3">
            <div class="text-xs text-faint mb-1">返回值</div>
            <ObjectInspector :value="execResultValue" />
          </div>
          <!-- 降级纯文本（失败/执行中/无结构化值） -->
          <pre
            v-if="!execResultValue"
            class="text-xs font-mono whitespace-pre-wrap"
            :class="execOk === false ? 'text-red-500' : 'text-primary'"
          >{{ execResult }}</pre>
          <!-- 执行期间日志 -->
          <div v-if="execLogs.length" class="mt-2">
            <div class="text-xs text-faint mb-1">执行期间日志</div>
            <pre class="text-xs font-mono text-secondary whitespace-pre-wrap">{{ execLogs.join('\n') }}</pre>
          </div>
          <!-- 执行后快照：默认折叠 -->
          <details v-if="execSnapshot" class="mt-3">
            <summary class="text-xs text-blue-600 cursor-pointer select-none hover:text-blue-700">▶ 执行后快照（{{ execSnapshot.length }} 字符，点击展开）</summary>
            <pre class="text-xs font-mono text-secondary whitespace-pre-wrap mt-2 p-2 bg-surface rounded border border-base">{{ execSnapshot }}</pre>
          </details>
        </template>
        <div v-else class="text-faint text-center py-8 text-sm">输入代码后点击执行</div>
      </div>
    </div>
    <!-- 拖拽手柄 -->
    <div
      class="w-1 cursor-col-resize bg-base hover:bg-blue-400/40 active:bg-blue-500 transition-colors flex-shrink-0"
      @mousedown="onHistoryResize"
    />

    <!-- 历史侧栏 -->
    <div class="border-l border-base bg-surface flex flex-col overflow-hidden flex-shrink-0" :style="{ width: historyWidth + 'px' }">
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
