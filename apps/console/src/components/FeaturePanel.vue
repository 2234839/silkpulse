<script setup lang="ts">
/**
 * FeaturePanel —— 目标设备特性检测面板
 *
 * 类似 Modernizr，检测目标设备的 CSS/JS/网络/媒体/存储能力。
 * 通过 HTTP API 调 /api/devices/:id/feature-detect，结果按分类分组展示。
 * 支持搜索筛选 + 刷新重测。
 */
import { ref, computed, watch } from 'vue'
import { copyText } from '../utils/clipboard'
import { apiFetch } from '../utils/api'

interface FeatureResult {
  id: string
  label: string
  category: string
  value: boolean | string
  /** MDN 文档完整 URL */
  mdn?: string
  /** 简短说明 */
  desc?: string
}

const props = defineProps<{
  /** 当前选中设备 id */
  deviceId: string
}>()

/** 检测结果（原始数组） */
const results = ref<FeatureResult[]>([])
/** 加载状态 */
const loading = ref(false)
/** 错误信息 */
const error = ref<string | null>(null)

/** 分类显示名 */
const CATEGORY_LABELS: Record<string, string> = {
  css: 'CSS 特性',
  'js-api': 'JS API',
  network: '网络能力',
  media: '媒体能力',
  storage: '存储能力',
  device: '设备信息',
  element: 'HTML 元素',
}

/** 分类排列顺序 */
const CATEGORY_ORDER = ['css', 'js-api', 'network', 'media', 'storage', 'device', 'element']

/** 按分类组织的结果 */
const groupedResults = computed(() => {
  const grouped = new Map<string, FeatureResult[]>()
  for (const r of results.value) {
    const arr = grouped.get(r.category) ?? []
    arr.push(r)
    grouped.set(r.category, arr)
  }
  return CATEGORY_ORDER
    .filter((cat) => grouped.has(cat))
    .map((cat) => ({ category: cat, label: CATEGORY_LABELS[cat] ?? cat, items: grouped.get(cat)! }))
})

/** 搜索筛选 */
const searchQuery = ref('')
const filteredGroups = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return groupedResults.value
  /** 搜索匹配 id/label，或匹配 value（如搜"false"看所有不支持的） */
  return groupedResults.value
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (r) =>
          r.id.toLowerCase().includes(q) ||
          r.label.toLowerCase().includes(q) ||
          String(r.value).toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.items.length > 0)
})

/** 统计 */
const stats = computed(() => {
  const total = results.value.length
  const supported = results.value.filter((r) => r.value === true || (typeof r.value === 'string' && r.value !== 'false')).length
  const unsupported = results.value.filter((r) => r.value === false).length
  return { total, supported, unsupported }
})

/** 拉取检测结果 */
async function fetchFeatures() {
  loading.value = true
  error.value = null
  try {
    const res = await apiFetch(`/api/devices/${props.deviceId}/feature-detect`)
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      error.value = data.error ?? `HTTP ${res.status}`
      results.value = []
    } else {
      results.value = await res.json()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    results.value = []
  } finally {
    loading.value = false
  }
}

/** 进入面板时拉取（deviceId 变化时也重拉） */
watch(
  () => props.deviceId,
  (id) => {
    if (id) fetchFeatures()
  },
  { immediate: true },
)

/** 复制检测结果为 JSON（方便分享/AI 诊断） */
const copyState = ref<'idle' | 'copied'>('idle')
async function copyResults() {
  const compact = results.value
    .map((r) => `${r.label}: ${r.value}`)
    .join('\n')
  await copyText(compact)
  copyState.value = 'copied'
  setTimeout(() => { copyState.value = 'idle' }, 1500)
}
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden bg-base">
    <!-- 工具栏 -->
    <div class="flex items-center gap-2 px-4 py-2 border-b border-base bg-surface">
      <input
        v-model="searchQuery"
        placeholder="搜索特性（名称 / true / false）"
        class="flex-1 text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
      />
      <span class="text-xs text-faint whitespace-nowrap">
        {{ stats.supported }}/{{ stats.total }} 支持
        <span v-if="stats.unsupported > 0" class="text-red-500">· {{ stats.unsupported }} 不支持</span>
      </span>
      <button
        @click="copyResults"
        class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary transition-colors whitespace-nowrap"
      >{{ copyState === 'copied' ? '✓ 已复制' : '复制' }}</button>
      <button
        @click="fetchFeatures"
        :disabled="loading"
        class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary transition-colors whitespace-nowrap disabled:opacity-50"
      >{{ loading ? '检测中...' : '刷新' }}</button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading && results.length === 0" class="flex-1 flex items-center justify-center text-faint text-sm">
      正在检测目标设备特性...
    </div>

    <!-- 错误 -->
    <div v-else-if="error" class="flex-1 flex items-center justify-center">
      <div class="text-center">
        <p class="text-red-500 text-sm mb-2">检测失败</p>
        <p class="text-faint text-xs font-mono mb-3">{{ error }}</p>
        <button
          @click="fetchFeatures"
          class="px-3 py-1.5 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary"
        >重试</button>
      </div>
    </div>

    <!-- 结果列表 -->
    <div v-else class="flex-1 overflow-y-auto p-4 space-y-4">
      <div v-for="group in filteredGroups" :key="group.category">
        <!-- 分类标题 -->
        <div class="flex items-center gap-2 mb-2">
          <h3 class="text-xs font-semibold text-secondary uppercase tracking-wide">{{ group.label }}</h3>
          <span class="text-xs text-faint">{{ group.items.filter((r) => r.value === true || (typeof r.value === 'string' && r.value !== 'false')).length }}/{{ group.items.length }}</span>
        </div>
        <!-- 检测项 -->
        <div class="grid grid-cols-2 gap-1">
          <div
            v-for="item in group.items"
            :key="item.id"
            class="flex items-center gap-2 px-2 py-1.5 rounded border border-light bg-surface text-xs"
          >
            <!-- 状态指示灯 -->
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :class="item.value === false ? 'bg-red-500' : typeof item.value === 'string' && item.value !== 'dark' && item.value !== 'light' ? 'bg-amber-400' : 'bg-green-500'"
            />
            <!-- 特性名称 + 说明 tooltip -->
            <span
              class="text-primary truncate flex-1"
              :title="item.desc || ''"
            >{{ item.label }}</span>
            <!-- MDN 文档链接 -->
            <a
              v-if="item.mdn"
              :href="item.mdn"
              target="_blank"
              rel="noopener"
              class="text-blue-400 hover:text-blue-500 text-[10px] shrink-0"
              title="MDN 文档"
            >↗</a>
            <!-- 检测值 -->
            <span
              class="font-mono text-[10px] shrink-0"
              :class="item.value === false ? 'text-red-400' : typeof item.value === 'string' && item.value !== 'true' ? 'text-amber-500' : 'text-green-600'"
            >{{ item.value === true ? '✓' : item.value === false ? '✗' : item.value }}</span>
          </div>
        </div>
      </div>

      <div v-if="filteredGroups.length === 0" class="text-faint text-center py-8 text-sm">
        {{ searchQuery ? '无匹配特性' : '暂无检测结果' }}
      </div>
    </div>
  </div>
</template>
