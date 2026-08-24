<script setup lang="ts">
/**
 * ObjectInspector —— 统一对象展示/编辑组件
 *
 * 替代旧版 ObjectTreeView（只读）+ JsonTreeEditor（可编辑），
 * 一个组件覆盖所有需要展示/编辑对象数据的场景。
 *
 * ### 数据入口（三选一）
 * - `value: SerializedValue` —— exec 结果等结构化序列化值（远程环境采集的丰富类型）
 * - `raw: unknown` —— 普通 JS 对象/数组/基本类型（自动适配为 SerializedValue 树）
 * - `json: string` —— JSON 字符串（自动 parse 为对象树，非 JSON 时降级纯文本）
 *
 * ### 模式
 * - `readonly`（默认）—— 只读展示，所有节点不可编辑
 * - `:editable="true"` —— 叶子节点（string/number/boolean/null）可原地编辑，
 *   修改后 emit `update:modelValue` 传递新值
 *
 * ### 展示场景
 * - ConsolePanel exec 结果（只读 SerializedValue）
 * - ExecPanel exec 结果（只读 SerializedValue）
 * - NetworkPanel headers/body（只读 JSON 字符串）
 * - StoragePanel localStorage 编辑（可编辑 JSON / 文本）
 * - StoragePanel IndexedDB 记录（只读）
 */
import { ref, computed, watch, provide, inject } from 'vue'
import type { Ref } from 'vue'
import type { SerializedValue } from '@silkpulse/shared'

/* ==================== 右键菜单：展开控制广播通道 ==================== */

/**
 * 子树展开覆盖信号
 *
 * 当用户右键"展开/收起全部子节点"时，根实例设置此信号。
 * 所有节点通过 inject 读取，如果自己的 path 是 targetPath 的子孙，
 * 则 expanded 被 override 为指定值。
 *
 * 用响应式 ref 实现——即使子节点尚未渲染，一旦渲染就会立即读取到 override 值，
 * 实现"逐层自动展开"效果（Vue 的响应式更新 + nextTick 递进）。
 */
type ExpandOverride = { targetPath: number[]; value: boolean; /** 版本号，每次操作递增以触发 watch */ version: number } | null

/** 右键菜单上下文 */
interface MenuContext {
  /** 触发菜单的节点 path */
  path: number[]
  /** 该节点的 SerializedValue */
  node: SerializedValue
  /** 鼠标坐标 */
  x: number
  y: number
  /** 是否有子节点 */
  hasChildren: boolean
}

const props = withDefaults(defineProps<{
  /** 结构化序列化值（优先使用，来自远程 exec） */
  value?: SerializedValue
  /** 普通 JS 对象/基本类型（自动适配） */
  raw?: unknown
  /** JSON 字符串（自动 parse，非 JSON 降级纯文本） */
  json?: string
  /** 属性键名（子节点才有） */
  keyName?: string
  /** 嵌套深度（根为 0，自动控制默认展开层级） */
  depth?: number
  /** 是否可编辑 */
  editable?: boolean
  /** 子节点索引（用于构建唯一 path，右键菜单展开控制用） */
  childIndex?: number
}>(), {
  depth: 0,
  editable: false,
  childIndex: 0,
})

const emit = defineEmits<{
  /** 值被修改时触发（editable 模式），传递新值 */
  'update:modelValue': [value: unknown]
  /** 右键菜单事件冒泡（子→父→根） */
  'context-menu': [ctx: MenuContext]
}>()

/* ==================== 数据归一化：三入口 → SerializedValue ==================== */

/**
 * 把任意输入归一化为 SerializedValue 树节点
 *
 * SerializedValue 直接透传；unknown 手动构建；JSON 字符串先 parse。
 */
function normalizeToSerialized(input: {
  value?: SerializedValue
  raw?: unknown
  json?: string
}): SerializedValue {
  /** 优先级：value > raw > json */
  if (input.value) return input.value
  if (input.raw !== undefined) return rawToSerialized(input.raw)
  if (input.json !== undefined) {
    const trimmed = input.json.trim()
    if (!trimmed) return { type: 'string', preview: '""', value: '' }
    try {
      const parsed = JSON.parse(trimmed)
      return rawToSerialized(parsed)
    } catch {
      /** 非 JSON：作为纯字符串展示 */
      return { type: 'string', preview: `"${truncate(input.json, 200)}"`, value: input.json }
    }
  }
  return { type: 'undefined', preview: 'undefined' }
}

/**
 * 把普通 JS 值转为 SerializedValue（简化版，不含远程环境的特殊类型）
 *
 * 只覆盖 object/array/基本类型——足够本地数据（storage/network）使用。
 */
function rawToSerialized(val: unknown, depth = 0): SerializedValue {
  if (val === null) return { type: 'null', preview: 'null' }
  if (val === undefined) return { type: 'undefined', preview: 'undefined' }
  const t = typeof val
  if (t === 'string') return { type: 'string', preview: `"${truncate(val, 100)}"`, value: val }
  if (t === 'number') return { type: 'number', preview: String(val), value: val }
  if (t === 'boolean') return { type: 'boolean', preview: String(val), value: val }
  if (t === 'bigint') return { type: 'bigint', preview: `${val}n`, value: String(val) }

  if (t === 'function') return { type: 'function', preview: `ƒ ${(val as { name?: string }).name || ''}()` }
  if (t === 'symbol') return { type: 'symbol', preview: String(val) }
  if (val instanceof RegExp) return { type: 'regexp', preview: String(val) }
  if (val instanceof Date) return { type: 'date', preview: isNaN(val.getTime()) ? 'Invalid Date' : val.toISOString() }

  if (Array.isArray(val)) {
    if (depth >= 8) return { type: 'array', preview: `[${val.length}]`, length: val.length }
    return {
      type: 'array',
      preview: `Array(${val.length}) [${val.slice(0, 3).map(previewOne).join(', ')}${val.length > 3 ? ', …' : ''}]`,
      elements: val.map((v) => rawToSerialized(v, depth + 1)),
      length: val.length,
    }
  }

  if (t === 'object') {
    const keys = Object.keys(val as Record<string, unknown>)
    const ctorName = (val as { constructor?: { name?: string } }).constructor?.name
    if (depth >= 8) {
      return { type: 'object', preview: `${ctorName || 'Object'} {…}`, constructorName: ctorName }
    }
    return {
      type: 'object',
      preview: `${ctorName && ctorName !== 'Object' ? ctorName + ' ' : ''}{${keys.slice(0, 3).map((k) => `${k}: ${previewOne((val as Record<string, unknown>)[k])}`).join(', ')}${keys.length > 3 ? ', …' : ''}}`,
      properties: keys.map((k) => ({
        key: k,
        value: rawToSerialized((val as Record<string, unknown>)[k], depth + 1),
      })),
      constructorName: ctorName,
    }
  }

  return { type: 'unknown', preview: String(val) }
}

/** 辅助：单值预览（用于父对象 summary） */
function previewOne(val: unknown): string {
  if (val === null) return 'null'
  if (val === undefined) return 'undefined'
  const t = typeof val
  if (t === 'string') return `"${truncate(val as string, 30)}"`
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(val)
  if (t === 'function') return `ƒ ${(val as { name?: string }).name || ''}()`
  if (t === 'symbol') return String(val)
  if (val instanceof RegExp) return String(val)
  if (val instanceof Date) return isNaN(val.getTime()) ? 'Invalid Date' : val.toISOString()
  if (Array.isArray(val)) return `Array(${val.length})`
  if (t === 'object') {
    const ctorName = (val as { constructor?: { name?: string } }).constructor?.name
    if (ctorName && ctorName !== 'Object') return ctorName
    return '{…}'
  }
  return String(val)
}

/** 辅助：截断字符串 */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 当前节点的归一化值（响应式：props 变化重新计算） */
const node = computed(() => normalizeToSerialized({
  value: props.value,
  raw: props.raw,
  json: props.json,
}))

/* ==================== 展开/折叠 ==================== */

/** 是否有子节点可展开 */
const hasChildren = computed(() => {
  const v = node.value
  return ((v.type === 'object' || v.type === 'array') &&
    ((v.properties?.length ?? 0) > 0 || (v.elements?.length ?? 0) > 0))
})

/** 子项列表（object→properties, array→elements 映射为 properties 格式） */
const children = computed(() => {
  const v = node.value
  if (v.elements) {
    return v.elements.map((e, i) => ({ key: String(i), value: e }))
  }
  return v.properties ?? []
})

watch(() => [props.value, props.raw, props.json], () => {
  /** 外部数据变化时重置展开状态 + 清除 override */
  manualExpanded.value = props.depth < 1
  if (isRoot) expandOverride.value = null
})

/** 展开/折叠切换（清除 override，让手动状态接管） */
function toggle() {
  if (!hasChildren.value) return
  /** 如果有 override，先清除再 toggle */
  if (expandOverride.value) {
    expandOverride.value = null
  }
  manualExpanded.value = !manualExpanded.value
}

/* ==================== 右键菜单：展开控制通道实现 ==================== */

/** 是否为根实例 */
const isRoot = props.depth === 0

/** 从 inject 拿到父级 path */
const parentPath = inject<number[]>('oi-path', [])

/** 当前节点的 path = 父 path + 自己的 childIndex */
const nodePath = computed(() => [...parentPath, props.childIndex])

/** 根实例创建响应式的 expandOverride 并 provide；非根 inject 已有的 */
const expandOverride = isRoot
  ? ref<ExpandOverride>(null)
  : inject<Ref<ExpandOverride>>('oi-expand-override', ref<ExpandOverride>(null))

/** provide 给子组件 */
provide('oi-path', nodePath.value)
provide('oi-expand-override', expandOverride as Ref<ExpandOverride>)

/** 判断 path A 是否为 path B 的子孙（或自身） */
function isDescendantOrSelf(maybeChild: number[], ancestor: number[]): boolean {
  if (maybeChild.length < ancestor.length) return false
  return ancestor.every((seg, i) => maybeChild[i] === seg)
}

/** 用户手动 toggle 的展开状态（优先级低于 expandOverride） */
const manualExpanded = ref(props.depth < 1)

/** 当前展开状态：expandOverride 覆盖 > 手动 toggle */
const expanded = computed({
  get: () => {
    const ov = expandOverride.value
    if (ov && isDescendantOrSelf(nodePath.value, ov.targetPath)) {
      return ov.value
    }
    return manualExpanded.value
  },
  set: (v: boolean) => { manualExpanded.value = v },
})

/**
 * 监听 override 变化，同步 manualExpanded
 *
 * 这样当 override 被清除后，manualExpanded 已记录了 override 设置的值，
 * 节点不会回退到旧状态。
 */
watch(expandOverride, (ov) => {
  if (ov && isDescendantOrSelf(nodePath.value, ov.targetPath) && hasChildren.value) {
    manualExpanded.value = ov.value
  }
}, { deep: true })

/** 右键菜单状态（仅根实例持有） */
const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)
/** 菜单操作目标的 path */
const menuTargetPath = ref<number[]>([])
/** 菜单操作目标的 SerializedValue */
const menuTargetNode = ref<SerializedValue | null>(null)
/** 菜单目标是否有子节点 */
const menuTargetHasChildren = ref(false)
/** 复制成功提示 */
const copyToast = ref('')

/** 右键事件 */
function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()

  const ctx: MenuContext = {
    path: nodePath.value,
    node: node.value,
    x: e.clientX,
    y: e.clientY,
    hasChildren: hasChildren.value,
  }

  if (isRoot) {
    onChildContextMenu(ctx)
  } else {
    /** 非根：冒泡给父级 */
    emit('context-menu', ctx)
  }
}

/** 子节点右键冒泡到根 */
function onChildContextMenu(ctx: MenuContext) {
  if (!isRoot) return
  menuTargetPath.value = ctx.path
  menuTargetNode.value = ctx.node
  menuTargetHasChildren.value = ctx.hasChildren
  /** 边界检测：靠近右/下边缘时偏移 */
  const menuW = 200, menuH = 160
  menuX.value = ctx.x + menuW > window.innerWidth ? ctx.x - menuW : ctx.x
  menuY.value = ctx.y + menuH > window.innerHeight ? ctx.y - menuH : ctx.y
  menuVisible.value = true
}

/** 从 SerializedValue 重建可 JSON 序列化的 JS 值 */
function serializedToJson(val: SerializedValue): unknown {
  switch (val.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return val.value ?? null
    case 'null':
      return null
    case 'undefined':
      return undefined
    case 'bigint':
      return val.value ?? null
    case 'array':
      return (val.elements ?? []).map(serializedToJson)
    case 'object':
    case 'map':
    case 'set': {
      const props = val.properties ?? []
      const obj: Record<string, unknown> = {}
      for (const p of props) {
        obj[p.key] = serializedToJson(p.value)
      }
      return obj
    }
    case 'date':
      return val.preview
    case 'regexp':
      return val.preview
    case 'function':
      return `[function ${val.preview}]`
    default:
      return val.preview
  }
}

/** 执行菜单操作 */
async function copyJson() {
  if (!menuTargetNode.value) return
  const jsonVal = serializedToJson(menuTargetNode.value)
  const text = JSON.stringify(jsonVal, null, 2)
  await doCopy(text)
}

async function copyValue() {
  if (!menuTargetNode.value) return
  const text = menuTargetNode.value.preview
  await doCopy(text)
}

async function doCopy(text: string) {
  menuVisible.value = false
  try {
    await navigator.clipboard.writeText(text)
    showToast('✓ 已复制')
  } catch {
    showToast('✗ 复制失败')
  }
}

function showToast(msg: string) {
  copyToast.value = msg
  setTimeout(() => { copyToast.value = '' }, 1500)
}

/**
 * 展开/收起全部子节点
 *
 * 设置 expandOverride 信号：所有 targetPath 下的子孙节点的 expanded computed
 * 会读取 override 值。由于 override 是响应式 ref，新渲染的子节点（因父级展开
 * 而出现的）也会立即读到 override 值并自动展开——实现逐层自动展开效果。
 * 同时 watch override 会把 manualExpanded 同步过来，保证 override 清除后状态不回退。
 */
function expandAll() {
  menuVisible.value = false
  if (!isRoot) return
  expandOverride.value = {
    targetPath: menuTargetPath.value,
    value: true,
    version: (expandOverride.value?.version ?? 0) + 1,
  }
}

function collapseAll() {
  menuVisible.value = false
  if (!isRoot) return
  expandOverride.value = {
    targetPath: menuTargetPath.value,
    value: false,
    version: (expandOverride.value?.version ?? 0) + 1,
  }
}

function closeMenu() {
  menuVisible.value = false
}

/* ==================== 编辑模式 ==================== */

/** 是否正在编辑（仅 editable 模式的叶子节点） */
const editing = ref(false)
/** 编辑草稿 */
const editDraft = ref('')

/** 当前叶子是否可编辑（只有 string/number/boolean/null 可编辑） */
const isEditableLeaf = computed(() => {
  if (!props.editable || hasChildren.value) return false
  const t = node.value.type
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'null'
})

function startEdit() {
  if (!isEditableLeaf.value) return
  editing.value = true
  const v = node.value
  if (v.type === 'string') {
    editDraft.value = v.value as string ?? ''
  } else if (v.type === 'null') {
    editDraft.value = 'null'
  } else {
    editDraft.value = String(v.value ?? v.preview)
  }
}

function saveEdit() {
  editing.value = false
  const raw = editDraft.value.trim()
  const t = node.value.type
  let newValue: unknown = raw

  if (t === 'number') {
    newValue = Number(raw)
    if (isNaN(newValue as number)) return
  } else if (t === 'boolean') {
    if (raw === 'true') newValue = true
    else if (raw === 'false') newValue = false
    else return
  } else if (t === 'null') {
    if (raw !== 'null') return
    newValue = null
  }
  emit('update:modelValue', newValue)
}

function cancelEdit() {
  editing.value = false
}

/** 子节点编辑冒泡 */
function onChildUpdate(childKey: string, newChildValue: unknown) {
  /**
   * 从 SerializedValue 重建原始对象——但编辑模式只用于 raw/json 入口，
   * value 入口（SerializedValue）是只读的不会触发。
   */
  if (props.raw !== undefined) {
    if (Array.isArray(props.raw)) {
      const arr = [...props.raw]
      arr[Number(childKey)] = newChildValue
      emit('update:modelValue', arr)
    } else if (props.raw !== null && typeof props.raw === 'object') {
      const obj = { ...(props.raw as Record<string, unknown>) }
      obj[childKey] = newChildValue
      emit('update:modelValue', obj)
    }
  } else if (props.json !== undefined) {
    try {
      const parsed = JSON.parse(props.json)
      if (Array.isArray(parsed)) {
        parsed[Number(childKey)] = newChildValue
      } else if (parsed !== null && typeof parsed === 'object') {
        parsed[childKey] = newChildValue
      }
      emit('update:modelValue', JSON.stringify(parsed, null, 2))
    } catch { /* 忽略 */ }
  }
}

/* ==================== 类型配色 ==================== */

/** 类型 → CSS 变量（跟随亮/暗主题，亮色下饱和度更高更醒目） */
function typeColor(type: string): string {
  const colors: Record<string, string> = {
    string: 'var(--cs-oi-string)',
    number: 'var(--cs-oi-number)',
    boolean: 'var(--cs-oi-boolean)',
    null: 'var(--cs-oi-boolean)',
    undefined: 'var(--cs-oi-boolean)',
    bigint: 'var(--cs-oi-number)',
    function: 'var(--cs-oi-function)',
    array: 'var(--cs-oi-type)',
    object: 'var(--cs-oi-type)',
    date: 'var(--cs-oi-function)',
    regexp: 'var(--cs-oi-regexp)',
    error: 'var(--cs-oi-error)',
    symbol: 'var(--cs-oi-regexp)',
    map: 'var(--cs-oi-type)',
    set: 'var(--cs-oi-type)',
    promise: 'var(--cs-oi-type)',
    element: 'var(--cs-oi-element)',
    event: 'var(--cs-oi-element)',
  }
  return colors[type] || 'var(--cs-oi-default)'
}

function typeBadge(type: string): string {
  const badges: Record<string, string> = {
    string: 'str',
    number: 'num',
    boolean: 'bool',
    null: 'null',
    undefined: 'undef',
    bigint: 'bigint',
    function: 'fn',
    array: 'arr',
    object: 'obj',
    date: 'date',
    regexp: 're',
    error: 'err',
    map: 'Map',
    set: 'Set',
    weakmap: 'WMap',
    weakset: 'WSet',
    promise: 'Promise',
    element: 'el',
    textnode: '#text',
    event: 'evt',
    symbol: 'sym',
    unknown: '?',
  }
  return badges[type] || type
}

/** 处理子组件冒泡上来的右键菜单事件 */
function handleChildContextMenu(ctx: MenuContext) {
  if (isRoot) {
    onChildContextMenu(ctx)
  } else {
    /** 非根：继续向上冒泡 */
    emit('context-menu', ctx)
  }
}
</script>

<template>
  <div class="oi-node">
    <!-- 行：箭头 + key + 值预览 -->
    <div class="oi-row" @click.stop="toggle" @contextmenu="onContextMenu">
      <!-- 展开箭头 -->
      <span class="oi-arrow" :class="{ 'oi-expanded': expanded && hasChildren, 'oi-hidden': !hasChildren }">
        ▶
      </span>

      <!-- key 名（子节点才有） -->
      <span v-if="keyName" class="oi-key">{{ keyName }}:</span>

      <!-- 叶子节点值 -->
      <span v-if="!hasChildren" class="oi-leaf">
        <!-- 编辑模式 -->
        <input
          v-if="editing"
          v-model="editDraft"
          @keydown.enter.stop.prevent="saveEdit"
          @keydown.esc.stop.prevent="cancelEdit"
          @blur="saveEdit"
          @click.stop
          class="oi-edit-input"
        />
        <!-- 只读/查看模式：字符串显示完整 value（不截断），其他类型用 preview -->
        <span
          v-else
          class="oi-value"
          :class="{ 'oi-clickable': isEditableLeaf }"
          :style="{ color: typeColor(node.type) }"
          @click.stop="startEdit"
        >{{ node.type === 'string' ? node.value ?? node.preview : node.preview }}</span>
      </span>

      <!-- 容器节点摘要 -->
      <span v-else class="oi-summary">
        <span class="oi-badge" :style="{ color: typeColor(node.type) }">
          {{ typeBadge(node.type) }}
        </span>
        <span :style="{ color: typeColor(node.type) }">{{ node.preview }}</span>
        <span v-if="!expanded" class="oi-collapsed-hint">
          ({{ children.length }} {{ node.type === 'array' ? 'items' : 'props' }})
        </span>
      </span>
    </div>

    <!-- 子节点（展开时） -->
    <div v-if="expanded && hasChildren" class="oi-children">
      <ObjectInspector
        v-for="(child, idx) in children.slice(0, 50)"
        :key="idx"
        :value="child.value"
        :key-name="child.key"
        :depth="depth + 1"
        :child-index="idx"
        :editable="editable"
        @update:model-value="onChildUpdate(child.key, $event)"
        @context-menu="handleChildContextMenu"
      />
      <div v-if="children.length > 50" class="oi-more">
        … {{ children.length - 50 }} more
      </div>
    </div>

    <!-- 右键上下文菜单（仅根实例渲染） -->
    <Teleport to="body">
      <div
        v-if="isRoot && menuVisible"
        class="oi-context-menu"
        :style="{ left: menuX + 'px', top: menuY + 'px' }"
        @click.stop
        @contextmenu.prevent.stop
      >
        <button v-if="menuTargetHasChildren" class="oi-menu-item" @click="expandAll">
          <span class="oi-menu-icon">▾</span> 展开全部子节点
        </button>
        <button v-if="menuTargetHasChildren" class="oi-menu-item" @click="collapseAll">
          <span class="oi-menu-icon">▸</span> 收起全部子节点
        </button>
        <div v-if="menuTargetHasChildren" class="oi-menu-sep"></div>
        <button class="oi-menu-item" @click="copyJson">
          <span class="oi-menu-icon">📋</span> 复制 JSON
        </button>
        <button class="oi-menu-item" @click="copyValue">
          <span class="oi-menu-icon">📄</span> 复制值
        </button>
      </div>
      <!-- 遮罩层：点击关闭菜单 -->
      <div
        v-if="isRoot && menuVisible"
        class="oi-menu-overlay"
        @click="closeMenu"
        @contextmenu.prevent.stop="closeMenu"
      ></div>
      <!-- 复制提示 toast -->
      <div v-if="isRoot && copyToast" class="oi-copy-toast">
        {{ copyToast }}
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.oi-node {
  font-family: 'SF Mono', 'Monaco', 'Cascadia Code', 'Menlo', monospace;
  font-size: 12px;
  line-height: 1.6;
  user-select: text;
}

.oi-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
  cursor: default;
  white-space: nowrap;
  padding: 0 2px;
  border-radius: 3px;
}

.oi-row:hover {
  background: var(--cs-oi-row-hover);
}

.oi-arrow {
  display: inline-block;
  width: 12px;
  font-size: 9px;
  color: var(--cs-oi-arrow);
  transition: transform 0.1s;
  flex-shrink: 0;
  cursor: pointer;
}

.oi-arrow.oi-expanded {
  transform: rotate(90deg);
}

.oi-arrow.oi-hidden {
  visibility: hidden;
}

.oi-key {
  color: var(--cs-oi-key);
  flex-shrink: 0;
}

.oi-leaf {
  word-break: break-all;
  white-space: pre-wrap;
  min-width: 0;
}

.oi-value {
  word-break: break-all;
  white-space: pre-wrap;
}

.oi-clickable {
  cursor: pointer;
  border-radius: 2px;
}

.oi-clickable:hover {
  background: var(--cs-oi-edit-hover);
}

.oi-edit-input {
  font-family: inherit;
  font-size: inherit;
  padding: 0 2px;
  border: 1px solid var(--cs-oi-edit-border);
  border-radius: 2px;
  background: var(--cs-oi-edit-bg);
  color: inherit;
  outline: none;
  width: 160px;
}

.oi-summary {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.oi-badge {
  font-size: 10px;
  padding: 0 2px;
  border: 1px solid currentColor;
  border-radius: 2px;
  flex-shrink: 0;
}

.oi-collapsed-hint {
  color: var(--cs-oi-hint);
  font-size: 11px;
}

.oi-children {
  margin-left: 16px;
  border-left: 1px solid var(--cs-oi-children-border);
  padding-left: 4px;
}

.oi-more {
  color: var(--cs-oi-hint);
  font-style: italic;
  padding-left: 16px;
  font-size: 11px;
}
</style>

<!-- 右键菜单样式（非 scoped，因为 Teleport 到 body） -->
<style>
.oi-context-menu {
  position: fixed;
  z-index: 100000;
  min-width: 180px;
  background: var(--cs-elevated, #252526);
  border: 1px solid var(--cs-border, #454545);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  padding: 4px 0;
  font-family: -apple-system, 'Segoe UI', sans-serif;
  font-size: 13px;
  user-select: none;
}

.oi-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 14px;
  background: none;
  border: none;
  color: var(--cs-text, #cccccc);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
}

.oi-menu-item:hover {
  background: #04395e;
  color: #ffffff;
}

.oi-menu-icon {
  display: inline-block;
  width: 18px;
  text-align: center;
  font-size: 12px;
  opacity: 0.8;
}

.oi-menu-sep {
  height: 1px;
  background: var(--cs-border, #454545);
  margin: 4px 0;
}

.oi-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 99999;
}

.oi-copy-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100001;
  background: #2d4f2d;
  color: #b5cea8;
  padding: 8px 20px;
  border-radius: 6px;
  font-size: 13px;
  font-family: -apple-system, 'Segoe UI', sans-serif;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  animation: oi-toast-in 0.2s ease;
}

@keyframes oi-toast-in {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
</style>
