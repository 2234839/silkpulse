<script setup lang="ts">
/**
 * SnapshotPanel —— 页面快照（compact 文本）
 *
 * AI 友好的页面结构文本快照，支持行级搜索过滤。
 * 布局框图预览已移至 Element 面板（与 DOM 树联动）。
 */
import { ref, computed, watch } from 'vue'
import { useSnapshot } from '../composables/useSnapshot'
import { copyText } from '../utils/clipboard'

const props = defineProps<{
  /** 当前选中设备 id */
  deviceId: string
}>()

const { snapshotText, loading: snapLoading, fetchSnapshot } = useSnapshot()

/** 进入面板时拉取快照（deviceId 变化时也重拉） */
watch(
  () => props.deviceId,
  (id) => {
    if (id) fetchSnapshot(id)
  },
  { immediate: true },
)

/**
 * 行级搜索过滤
 *
 * 快照几百字符压缩整页结构，诊断"某个按钮在哪""表单有没有 disabled"时，
 * 输入关键词只显示匹配行，快速定位元素。
 */
const snapshotSearch = ref('')
const filteredSnapshotLines = computed(() => {
  const q = snapshotSearch.value.trim().toLowerCase()
  if (!q) return null
  return snapshotText.value.split('\n').filter((line) => line.toLowerCase().includes(q))
})

/** 复制状态 */
const snapCopyState = ref<'idle' | 'copied'>('idle')
async function copySnapshot() {
  await copyText(snapshotText.value)
  snapCopyState.value = 'copied'
  setTimeout(() => { snapCopyState.value = 'idle' }, 1500)
}

/** 刷新快照 */
function refreshSnapshot() {
  if (props.deviceId) fetchSnapshot(props.deviceId)
}
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden bg-base">
    <!-- 工具栏 -->
    <div class="flex items-center gap-2 px-4 py-2 border-b border-base bg-surface flex-wrap">
      <input
        v-model="snapshotSearch"
        placeholder="搜索快照（元素名 / idx / 状态 token）"
        class="flex-1 min-w-[120px] px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
      />
      <span v-if="filteredSnapshotLines" class="text-xs text-faint whitespace-nowrap">{{ filteredSnapshotLines.length }} 行</span>

      <div class="ml-auto flex items-center gap-2">
        <button
          @click="copySnapshot"
          class="px-2 py-0.5 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
        >{{ snapCopyState === 'copied' ? '✓ 已复制' : '复制' }}</button>
        <button
          @click="refreshSnapshot"
          class="px-2 py-0.5 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
        >刷新</button>
      </div>
    </div>

    <!-- 快照文本 -->
    <div class="flex-1 overflow-auto">
      <div v-if="snapLoading" class="text-faint text-center py-8">加载中...</div>
      <div v-else class="p-4">
        <pre v-if="filteredSnapshotLines" class="text-xs font-mono text-primary whitespace-pre-wrap">{{ filteredSnapshotLines.join('\n') }}</pre>
        <pre v-else class="text-xs font-mono text-primary whitespace-pre-wrap">{{ snapshotText }}</pre>
        <div v-if="filteredSnapshotLines && filteredSnapshotLines.length === 0" class="text-faint text-center py-8 text-sm">无匹配行</div>
      </div>
    </div>
  </div>
</template>
