<script setup lang="ts">
/**
 * CompletionDropdown —— 代码补全下拉列表
 *
 * 悬浮在输入行上方，展示匹配的补全建议，↑↓ 选择，Tab/Enter 确认。
 * 高亮当前选中项（activeIndex），鼠标 hover 也可切换选中。
 */
import { watch, nextTick, useTemplateRef } from 'vue'
import type { CompletionItem } from '../composables/useAutocomplete'

const props = defineProps<{
  /** 补全建议列表 */
  items: CompletionItem[]
  /** 当前选中索引 */
  activeIndex: number
}>()

const emit = defineEmits<{
  /** 选中某项（Tab/Enter/click） */
  select: [item: CompletionItem]
  /** hover 某项（切换 activeIndex） */
  hover: [index: number]
}>()

const listEl = useTemplateRef<HTMLElement>('listEl')

/**
 * kind → 显示颜色 + 图标
 */
const kindStyle = (kind: CompletionItem['kind']): { color: string; badge: string } => {
  switch (kind) {
    case 'keyword': return { color: 'text-purple-500', badge: 'K' }
    case 'global': return { color: 'text-blue-500', badge: 'G' }
    case 'dom': return { color: 'text-orange-500', badge: 'D' }
    case 'helper': return { color: 'text-green-500', badge: 'H' }
    case 'property': return { color: 'text-cyan-600', badge: 'P' }
    default: return { color: 'text-faint', badge: '·' }
  }
}

/**
 * activeIndex 变化时自动滚动到可见区域
 */
watch(() => props.activeIndex, async (idx) => {
  if (idx < 0 || !listEl.value) return
  await nextTick()
  const active = listEl.value.children[idx] as HTMLElement | undefined
  if (active) {
    active.scrollIntoView({ block: 'nearest' })
  }
})
</script>

<template>
  <div
    ref="listEl"
    class="absolute bottom-full left-0 right-0 max-h-48 overflow-y-auto bg-surface border border-base rounded-t-md shadow-lg z-50 font-mono text-sm"
  >
    <div
      v-for="(item, i) in items"
      :key="i"
      @mousedown.prevent="emit('select', item)"
      @mouseenter="emit('hover', i)"
      class="flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors"
      :class="i === activeIndex ? 'bg-blue-soft text-blue-key' : 'text-primary hover:bg-blue-soft/50'"
    >
      <!-- kind badge -->
      <span
        class="shrink-0 w-4 text-center text-[10px] font-bold rounded"
        :class="kindStyle(item.kind).color"
      >{{ kindStyle(item.kind).badge }}</span>
      <!-- 补全文本 -->
      <span class="truncate">{{ item.label }}</span>
      <!-- 类型描述（如"内置全局"、"DOM id"） -->
      <span v-if="item.detail" class="ml-auto text-[10px] text-faint shrink-0">{{ item.detail }}</span>
    </div>
  </div>
</template>
