<script setup lang="ts">
/**
 * ErrorsPanel —— 错误区面板
 *
 * 展示远程设备捕获的 JS 错误，含 source map 解析后的原始源码位置。
 * 支持关键词搜索（message / 堆栈 / 源码位置）+ 复制单条/全部，方便粘贴给 AI 诊断。
 *
 * 数据由 App.vue 通过 useConsoleSocket() 单源传入，本组件不自行订阅。
 */
import { ref, computed } from 'vue'
import type { ErrorEntry } from '@silkpulse/shared'
import { copyText } from '../utils/clipboard'

const props = defineProps<{
  /** 远程设备捕获的错误列表 */
  errors: ErrorEntry[]
}>()

/** 关键词搜索（按 message / stack / mapped.source） */
const errorSearch = ref('')
/**
 * 正在复制的错误 timestamp（标识哪条错误卡片显示"已复制"反馈）
 *
 * 用 timestamp 而非索引：filteredErrors 过滤后索引不稳定，timestamp 是错误唯一标识。
 */
const copyingErrorTs = ref<string | null>(null)
const filteredErrors = computed(() => {
  const q = errorSearch.value.trim().toLowerCase()
  if (!q) return props.errors
  return props.errors.filter((e) => {
    if (e.message.toLowerCase().includes(q)) return true
    if (e.stack && e.stack.toLowerCase().includes(q)) return true
    if (e.mapped && e.mapped.source.toLowerCase().includes(q)) return true
    return false
  })
})

/**
 * 把单条错误格式化为可粘贴的文本（message + 时间 + 源码位置 + stack）
 *
 * 给 AI/同事看完整错误现场：mapped 源码位置（压缩→原始）+ 完整堆栈，
 * 对齐 skill CLI errors 命令的输出格式。
 */
function formatErrorText(e: ErrorEntry): string {
  const parts = [`[${new Date(e.timestamp).toLocaleString()}] ${e.message}`]
  if (e.mapped) {
    parts.push(`  原始源码: ${e.mapped.source}:${e.mapped.line}:${e.mapped.column}${e.mapped.name ? ` (${e.mapped.name})` : ''}`)
  } else if (e.source) {
    parts.push(`  位置: ${e.source}:${e.line}:${e.col}`)
  }
  if (e.stack) parts.push(e.stack)
  return parts.join('\n')
}

/** 复制单条错误到剪贴板 */
async function copyError(e: ErrorEntry) {
  const ok = await copyText(formatErrorText(e))
  if (ok) {
    copyingErrorTs.value = e.timestamp
    setTimeout(() => {
      if (copyingErrorTs.value === e.timestamp) copyingErrorTs.value = null
    }, 1500)
  }
}

/** 复制全部错误（当前过滤后的）到剪贴板 —— AI 需要完整错误现场时一键获取 */
const copyingAllErrors = ref(false)
async function copyAllErrors() {
  /** 对齐 inspect CLI 输出格式：每条错误格式化 + 空行分隔 */
  const text = filteredErrors.value.map(formatErrorText).join('\n\n')
  const ok = await copyText(text)
  if (ok) {
    copyingAllErrors.value = true
    setTimeout(() => { copyingAllErrors.value = false }, 1500)
  }
}
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden bg-base">
    <!-- 搜索栏 + 复制全部 -->
    <div class="p-2 border-b border-base bg-surface flex items-center gap-2">
      <input
        v-model="errorSearch"
        placeholder="搜索错误（message / 堆栈 / 源码位置）"
        class="flex-1 text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
      />
      <button
        v-if="filteredErrors.length > 0"
        @click="copyAllErrors"
        class="shrink-0 text-xs px-2 py-1 rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary transition-colors whitespace-nowrap"
      >{{ copyingAllErrors ? '✓ 已复制' : `复制全部 (${filteredErrors.length})` }}</button>
    </div>
    <!-- 错误列表 -->
    <div class="flex-1 overflow-y-auto p-4 space-y-3">
      <div v-for="(e, i) in filteredErrors" :key="i" class="bg-red-soft border border-red-soft rounded p-3">
      <div class="flex items-start justify-between gap-2">
        <div class="text-sm text-red-key font-medium break-all flex-1">{{ e.message }}</div>
        <!-- 复制单条错误（message + 源码位置 + stack，粘贴给 AI/同事） -->
        <button
          @click="copyError(e)"
          class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary transition-colors"
          :title="formatErrorText(e).slice(0, 100)"
        >{{ copyingErrorTs === e.timestamp ? '✓' : '复制' }}</button>
      </div>
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
      <div v-if="filteredErrors.length === 0" class="text-faint text-center py-8">{{ props.errors.length === 0 ? '暂无错误' : '无匹配错误' }}</div>
    </div>
  </div>
</template>
