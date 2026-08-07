<script setup lang="ts">
/**
 * ElementTreeNode —— DOM 树的递归节点组件（Chrome DevTools Elements 风格）
 *
 * 纯数据驱动渲染：接收 DOM 结构信息（tagName、attributes、text），
 * 用 Vue 的 v-for / {{ }} 渲染，不手动拼接 HTML 字符串。
 *
 * 展示规则：
 * - 叶子节点（有 text 无子元素）：tag attr=val > text
 * - 收起容器：tag attr=val > …N
 * - 展开容器：开始标签 > 子节点（缩进）> 闭合标签
 * - shadow host 带 🕶️ 标记 + 紫色 shadow-root 区域
 */

/** DOM 属性 */
interface DomAttr {
  name: string
  value: string
}

interface ElementNode {
  idx: number
  tag: string
  /** 完整属性列表（server 从 el.attributes 收集） */
  attributes?: DomAttr[]
  childCount: number
  /** 叶子节点的文本内容 */
  text?: string
  hasShadow?: boolean
  shadowChildCount?: number
  expanded?: boolean
  loading?: boolean
  children?: ElementNode[]
  shadowChildren?: ElementNode[]
  shadowExpanded?: boolean
  /** DOM 变化高亮标记 */
  flash?: boolean
}

defineProps<{
  /** 当前节点 */
  node: ElementNode
  /** 嵌套深度（用于缩进） */
  depth: number
  /** 当前选中的元素 idx（高亮用） */
  selectedIdx: number | null
}>()

const emit = defineEmits<{
  /** 点箭头：展开/收起（普通子节点或 shadow 子树） */
  toggle: [node: ElementNode]
  /** 点节点本身：选中（右侧诊断卡） */
  select: [idx: number]
}>()

/** 是否展开（普通 children 或 shadow） */
function isExpanded(n: ElementNode): boolean {
  return (n.childCount > 0 && n.expanded) || (!!n.hasShadow && n.shadowExpanded)
}

/** 是否有可展开内容 */
function hasExpandable(n: ElementNode): boolean {
  return n.childCount > 0 || !!n.hasShadow
}

/** 长 style/data 属性值截断显示 */
function shortValue(name: string, value: string): string {
  if ((name === 'style' || name.startsWith('data-')) && value.length > 20) {
    return value.slice(0, 20) + '…'
  }
  return value
}
</script>

<template>
  <div class="etn-node">
    <!-- ── 开始标签行 ── -->
    <div
      class="etn-row"
      :class="{ 'etn-selected': selectedIdx === node.idx, 'etn-flash': node.flash }"
      :style="{ paddingLeft: `${depth * 20}px` }"
      @click="emit('select', node.idx)"
    >
      <!-- 展开/收起箭头 -->
      <span
        class="etn-arrow"
        :class="{ 'etn-arrow-expanded': isExpanded(node), 'etn-arrow-hidden': !hasExpandable(node) }"
        @click.stop="hasExpandable(node) && emit('toggle', node)"
      >{{ node.loading ? '⏳' : '▶' }}</span>

      <!-- shadow host 标记 -->
      <span v-if="node.hasShadow" class="etn-shadow-icon" title="Shadow Host">🕶️</span>

      <!-- 标签名 -->
      <span class="etn-tag-name">{{ node.tag }}</span>

      <!-- 属性列表（v-for 遍历，Vue 自行渲染） -->
      <span
        v-for="attr in node.attributes"
        :key="attr.name"
        class="etn-attr"
      >
        <span class="etn-attr-name">{{ attr.name }}</span>=<span class="etn-attr-value">"{{ shortValue(attr.name, attr.value) }}"</span>
      </span>

      <!-- 收起状态：显示文本或子元素数量 -->
      <template v-if="!isExpanded(node)">
        <span v-if="node.text" class="etn-text-inline"> {{ node.text }} </span>
        <span v-else-if="node.childCount > 0" class="etn-child-hint">…{{ node.childCount }}</span>
        <span v-if="node.shadowChildCount" class="etn-shadow-hint">🕶️{{ node.shadowChildCount }}</span>
      </template>
    </div>

    <!-- ── 展开后普通子节点 ── -->
    <template v-if="node.expanded && node.children">
      <div class="etn-children">
        <ElementTreeNode
          v-for="child in node.children"
          :key="child.idx"
          :node="child"
          :depth="depth + 1"
          :selected-idx="selectedIdx"
          @toggle="emit('toggle', $event)"
          @select="emit('select', $event)"
        />
      </div>
    </template>

    <!-- shadow 子树（紫色虚线标识 shadow boundary） -->
    <template v-if="node.shadowExpanded && node.shadowChildren">
      <div class="etn-shadow-root" :style="{ marginLeft: `${depth * 20 + 12}px` }">
        <div class="etn-shadow-label">⚡ #shadow-root</div>
        <ElementTreeNode
          v-for="child in node.shadowChildren"
          :key="`s-${child.idx}`"
          :node="child"
          :depth="depth + 1"
          :selected-idx="selectedIdx"
          @toggle="emit('toggle', $event)"
          @select="emit('select', $event)"
        />
      </div>
    </template>

    <!-- ── 展开后的闭合标签行 ── -->
    <div
      v-if="isExpanded(node)"
      class="etn-row etn-close"
      :style="{ paddingLeft: `${depth * 20}px` }"
      @click="emit('select', node.idx)"
    >
      <span class="etn-arrow etn-arrow-hidden">▶</span>
      <span class="etn-tag-name">/{{ node.tag }}</span>
    </div>
  </div>
</template>

<style scoped>
.etn-node {
  font-family: 'SF Mono', 'Monaco', 'Cascadia Code', 'Menlo', monospace;
  font-size: 12px;
  line-height: 1.6;
  user-select: text;
}

.etn-row {
  display: block;
  white-space: pre-wrap;
  word-break: break-all;
  padding: 1px 4px;
  border-radius: 2px;
  cursor: pointer;
  transition: background-color 0.1s;
}

.etn-row:hover {
  background: rgba(127, 127, 127, 0.08);
}

.etn-selected {
  background: rgba(86, 156, 214, 0.15);
}

.etn-arrow {
  display: inline-block;
  width: 14px;
  font-size: 9px;
  text-align: center;
  color: #888;
  transition: transform 0.1s;
  cursor: pointer;
  vertical-align: baseline;
}

.etn-arrow-expanded {
  transform: rotate(90deg);
}

.etn-arrow-hidden {
  visibility: hidden;
}

.etn-shadow-icon {
  font-size: 10px;
  margin-right: 2px;
}

/** 标签名 —— 蓝色 */
.etn-tag-name {
  color: #569cd6;
}

/** 属性 —— 整体浅色 */
.etn-attr {
  margin-left: 4px;
}

/** 属性名 —— 浅蓝 */
.etn-attr-name {
  color: #9cdcfe;
}

/** 属性值 —— 橙色 */
.etn-attr-value {
  color: #ce9178;
}

.etn-child-hint {
  color: #6a9955;
  margin-left: 4px;
}

.etn-shadow-hint {
  color: #c586c0;
  margin-left: 2px;
}

/** 内联文本 —— 浅黄 */
.etn-text-inline {
  color: #dcdcaa;
  margin-left: 4px;
}

.etn-shadow-root {
  border-left: 2px dashed #7c3aed;
  padding-left: 8px;
  margin-bottom: 2px;
}

.etn-shadow-label {
  color: #c586c0;
  font-size: 10px;
  padding: 2px 0;
}

/** DOM 变化高亮闪烁 */
@keyframes flash {
  0% { background: rgba(255, 213, 79, 0.5); }
  100% { background: transparent; }
}

.etn-flash {
  animation: flash 1.5s ease-out;
}
</style>
