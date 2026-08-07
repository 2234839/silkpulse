<script setup lang="ts">
/**
 * ElementPanel —— DOM 元素诊断面板
 *
 * 左侧懒加载 DOM 树（递归展开），右侧诊断卡（可见性 / 计算样式 / 盒模型 / 祖先链）。
 * 点击树节点或祖先链可跳转查看对应元素诊断。
 *
 * 复用 server 的 /element/tree（懒加载子元素）和 /element/inspect（诊断单元素）。
 */
import { ref, computed, watch, onMounted, nextTick, onUnmounted } from 'vue'
import ElementTreeNode from './ElementTreeNode.vue'
import { apiFetch } from '../utils/api'
import { useSnapshot } from '../composables/useSnapshot'
import { useResizable } from '../composables/useResizable'
import {
  useLayoutPreview,
  isContainer,
  elementColor,
  elementLabel,
} from '../composables/useLayoutPreview'
import { FrameCompositor } from '@clarosight/renderer'
import type { ConsoleMessage } from '@clarosight/shared'

/** DOM 变化数据（从 useConsoleSocket 传入） */
interface DomChangeData {
  parentIdxs: number[]
  kinds: Array<'added' | 'removed' | 'attributes' | 'text'>
  timestamp: number
}

const props = defineProps<{
  /** 当前选中设备 id */
  deviceId: string
  /** DOM 变化版本号（每次推送递增，触发刷新） */
  domChangeVersion?: number
  /** 最近一次 DOM 变化的详细数据 */
  domChangeData?: DomChangeData | null
  /** 最新的截图帧（来自 console socket） */
  screenFrame?: import('@clarosight/shared').ScreenFrame | null
  /** 远端设备截图状态（来自 console socket） */
  screenShareStatus?: import('@clarosight/shared').ScreenShareStatus | null
  /** 发送控制台消息到 server */
  sendConsoleMessage?: (msg: ConsoleMessage) => void
}>()

/** 树节点（server 返回的元素信息 + 前端展开状态） */
interface DomAttr {
  name: string
  value: string
}

interface ElementNode {
  idx: number
  tag: string
  /** 完整属性列表 */
  attributes?: DomAttr[]
  childCount: number
  text?: string
  /** shadow host 标记：该元素有 shadowRoot，展开时需请求 shadow 子树 */
  hasShadow?: boolean
  /** shadow 子元素数量（server 单独返回，childCount 只统计普通子元素） */
  shadowChildCount?: number
  /** 前端状态：是否已展开 / 是否正在加载子节点 / 已加载的子节点 */
  expanded?: boolean
  loading?: boolean
  children?: ElementNode[]
  /** shadow 子节点（与 children 分开存储，展示时合并） */
  shadowChildren?: ElementNode[]
  /** shadow 子树是否已展开 */
  shadowExpanded?: boolean
  /** DOM 变化高亮标记（收到 dom-change 后短暂高亮） */
  flash?: boolean
}

/** ─── 布局预览 ─── */
/** 左侧面板视图：tree = DOM 树，preview = 布局框图，screen = 截图 */
const leftView = ref<'tree' | 'preview' | 'screen'>('tree')
/** 布局预览模式下诊断面板是否悬浮显示（关闭后不挡预览） */
const floatDiagnosticVisible = ref(true)
/** DOM 树模式下的左侧分栏宽度可拖拽 */
const { width: treePanelWidth, onDragStart: onTreePanelResize } = useResizable({
  initial: 360,
  min: 200,
  max: 600,
  direction: 'right',
})
/** 布局预览的 sentinel（ResizeObserver 测量宽度用） */
const sentinelRef = ref<HTMLElement | null>(null)
/** 快照数据（含 rect 位置信息） */
const { snapshotData, loading: snapLoading, fetchSnapshot: fetchSnap } = useSnapshot()
/** 布局预览计算 */
const {
  rectElements,
  canvasWidth,
  canvasHeight,
  elementStyle,
  canShowLabel,
} = useLayoutPreview(snapshotData, sentinelRef)

/** ─── 远程截图 ─── */
/** 帧合成器实例 */
let compositor: FrameCompositor | null = null
/** 截图画布 ref */
const screenCanvasRef = ref<HTMLCanvasElement | null>(null)

/** 截图状态文本（由远端 SDK 上报） */
const screenStatusText = computed(() => {
  switch (props.screenShareStatus) {
    case 'sharing': return '截图进行中'
    case 'stopped': return '已停止'
    case 'error': return '截图出错'
    default: return null
  }
})

/** 截图是否活跃 */
const isScreenActive = computed(() => props.screenShareStatus === 'sharing')

/** 开始截图 */
function startScreenShare() {
  props.sendConsoleMessage?.({ type: 'start-screen-share', deviceId: props.deviceId })
}

/** 停止截图 */
function stopScreenShare() {
  props.sendConsoleMessage?.({ type: 'stop-screen-share', deviceId: props.deviceId })
  compositor?.clear()
}

/** watch 屏幕帧 → 合成到 canvas */
watch(
  () => props.screenFrame,
  (frame) => {
    if (!frame || !screenCanvasRef.value) return
    if (!compositor) {
      compositor = new FrameCompositor(screenCanvasRef.value)
    }
    compositor.drawFrame(frame)
  },
)

onUnmounted(() => {
  compositor?.clear()
  compositor = null
})

/** 元素诊断信息（server /element/inspect 返回） */
interface ElementInspect {
  idx: number
  tag: string
  id?: string
  classes?: string
  visibility: {
    display: string
    visibility: string
    opacity: string
    width: number
    height: number
    inViewport: boolean
    coveredBy?: { tag: string; id?: string; classes?: string } | null
  }
  computedStyle: Record<string, string>
  box: {
    content: { width: number; height: number }
    padding: { top: number; right: number; bottom: number; left: number }
    border: { top: number; right: number; bottom: number; left: number }
    margin: { top: number; right: number; bottom: number; left: number }
  }
  ancestors: Array<{ idx: number; tag: string; id?: string; classes?: string }>
  error?: string
}

/** CSS 属性值（含 !important 标记） */
interface CSSPropInfo {
  value: string
  important: boolean
}

/** 匹配的 CSS 规则（DevTools Styles 面板风格） */
interface MatchedRule {
  /** 选择器（单条，已从逗号分隔的选择器列表中拆出） */
  selector: string
  /** 原始完整选择器（如有多选择器逗号分隔） */
  selectors?: string
  /** 属性列表 */
  props: Record<string, CSSPropInfo>
  /** 特异性 [a, b, c] */
  specificity: [number, number, number]
  /** 是否含 !important */
  important: boolean
  /** 来源（文件名 / <style>[N]） */
  source: string
  /** @media 条件（如果有） */
  media?: string
  /** 跨域不可读 */
  crossOrigin?: boolean
}

/** 样式检查器数据（server /element/styles 返回） */
interface ElementStyles {
  matchedRules: MatchedRule[]
  inlineStyle: Record<string, CSSPropInfo>
  inherited: Array<{ from: string; props: Record<string, string> }>
  error?: string
}

/** 树根节点（documentElement = <html>） */
const elementTreeRoot = ref<ElementNode[]>([])
/** 当前选中的元素 idx */
const selectedElementIdx = ref<number | null>(null)
/** 当前选中元素的诊断信息 */
const elementInspect = ref<ElementInspect | null>(null)
/** 树/诊断是否正在加载 */
const elementTreeLoading = ref(false)
const elementInspectLoading = ref(false)
/** 样式检查器数据 */
const elementStyles = ref<ElementStyles | null>(null)
/** 样式检查器加载中 */
const elementStylesLoading = ref(false)
/** 展开的规则（规则索引 → 是否展开），默认第一条展开 */
const expandedRules = ref<Set<number>>(new Set([0]))

/** filter 搜索关键词（非空时进入搜索模式） */
const filterQuery = ref('')
/** filter 搜索结果（扁平列表，非树结构） */
const filterResults = ref<ElementNode[]>([])
/** filter 搜索中 */
const filterLoading = ref(false)
/** filter debounce timer */
let filterTimer: ReturnType<typeof setTimeout> | null = null

/** filter 是否激活 */
const isFiltering = computed(() => filterQuery.value.trim().length > 0)

/** 拉取某个节点的子元素（懒加载） */
async function loadElementChildren(node: ElementNode | null, shadow = false): Promise<ElementNode[]> {
  if (!props.deviceId) return []
  const params = new URLSearchParams()
  if (node) params.set('idx', String(node.idx))
  if (shadow) params.set('shadow', '1')
  const url = `/api/devices/${props.deviceId}/element/tree?${params}`
  const res = await apiFetch(url)
  if (!res.ok) return []
  const items: ElementNode[] = await res.json()
  /** 初始化前端状态字段 */
  return items.map((n) => ({ ...n, expanded: false, loading: false }))
}

/** 加载根节点（首次进入面板或刷新时调用） */
async function loadElementTree() {
  if (elementTreeLoading.value) return
  elementTreeLoading.value = true
  try {
    const roots = await loadElementChildren(null)
    /** 根节点 <html> 默认展开，用户直接看到 head + body */
    for (const root of roots) {
      if (root.tag === 'html' && root.childCount > 0) {
        root.expanded = true
        root.children = await loadElementChildren(root)
      }
    }
    elementTreeRoot.value = roots
    rebuildIndex(elementTreeRoot.value)
  } finally {
    elementTreeLoading.value = false
  }
}

/** 切换节点展开/收起（普通子元素） */
async function toggleElementNode(node: ElementNode) {
  if (node.childCount === 0) return
  if (node.expanded) {
    node.expanded = false
    return
  }
  /** 已加载过子节点：直接展开 */
  if (node.children) {
    node.expanded = true
    return
  }
  /** 懒加载子节点 */
  node.loading = true
  try {
    node.children = await loadElementChildren(node)
    node.expanded = true
  } finally {
    node.loading = false
  }
}

/** 切换 shadow 子树展开/收起 */
async function toggleShadowNode(node: ElementNode) {
  if (node.shadowExpanded) {
    node.shadowExpanded = false
    return
  }
  if (node.shadowChildren) {
    node.shadowExpanded = true
    return
  }
  node.loading = true
  try {
    node.shadowChildren = await loadElementChildren(node, true)
    node.shadowExpanded = true
  } finally {
    node.loading = false
  }
}

/**
 * 统一 toggle 入口：根据节点状态决定展开普通子树还是 shadow 子树
 *
 * childCount 只统计普通子元素，shadowChildCount 单独管理。
 * 优先级：先展开普通 children，再展开 shadow children
 */
async function handleToggle(node: ElementNode) {
  const hasNormalChildren = node.childCount > 0
  const hasShadow = node.hasShadow

  /** 情况 1：只有 shadow（无普通子元素）→ 展开 shadow */
  if (hasShadow && !hasNormalChildren) {
    await toggleShadowNode(node)
    return
  }
  /** 情况 2：普通 children 已展开 → 检查是否要展开 shadow */
  if (node.expanded && hasShadow && !node.shadowExpanded) {
    await toggleShadowNode(node)
    return
  }
  /** 情况 3：shadow 已展开，再次点击 → 收起 shadow */
  if (node.expanded && node.shadowExpanded) {
    node.shadowExpanded = false
    return
  }
  /** 情况 4：常规 toggle 普通 children */
  await toggleElementNode(node)
}

/** filter 搜索：debounce 触发 */
function onFilterInput() {
  if (filterTimer) clearTimeout(filterTimer)
  const q = filterQuery.value.trim()
  if (!q) {
    filterResults.value = []
    filterLoading.value = false
    return
  }
  filterLoading.value = true
  filterTimer = setTimeout(async () => {
    try {
      const url = `/api/devices/${props.deviceId}/element/tree?filter=${encodeURIComponent(q)}`
      const res = await apiFetch(url)
      if (res.ok) {
        const items: ElementNode[] = await res.json()
        /** 初始化前端状态字段 */
        filterResults.value = items.map((n) => ({ ...n, expanded: false, loading: false }))
      }
    } finally {
      filterLoading.value = false
    }
  }, 300)
}

/** 选中元素：拉诊断信息 + 样式规则 */
async function selectElement(idx: number) {
  if (!props.deviceId) return
  selectedElementIdx.value = idx
  elementInspectLoading.value = true
  elementInspect.value = null
  elementStylesLoading.value = true
  elementStyles.value = null
  expandedRules.value = new Set([0])
  /** 并行拉取 inspect 和 styles */
  const inspectPromise = apiFetch(`/api/devices/${props.deviceId}/element/inspect?idx=${idx}`)
    .then((res) => res.ok ? res.json() : null)
    .finally(() => { elementInspectLoading.value = false })
  const stylesPromise = apiFetch(`/api/devices/${props.deviceId}/element/styles?idx=${idx}`)
    .then((res) => res.ok ? res.json() : null)
    .finally(() => { elementStylesLoading.value = false })
  const [inspectData, stylesData] = await Promise.all([inspectPromise, stylesPromise])
  elementInspect.value = inspectData
  elementStyles.value = stylesData
}

/** 切换规则展开/收起 */
function toggleRule(idx: number) {
  if (expandedRules.value.has(idx)) {
    expandedRules.value.delete(idx)
  } else {
    expandedRules.value.add(idx)
  }
  /** 触发响应式更新 */
  expandedRules.value = new Set(expandedRules.value)
}

/** 树节点的显示文本（tag#id.class1.class2 或 text） */
// ──────── 实时刷新（dom-change 推送） ────────

/**
 * 所有节点索引（扁平 Map），用于 O(1) 查找受影响的节点
 *
 * 每次 loadElementTree / loadElementChildren 后重建。
 * dom-change 到达时，用 parentIdxs 在此 Map 中查找并刷新。
 */
const nodeIndex = new Map<number, ElementNode>()

/** 重建节点索引（递归遍历树） */
function rebuildIndex(nodes: ElementNode[]): void {
  for (const n of nodes) {
    nodeIndex.set(n.idx, n)
    if (n.children) rebuildIndex(n.children)
    if (n.shadowChildren) rebuildIndex(n.shadowChildren)
  }
}

/** 在整棵树中递归查找指定 idx 的节点 */
function findNode(nodes: ElementNode[], idx: number): ElementNode | null {
  for (const n of nodes) {
    if (n.idx === idx) return n
    if (n.children) {
      const found = findNode(n.children, idx)
      if (found) return found
    }
    if (n.shadowChildren) {
      const found = findNode(n.shadowChildren, idx)
      if (found) return found
    }
  }
  return null
}

/**
 * 刷新已展开的节点（收到 dom-change 后调用）
 *
 * 对 parentIdxs 中每个已展开的节点重新拉取子元素，更新 children。
 * 同时给变化的节点打 flash 高亮标记。
 */
async function refreshChangedNodes(changes: DomChangeData) {
  const refreshed = new Set<number>()

  for (const parentIdx of changes.parentIdxs) {
    /** 优先在 nodeIndex 里找 */
    let node = nodeIndex.get(parentIdx) ?? null
    if (!node) {
      node = findNode(elementTreeRoot.value, parentIdx)
      if (node) nodeIndex.set(parentIdx, node)
    }

    if (!node) continue

    /** 高亮变化的节点 */
    node.flash = true
    setTimeout(() => { if (node) node.flash = false }, 1500)

    /** 如果该节点已展开且有 children 已加载，刷新 children */
    if (node.expanded && !refreshed.has(parentIdx)) {
      refreshed.add(parentIdx)
      try {
        const freshChildren = await loadElementChildren(node)
        /** 高亮新出现的子节点 */
        const oldIdxs = new Set((node.children ?? []).map((c) => c.idx))
        for (const fc of freshChildren) {
          if (!oldIdxs.has(fc.idx)) {
            fc.flash = true
            setTimeout(() => { fc.flash = false }, 1500)
          }
        }
        node.children = freshChildren
        rebuildIndex(elementTreeRoot.value)
      } catch {
        /** 刷新失败静默，下次变化会再试 */
      }
    }

    /** shadow 子树也刷新 */
    if (node.shadowExpanded && !refreshed.has(-parentIdx)) {
      refreshed.add(-parentIdx)
      try {
        node.shadowChildren = await loadElementChildren(node, true)
      } catch {
        /** 静默 */
      }
    }
  }

  /** 如果根级别的某个 parentIdx 是 body（idx=0 或 parentIdx 未找到），刷新根 */
  const rootParents = changes.parentIdxs.filter(
    (idx) => !nodeIndex.has(idx) && !findNode(elementTreeRoot.value, idx)
  )
  if (rootParents.length > 0 && !refreshed.has(-1)) {
    refreshed.add(-1)
    /** 有变化但找不到具体节点 → 可能是 body 级变化，刷新根 */
    elementTreeRoot.value = await loadElementChildren(null)
    rebuildIndex(elementTreeRoot.value)
  }
}

/** watch domChangeVersion 触发刷新 */
watch(
  () => props.domChangeVersion,
  (newVal, oldVal) => {
    if (newVal === oldVal || !newVal) return
    if (props.domChangeData && !isFiltering.value) {
      refreshChangedNodes(props.domChangeData)
    }
  }
)

/** 设备切换时清空树 + 重新加载 + 拉取快照 */
watch(
  () => props.deviceId,
  () => {
    nodeIndex.clear()
    elementTreeRoot.value = []
    selectedElementIdx.value = null
    elementInspect.value = null
    if (props.deviceId) {
      loadElementTree()
      fetchSnap(props.deviceId)
    }
  }
)

/** 首次挂载时自动加载 */
onMounted(() => {
  if (props.deviceId) {
    loadElementTree()
    fetchSnap(props.deviceId)
  }
})
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden bg-base relative">
    <!-- 顶部工具栏：视图切换 + 刷新 -->
    <div class="px-3 py-2 border-b border-base bg-surface flex items-center justify-between gap-2 flex-shrink-0">
      <div class="flex rounded border border-base overflow-hidden flex-shrink-0">
          <button
            @click="leftView = 'tree'"
            class="px-2 py-0.5 text-xs font-medium transition-colors"
            :class="leftView === 'tree' ? 'bg-blue-600 text-white' : 'bg-elevated text-muted hover:text-primary'"
          >DOM 树</button>
          <button
            @click="leftView = 'preview'"
            class="px-2 py-0.5 text-xs font-medium transition-colors"
            :class="leftView === 'preview' ? 'bg-blue-600 text-white' : 'bg-elevated text-muted hover:text-primary'"
          >布局预览</button>
          <button
            @click="leftView = 'screen'"
            class="px-2 py-0.5 text-xs font-medium transition-colors"
            :class="leftView === 'screen' ? 'bg-blue-600 text-white' : 'bg-elevated text-muted hover:text-primary'"
          >截图</button>
      </div>
      <button
        v-if="leftView === 'tree'"
        @click="loadElementTree"
        :disabled="elementTreeLoading"
        class="text-xs text-faint hover:text-primary disabled:opacity-50"
      >{{ elementTreeLoading ? '加载中...' : '刷新' }}</button>
      <span v-else-if="snapshotData" class="text-xs text-faint whitespace-nowrap">{{ rectElements.length }} 元素 · {{ snapshotData.viewportWidth }}×{{ snapshotData.viewportHeight }}</span>
    </div>

    <!-- ═══ 主体区域 ═══ -->
    <div class="flex-1 flex overflow-hidden relative">
      <!-- ═══ DOM 树模式：左右分栏（可拖拽） ═══ -->
      <template v-if="leftView === 'tree'">
        <!-- 左：DOM 树 -->
        <div class="border-r border-base flex flex-col overflow-hidden flex-shrink-0" :style="{ width: treePanelWidth + 'px' }">
      <!-- DOM 树视图 -->
      <!-- tree 模式：左侧只放 filter + tree -->
        <!-- filter 搜索框 -->
        <div class="px-3 py-2 border-b border-base bg-surface">
          <input
            v-model="filterQuery"
            @input="onFilterInput"
            type="text"
            placeholder="搜索元素 (tag/id/class/text)..."
            spellcheck="false"
            autocomplete="off"
            class="w-full text-xs px-2 py-1 bg-base border border-base rounded text-primary placeholder:text-faint focus:outline-none focus:border-primary"
          />
        </div>
        <!-- 树 / 搜索结果 -->
        <div class="flex-1 overflow-y-auto p-2 font-mono text-xs">
          <!-- filter 搜索模式 -->
          <template v-if="isFiltering">
            <div v-if="filterLoading" class="text-faint text-center py-4">搜索中...</div>
            <div v-else-if="filterResults.length === 0" class="text-faint text-center py-4">无匹配元素</div>
            <template v-else>
              <div class="text-faint text-[10px] mb-2">{{ filterResults.length }} 个匹配</div>
              <ElementTreeNode
                v-for="item in filterResults"
                :key="item.idx"
                :node="item"
                :depth="0"
                :selected-idx="selectedElementIdx"
                @toggle="handleToggle"
                @select="selectElement"
              />
            </template>
          </template>
          <!-- 正常树模式 -->
          <template v-else>
            <div v-if="elementTreeLoading && elementTreeRoot.length === 0" class="text-faint text-center py-8">加载中...</div>
            <div v-else-if="elementTreeRoot.length === 0" class="text-faint text-center py-8">暂无元素</div>
            <template v-else>
              <ElementTreeNode
                v-for="node in elementTreeRoot"
                :key="node.idx"
                :node="node"
                :depth="0"
                :selected-idx="selectedElementIdx"
                @toggle="handleToggle"
                @select="selectElement"
              />
            </template>
          </template>
        </div>
      </div>
      </template>
      <!-- 拖拽手柄（仅 tree 模式） -->
      <div
        v-if="leftView === 'tree'"
        class="w-1 cursor-col-resize bg-base hover:bg-blue-400/40 active:bg-blue-500 transition-colors flex-shrink-0"
        @mousedown="onTreePanelResize"
      ></div>
      <!-- 右：诊断面板（tree / preview 模式共用，定位不同；screen 模式隐藏） -->
      <!-- tree 模式 → flex-1 常驻；preview 模式 → absolute 悬浮卡片（有选中元素才显示） -->
      <div
        v-show="leftView !== 'screen' && (leftView === 'tree' || (floatDiagnosticVisible && elementInspect))"
        :class="leftView === 'tree'
          ? 'flex-1 overflow-y-auto p-4 min-w-0'
          : 'absolute top-2 right-2 bottom-2 w-[340px] max-w-[60%] bg-surface/95 backdrop-blur border border-base rounded-lg shadow-2xl overflow-y-auto p-3 z-30'"
      >
      <div v-if="elementInspectLoading" class="text-faint text-center py-8 text-sm">诊断中...</div>
      <div v-else-if="!elementInspect" class="text-faint text-center py-8 text-sm">点击元素查看诊断</div>
      <template v-else>
        <!-- 悬浮模式下的关闭按钮 + 标题栏 -->
        <div v-if="leftView === 'preview'" class="flex items-center justify-between mb-3 pb-2 border-b border-base">
          <span class="text-xs font-semibold text-secondary">元素诊断</span>
          <button
            @click="floatDiagnosticVisible = false"
            class="text-faint hover:text-primary text-xs px-1"
            title="关闭诊断面板"
          >✕</button>
        </div>
        <!-- 元素标题 -->
        <div class="mb-4">
          <div class="text-sm font-semibold text-primary font-mono">
            {{ elementInspect.tag }}<span v-if="elementInspect.id" class="text-blue-600">#{{ elementInspect.id }}</span>
          </div>
          <div v-if="elementInspect.classes" class="text-xs text-muted font-mono mt-1">{{ elementInspect.classes }}</div>
        </div>

        <!-- 可见性诊断 -->
        <div class="bg-surface border border-base rounded p-3 mb-3">
          <h4 class="text-xs font-semibold text-secondary mb-2">可见性</h4>
          <div class="space-y-1 text-xs font-mono">
            <div class="flex justify-between"><span class="text-faint">display:</span><span class="text-primary">{{ elementInspect.visibility.display }}</span></div>
            <div class="flex justify-between"><span class="text-faint">visibility:</span><span class="text-primary">{{ elementInspect.visibility.visibility }}</span></div>
            <div class="flex justify-between"><span class="text-faint">opacity:</span><span class="text-primary">{{ elementInspect.visibility.opacity }}</span></div>
            <div class="flex justify-between"><span class="text-faint">尺寸:</span><span class="text-primary">{{ Math.round(elementInspect.visibility.width) }}×{{ Math.round(elementInspect.visibility.height) }}</span></div>
            <div class="flex justify-between"><span class="text-faint">在视口内:</span><span :class="elementInspect.visibility.inViewport ? 'text-green-600' : 'text-amber-600'">{{ elementInspect.visibility.inViewport ? '✓ 是' : '✗ 否' }}</span></div>
            <div v-if="elementInspect.visibility.coveredBy" class="pt-1 border-t border-light">
              <span class="text-red-500">被遮挡:</span>
              <span class="text-primary">
                {{ elementInspect.visibility.coveredBy.tag }}<span v-if="elementInspect.visibility.coveredBy.id">#{{ elementInspect.visibility.coveredBy.id }}</span>
              </span>
            </div>
          </div>
        </div>

        <!-- 样式规则（DevTools Styles 面板风格） -->
        <div class="bg-surface border border-base rounded p-3 mb-3">
          <h4 class="text-xs font-semibold text-secondary mb-2 flex items-center gap-2">
            样式规则
            <span v-if="elementStylesLoading" class="text-faint font-normal">加载中...</span>
            <span v-else-if="elementStyles" class="text-faint font-normal">{{ elementStyles.matchedRules.length }} 条规则</span>
          </h4>

          <div v-if="elementStylesLoading" class="text-faint text-center py-4 text-xs">获取匹配的 CSS 规则...</div>

          <template v-else-if="elementStyles && !elementStyles.error">
            <!-- 内联样式（优先级最高） -->
            <div v-if="Object.keys(elementStyles.inlineStyle).length > 0" class="mb-2">
              <div class="text-[10px] text-amber-600 font-semibold mb-1 flex items-center gap-1">
                <span>Inline Style</span>
                <span class="text-faint font-normal">(element.style)</span>
              </div>
              <div class="bg-base rounded px-2 py-1 text-xs font-mono space-y-0.5">
                <div v-for="(info, prop) in elementStyles.inlineStyle" :key="prop" class="flex justify-between gap-2">
                  <span class="text-blue-600 shrink-0">{{ prop }}:</span>
                  <span class="text-primary text-right break-all">{{ info.value }}<span v-if="info.important" class="text-red-500"> !important</span></span>
                </div>
              </div>
            </div>

            <!-- 匹配的 CSS 规则（按优先级排序） -->
            <div v-for="(rule, ri) in elementStyles.matchedRules" :key="ri" class="mb-2">
              <!-- 规则头部：选择器 + 来源（可点击展开/收起） -->
              <button
                @click="toggleRule(ri)"
                class="w-full text-left flex items-center gap-1 text-[10px] mb-0.5 group"
              >
                <span class="text-faint w-3">{{ expandedRules.has(ri) ? '▾' : '▸' }}</span>
                <span class="text-purple-600 font-semibold">{{ rule.selector }}</span>
                <span class="text-faint">← {{ rule.source }}</span>
                <span v-if="rule.media" class="text-blue-500">@media {{ rule.media }}</span>
                <span v-if="rule.crossOrigin" class="text-amber-600">⚠ 跨域不可读</span>
              </button>
              <!-- 规则属性（展开时显示） -->
              <div v-if="expandedRules.has(ri) && Object.keys(rule.props).length > 0" class="bg-base rounded px-2 py-1 text-xs font-mono space-y-0.5 ml-4">
                <div v-for="(info, prop) in rule.props" :key="prop" class="flex justify-between gap-2">
                  <span class="text-blue-600 shrink-0">{{ prop }}:</span>
                  <span class="text-primary text-right break-all">{{ info.value }}<span v-if="info.important" class="text-red-500"> !important</span></span>
                </div>
              </div>
              <div v-else-if="expandedRules.has(ri) && Object.keys(rule.props).length === 0" class="text-faint text-[10px] ml-4 italic">
                {{ rule.crossOrigin ? '跨域样式表无法读取规则内容' : '无属性' }}
              </div>
            </div>

            <!-- 继承属性 -->
            <div v-if="elementStyles.inherited.length > 0" class="mt-3 pt-2 border-t border-light">
              <div class="text-[10px] text-faint font-semibold mb-1">继承属性</div>
              <div v-for="(inh, ii) in elementStyles.inherited" :key="ii" class="mb-1.5">
                <div class="text-[10px] text-green-600">← {{ inh.from }}</div>
                <div class="bg-base rounded px-2 py-0.5 text-[11px] font-mono space-y-0.5 ml-2">
                  <div v-for="(val, prop) in inh.props" :key="prop" class="flex justify-between gap-2">
                    <span class="text-faint shrink-0">{{ prop }}:</span>
                    <span class="text-secondary text-right">{{ val }}</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 空状态 -->
            <div v-if="elementStyles.matchedRules.length === 0 && Object.keys(elementStyles.inlineStyle).length === 0" class="text-faint text-center py-2 text-xs">
              无匹配的 CSS 规则
            </div>
          </template>

          <div v-else-if="elementStyles?.error" class="text-red-500 text-xs">{{ elementStyles.error }}</div>
        </div>

        <!-- 计算样式 -->
        <div class="bg-surface border border-base rounded p-3 mb-3">
          <h4 class="text-xs font-semibold text-secondary mb-2">计算样式</h4>
          <div class="space-y-1 text-xs font-mono">
            <div v-for="(v, k) in elementInspect.computedStyle" :key="k" class="flex justify-between gap-2">
              <span class="text-faint shrink-0">{{ k }}:</span>
              <span class="text-primary text-right break-all">{{ v }}</span>
            </div>
          </div>
        </div>

        <!-- 盒模型 -->
        <div class="bg-surface border border-base rounded p-3 mb-3">
          <h4 class="text-xs font-semibold text-secondary mb-2">盒模型</h4>
          <div class="text-xs font-mono space-y-0.5">
            <div><span class="text-faint">content:</span> <span class="text-primary">{{ Math.round(elementInspect.box.content.width) }}×{{ Math.round(elementInspect.box.content.height) }}</span></div>
            <div><span class="text-faint">padding:</span> <span class="text-primary">{{ elementInspect.box.padding.top }} {{ elementInspect.box.padding.right }} {{ elementInspect.box.padding.bottom }} {{ elementInspect.box.padding.left }}</span></div>
            <div><span class="text-faint">border:</span> <span class="text-primary">{{ elementInspect.box.border.top }} {{ elementInspect.box.border.right }} {{ elementInspect.box.border.bottom }} {{ elementInspect.box.border.left }}</span></div>
            <div><span class="text-faint">margin:</span> <span class="text-primary">{{ elementInspect.box.margin.top }} {{ elementInspect.box.margin.right }} {{ elementInspect.box.margin.bottom }} {{ elementInspect.box.margin.left }}</span></div>
          </div>
        </div>

        <!-- 祖先链 -->
        <div v-if="elementInspect.ancestors.length > 0" class="bg-surface border border-base rounded p-3">
          <h4 class="text-xs font-semibold text-secondary mb-2">祖先链</h4>
          <div class="space-y-1">
            <button
              v-for="a in elementInspect.ancestors"
              :key="a.idx"
              @click="selectElement(a.idx)"
              class="block w-full text-left px-2 py-1 text-xs font-mono rounded hover:bg-blue-soft text-primary"
            >
              {{ a.tag }}<span v-if="a.id" class="text-blue-600">#{{ a.id }}</span><span v-if="a.classes" class="text-faint">.{{ a.classes.split(' ').join('.') }}</span>
            </button>
          </div>
        </div>
      </template>
    </div>
    <!-- ═══ 布局预览模式：画布占满全宽 ═══ -->
    <template v-if="leftView === 'preview'">
      <div class="flex-1 flex flex-col overflow-hidden min-w-0" ref="sentinelRef">
        <div class="flex-1 overflow-auto">
          <div v-if="snapLoading" class="text-faint text-center py-8 text-xs">加载快照...</div>
          <div v-else-if="!snapshotData" class="text-faint text-center py-8 text-xs">快照不可用</div>
          <template v-else>
            <div
              class="relative mx-auto bg-white dark:bg-gray-900 border border-base max-w-full"
              :style="{ width: canvasWidth + 'px', height: canvasHeight + 'px', marginTop: '8px', marginBottom: '8px' }"
            >
              <!-- 元素渲染：优先用真实视觉样式，fallback 到色块分类 -->
              <div
                v-for="el in rectElements"
                :key="el.idx"
                @click="selectElement(el.idx); floatDiagnosticVisible = true"
                class="absolute overflow-hidden flex items-center justify-center px-0.5 cursor-pointer transition-all hover:z-20 hover:shadow-lg"
                :class="[
                  el.style ? '' : elementColor(el),
                  !el.style && isContainer(el) ? 'border-dashed bg-transparent' : '',
                  selectedElementIdx === el.idx ? 'ring-2 ring-orange-500 !z-20' : '',
                ]"
                :style="elementStyle(el)"
                :title="`${el.tag} #${el.idx}${el.text ? ' | ' + el.text : ''}${el.value ? ' | val=' + el.value : ''}${el.disabled ? ' | disabled' : ''}${el.focused ? ' | focused' : ''}`"
              >
                <span
                  v-if="canShowLabel(el)"
                  class="text-[9px] font-mono leading-tight truncate pointer-events-none"
                  :class="el.style ? '' : elementColor(el)"
                >{{ elementLabel(el) }}</span>
                <span
                  v-if="el.focused"
                  class="absolute -top-px -right-px w-1.5 h-1.5 rounded-full bg-orange-500"
                ></span>
              </div>
            </div>
            <div class="px-3 py-1.5 border-t border-base bg-surface flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-muted">
              <span class="text-faint italic">点击元素 → 查看诊断 · 真实样式高保真渲染</span>
            </div>
          </template>
        </div>
        <!-- 悬浮诊断面板关闭后，提供一个重新打开的按钮 -->
        <button
          v-if="!floatDiagnosticVisible && elementInspect"
          @click="floatDiagnosticVisible = true"
          class="absolute bottom-3 right-3 px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg shadow-lg hover:bg-blue-700 z-30"
        >📋 显示诊断</button>
      </div>
    </template>

    <!-- ═══ 截图模式：点击按钮截取远端页面 ═══ -->
    <template v-if="leftView === 'screen'">
      <div class="flex-1 flex flex-col overflow-hidden">
        <!-- 控制栏 -->
        <div class="px-3 py-2 border-b border-base bg-surface flex items-center justify-between gap-2 flex-shrink-0">
          <div class="flex items-center gap-2">
            <button
              v-if="!isScreenActive"
              @click="startScreenShare"
              class="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 transition-colors"
            >开始截图</button>
            <button
              v-else
              @click="stopScreenShare"
              class="px-3 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700 transition-colors"
            >停止截图</button>
            <span v-if="screenStatusText" class="flex items-center gap-1 text-xs" :class="props.screenShareStatus === 'sharing' ? 'text-green-600 dark:text-green-400' : 'text-muted'">
              <span v-if="isScreenActive" class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
              {{ screenStatusText }}
            </span>
          </div>
        </div>

        <!-- 画面显示区 -->
        <div class="flex-1 overflow-auto flex items-center justify-center bg-gray-900/5 dark:bg-black/20">
          <div v-if="!isScreenActive && !screenFrame" class="text-center py-12 px-4">
            <div class="text-4xl mb-3 opacity-30">📸</div>
            <p class="text-sm text-muted mb-1">点击「开始截图」捕获远端页面</p>
          </div>
          <canvas
            v-else
            ref="screenCanvasRef"
            class="max-w-full max-h-full shadow-lg rounded"
            :style="{ objectFit: 'contain' }"
          ></canvas>
        </div>
      </div>
    </template>
    </div>
  </div>
</template>
