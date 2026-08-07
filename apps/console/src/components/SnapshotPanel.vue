<script setup lang="ts">
/**
 * SnapshotPanel —— 页面快照面板
 *
 * 两种视图：
 * - 预览模式：基于 rect 布局数据渲染元素色块，模拟页面布局框图
 * - 文本模式：AI 友好的 compact 文本，支持行级搜索过滤
 */
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import type { SnapshotElement } from '@clarosight/shared'
import { useSnapshot } from '../composables/useSnapshot'
import { copyText } from '../utils/clipboard'

const props = defineProps<{
  /** 当前选中设备 id（null 时面板不该被渲染） */
  deviceId: string
}>()

const { snapshotText, snapshotData, loading: snapLoading, fetchSnapshot } = useSnapshot()

/** 当前视图模式：preview = 布局框图，text = compact 文本 */
const viewMode = ref<'preview' | 'text'>('preview')

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
 * 输入关键词（如 "button" "disabled" "idx=12"）只显示匹配行，快速定位元素。
 * 空搜索展示全部。按行分割而非按字符——compact 快照每行一个元素，行是天然边界。
 */
const snapshotSearch = ref('')
const filteredSnapshotLines = computed(() => {
  const q = snapshotSearch.value.trim().toLowerCase()
  if (!q) return null /** null 表示无搜索，直接展示原文 */
  return snapshotText.value.split('\n').filter((line) => line.toLowerCase().includes(q))
})

/** 复制状态（按钮反馈） */
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

/** ─── 布局预览计算 ─── */

/** 带有 rect 的元素列表（用于预览渲染） */
const rectElements = computed(() => {
  if (!snapshotData.value?.els) return []
  return snapshotData.value.els.filter((e) => e.rect && e.rect.w > 0 && e.rect.h > 0)
})

/**
 * 缩放比例：把远程视口尺寸缩放到预览区域宽度
 *
 * 预览区域固定占满面板宽度，高度按远程视口比例计算。
 * 如果远程页面很高（滚动区域大），预览区域也跟着高（滚动浏览）。
 */
const previewScale = ref(1)
const PREVIEW_PADDING = 32

/** 容器宽度（响应式，由 ResizeObserver 更新） */
const containerWidth = ref(800)

/** 计算缩放比例 */
const scale = computed(() => {
  const vw = snapshotData.value?.viewportWidth ?? 375
  return Math.max(0.1, (containerWidth.value - PREVIEW_PADDING) / vw)
})

/** 预览画布高度（按比例缩放后的视口高度） */
const canvasHeight = computed(() => {
  const vh = snapshotData.value?.viewportHeight ?? 800
  return Math.round(vh * scale.value)
})
const canvasWidth = computed(() => {
  const vw = snapshotData.value?.viewportWidth ?? 375
  return Math.round(vw * scale.value)
})

/** 根据 tag 和状态返回色块样式 */
function elementStyle(el: SnapshotElement): Record<string, string> {
  if (!el.rect) return {}
  const s = scale.value
  const w = Math.max(2, Math.round(el.rect.w * s))
  const h = Math.max(2, Math.round(el.rect.h * s))
  return {
    left: `${Math.round(el.rect.x * s)}px`,
    top: `${Math.round(el.rect.y * s)}px`,
    width: `${w}px`,
    height: `${h}px`,
  }
}

/** 根据 tag 类型返回颜色类 */
const TAG_COLORS: Record<string, string> = {
  button: 'bg-blue-500/20 border-blue-500/50 text-blue-700 dark:text-blue-300',
  a: 'bg-green-500/15 border-green-500/40 text-green-700 dark:text-green-300',
  input: 'bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300',
  textarea: 'bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300',
  select: 'bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300',
  h1: 'bg-purple-500/15 border-purple-500/40 text-purple-700 dark:text-purple-300',
  h2: 'bg-purple-500/15 border-purple-500/40 text-purple-700 dark:text-purple-300',
  h3: 'bg-purple-500/10 border-purple-500/30 text-purple-700 dark:text-purple-300',
  img: 'bg-pink-500/10 border-pink-500/30 text-pink-700 dark:text-pink-300',
}

/** 默认色块样式 */
const DEFAULT_COLOR = 'bg-gray-500/10 border-gray-400/30 text-gray-600 dark:text-gray-400'

/** 获取元素的颜色类 */
function elementColor(el: SnapshotElement): string {
  return TAG_COLORS[el.tag] ?? DEFAULT_COLOR
}

/** 获取色块内显示的标签文字 */
function elementLabel(el: SnapshotElement): string {
  const parts: string[] = [el.tag]
  if (el.idx !== undefined) parts.push(`#${el.idx}`)
  /** 短文本在色块够大时显示 */
  if (el.text && el.text.length <= 20) parts.push(el.text)
  else if (el.placeholder) parts.push(el.placeholder.slice(0, 15))
  else if (el.value) parts.push(el.value.slice(0, 15))
  return parts.join(' ')
}

/** 色块是否够大可以显示文字 */
function canShowLabel(el: SnapshotElement): boolean {
  if (!el.rect) return false
  const s = scale.value
  return el.rect.w * s > 40 && el.rect.h * s > 16
}

/** 容器 DOM ref（滚动区域） */
const containerRef = ref<HTMLElement | null>(null)

/**
 * 宽度测量 sentinel —— 一个不随画布大小变化的稳定元素
 *
 * 不能监听 containerRef 本身：画布在 containerRef 内，画布尺寸变化会引起
 * 滚动条出现/消失 → containerRef contentRect 变化 → 触发 ResizeObserver
 * → 重算 scale → 画布尺寸又变 → 无限循环闪烁。
 * sentinel 是一个 width:100%、height:0 的 div，只反映容器实际可用宽度。
 */
const sentinelRef = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null

onMounted(async () => {
  await nextTick()
  if (sentinelRef.value) {
    containerWidth.value = sentinelRef.value.clientWidth
    resizeObserver = new ResizeObserver((entries) => {
      for (const e of entries) {
        /** 用 borderBoxSize[0] 更稳定，不受 padding 变化影响 */
        const w = e.borderBoxSize?.[0]?.inlineSize ?? e.contentRect.width
        if (w > 0) containerWidth.value = w
      }
    })
    resizeObserver.observe(sentinelRef.value)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden bg-base">
    <!-- 工具栏：视图切换 + 搜索 + 复制 + 刷新 -->
    <div class="flex items-center gap-2 px-4 py-2 border-b border-base bg-surface flex-wrap">
      <!-- 视图切换 -->
      <div class="flex rounded border border-base overflow-hidden flex-shrink-0">
        <button
          @click="viewMode = 'preview'"
          class="px-2.5 py-0.5 text-xs font-medium transition-colors"
          :class="viewMode === 'preview' ? 'bg-blue-600 text-white' : 'bg-elevated text-muted hover:text-primary'"
        >预览</button>
        <button
          @click="viewMode = 'text'"
          class="px-2.5 py-0.5 text-xs font-medium transition-colors"
          :class="viewMode === 'text' ? 'bg-blue-600 text-white' : 'bg-elevated text-muted hover:text-primary'"
        >文本</button>
      </div>

      <!-- 文本模式的搜索框 -->
      <input
        v-if="viewMode === 'text'"
        v-model="snapshotSearch"
        placeholder="搜索快照（元素名 / idx / 状态 token）"
        class="flex-1 min-w-[120px] px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
      />
      <span v-if="viewMode === 'text' && filteredSnapshotLines" class="text-xs text-faint whitespace-nowrap">{{ filteredSnapshotLines.length }} 行</span>

      <!-- 预览模式的元素计数 -->
      <span v-if="viewMode === 'preview' && snapshotData" class="text-xs text-faint whitespace-nowrap">
        {{ rectElements.length }} 元素 · {{ snapshotData.viewportWidth }}×{{ snapshotData.viewportHeight }}
      </span>

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

    <!-- 快照内容 -->
    <div ref="containerRef" class="flex-1 overflow-auto">
      <!-- 宽度测量 sentinel：不随画布大小变化，避免 ResizeObserver 循环 -->
      <div ref="sentinelRef" class="w-full h-0 overflow-hidden"></div>
      <div v-if="snapLoading" class="text-faint text-center py-8">加载中...</div>

      <!-- 预览模式：布局框图 -->
      <template v-else-if="viewMode === 'preview' && snapshotData">
        <div
          class="relative mx-auto bg-white dark:bg-gray-900 border border-base"
          :style="{ width: canvasWidth + 'px', height: canvasHeight + 'px', marginTop: '16px', marginBottom: '16px' }"
        >
          <!-- 元素色块 -->
          <div
            v-for="el in rectElements"
            :key="el.idx"
            class="absolute border rounded-sm overflow-hidden flex items-center justify-center px-0.5 cursor-default transition-opacity hover:opacity-100 hover:z-10 hover:shadow-lg"
            :class="[elementColor(el), canShowLabel(el) ? 'opacity-90' : 'opacity-60']"
            :style="elementStyle(el)"
            :title="`${el.tag} #${el.idx}${el.text ? ' | ' + el.text : ''}${el.value ? ' | val=' + el.value : ''}${el.disabled ? ' | disabled' : ''}${el.focused ? ' | focused' : ''}`"
          >
            <span v-if="canShowLabel(el)" class="text-[9px] font-mono leading-tight truncate pointer-events-none">
              {{ elementLabel(el) }}
            </span>
            <!-- 聚焦标记 -->
            <span
              v-if="el.focused"
              class="absolute -top-px -right-px w-1.5 h-1.5 rounded-full bg-orange-500"
            ></span>
          </div>
        </div>
        <!-- 图例 -->
        <div class="px-4 py-2 border-t border-base bg-surface flex flex-wrap gap-3 text-[10px] text-muted sticky bottom-0">
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-sm bg-blue-500/30 border border-blue-500/50"></span>button</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-sm bg-green-500/25 border border-green-500/40"></span>link</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-sm bg-amber-500/25 border border-amber-500/40"></span>input</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-sm bg-purple-500/25 border border-purple-500/40"></span>heading</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-sm bg-gray-500/20 border border-gray-400/30"></span>other</span>
          <span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-orange-500"></span>focused</span>
        </div>
      </template>

      <!-- 预览模式无数据 -->
      <div v-else-if="viewMode === 'preview' && !snapshotData" class="text-faint text-center py-8 text-sm">
        快照数据不可用，切换到文本模式查看
      </div>

      <!-- 文本模式 -->
      <template v-else>
        <div class="p-4">
          <pre v-if="filteredSnapshotLines" class="text-xs font-mono text-primary whitespace-pre-wrap">{{ filteredSnapshotLines.join('\n') }}</pre>
          <pre v-else class="text-xs font-mono text-primary whitespace-pre-wrap">{{ snapshotText }}</pre>
          <div v-if="filteredSnapshotLines && filteredSnapshotLines.length === 0" class="text-faint text-center py-8 text-sm">无匹配行</div>
        </div>
      </template>
    </div>
  </div>
</template>
