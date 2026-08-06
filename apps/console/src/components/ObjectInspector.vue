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
import { ref, computed, watch } from 'vue'
import type { SerializedValue } from '@clarosight/shared'

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
}>(), {
  depth: 0,
  editable: false,
})

const emit = defineEmits<{
  /** 值被修改时触发（editable 模式），传递新值 */
  'update:modelValue': [value: unknown]
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

  if (t === 'function') return { type: 'function', preview: `ƒ ${(val as { name?: string }).name || ''}()` }
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

/** 是否展开 */
const expanded = ref(props.depth < 1)

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
  /** 外部数据变化时重置展开状态 */
  expanded.value = props.depth < 1
})

function toggle() {
  if (hasChildren.value) expanded.value = !expanded.value
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

function typeColor(type: string): string {
  const colors: Record<string, string> = {
    string: '#ce9178',
    number: '#b5cea8',
    boolean: '#569cd6',
    null: '#569cd6',
    undefined: '#569cd6',
    bigint: '#b5cea8',
    function: '#dcdcaa',
    array: '#4ec9b0',
    object: '#4ec9b0',
    date: '#dcdcaa',
    regexp: '#d16969',
    error: '#f44747',
    map: '#4ec9b0',
    set: '#4ec9b0',
    promise: '#4ec9b0',
    element: '#d7ba7d',
    event: '#d7ba7d',
  }
  return colors[type] || '#d4d4d4'
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
</script>

<template>
  <div class="oi-node">
    <!-- 行：箭头 + key + 值预览 -->
    <div class="oi-row" @click.stop="toggle">
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
        <!-- 只读/查看模式 -->
        <span
          v-else
          class="oi-value"
          :class="{ 'oi-clickable': isEditableLeaf }"
          :style="{ color: typeColor(node.type) }"
          @click.stop="startEdit"
        >{{ node.preview }}</span>
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
        :editable="editable"
        @update:model-value="onChildUpdate(child.key, $event)"
      />
      <div v-if="children.length > 50" class="oi-more">
        … {{ children.length - 50 }} more
      </div>
    </div>
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
  padding: 0;
}

.oi-row:hover {
  background: rgba(127, 127, 127, 0.08);
}

.oi-arrow {
  display: inline-block;
  width: 12px;
  font-size: 9px;
  color: #888;
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
  color: #9cdcfe;
  flex-shrink: 0;
}

.oi-leaf {
  word-break: break-all;
  white-space: pre-wrap;
}

.oi-value {
  word-break: break-all;
}

.oi-clickable {
  cursor: pointer;
  border-radius: 2px;
}

.oi-clickable:hover {
  background: rgba(127, 127, 127, 0.12);
}

.oi-edit-input {
  font-family: inherit;
  font-size: inherit;
  padding: 0 2px;
  border: 1px solid #4ec9b0;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.3);
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
  opacity: 0.7;
  padding: 0 2px;
  border: 1px solid currentColor;
  border-radius: 2px;
  flex-shrink: 0;
}

.oi-collapsed-hint {
  color: #666;
  font-size: 11px;
}

.oi-children {
  margin-left: 16px;
  border-left: 1px solid rgba(127, 127, 127, 0.12);
  padding-left: 4px;
}

.oi-more {
  color: #666;
  font-style: italic;
  padding-left: 16px;
  font-size: 11px;
}
</style>
