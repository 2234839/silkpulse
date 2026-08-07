<script setup lang="ts">
/**
 * ElementTreeNode —— DOM 树的递归节点组件（Chrome DevTools Elements 风格）
 *
 * XML 标签风格：<tag id="..." class="...">text</tag>
 * - 叶子节点（有 text 无子元素）单行展示：<p>文本内容</p>
 * - 收起容器：<div class="demo">…3</div>
 * - 展开容器：开始标签 > 子节点缩进 > 闭合标签 </div>
 * - shadow host 带 🕶️ 标记 + 紫色 shadow-root 区域
 */

interface ElementNode {
  idx: number
  tag: string
  id?: string
  classes?: string
  childCount: number
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

/** class 列表（拆分为数组） */
function classList(n: ElementNode): string[] {
  return n.classes ? n.classes.split(/\s+/).filter(Boolean) : []
}

/** HTML void 元素（自闭合，无结束标签） */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

/** 是否为 void 元素（如 <input>、<img>、<br>，不需要结束标签） */
function isVoidTag(tag: string): boolean {
  return VOID_TAGS.has(tag.toLowerCase())
}

/** 是否展开（普通 children 或 shadow） */
function isExpanded(n: ElementNode): boolean {
  return (n.childCount > 0 && n.expanded) || (!!n.hasShadow && n.shadowExpanded)
}

/** 是否有可展开内容 */
function hasExpandable(n: ElementNode): boolean {
  return n.childCount > 0 || !!n.hasShadow
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

      <!-- <tag -->
      <span class="etn-bracket">&lt;</span>
      <span class="etn-tag">{{ node.tag }}</span>
      <span v-if="node.id" class="etn-attr"><span class="etn-attr-name"> id</span><span class="etn-attr-val">="{{ node.id }}"</span></span>
      <span v-if="classList(node).length > 0" class="etn-attr"><span class="etn-attr-name"> class</span><span class="etn-attr-val">="{{ classList(node).join(' ') }}"</span></span>

      <!-- 收起状态：内联闭合 -->
      <template v-if="!isExpanded(node)">
        <!-- 叶子节点有文本：<tag>text</tag> 单行 -->
        <template v-if="node.text">
          <span class="etn-bracket">&gt;</span>
          <span class="etn-text-inline">{{ node.text }}</span>
          <span class="etn-bracket">&lt;/</span><span class="etn-tag">{{ node.tag }}</span><span class="etn-bracket">&gt;</span>
        </template>
        <!-- 有子元素但收起：<tag>…N</tag> -->
        <template v-else>
          <span v-if="node.childCount > 0" class="etn-child-hint"> …{{ node.childCount }} </span>
          <span v-if="node.shadowChildCount" class="etn-shadow-hint"> 🕶️{{ node.shadowChildCount }} </span>
          <span class="etn-bracket">&gt;</span>
          <span v-if="node.childCount > 0 || node.shadowChildCount" class="etn-bracket">…&lt;/</span>
          <span v-if="node.childCount > 0 || node.shadowChildCount" class="etn-tag">{{ node.tag }}</span>
          <span v-if="node.childCount > 0 || node.shadowChildCount" class="etn-bracket">&gt;</span>
          <!-- 无子元素：void 标签自闭合，其他标签空闭合 <script></script> -->
          <span v-if="!(node.childCount > 0 || node.shadowChildCount) && isVoidTag(node.tag)" class="etn-bracket"> /&gt;</span>
          <template v-if="!(node.childCount > 0 || node.shadowChildCount) && !isVoidTag(node.tag)">
            <span class="etn-bracket">&lt;/</span><span class="etn-tag">{{ node.tag }}</span><span class="etn-bracket">&gt;</span>
          </template>
        </template>
      </template>

      <!-- 展开状态：只闭合开始标签 > -->
      <template v-else>
        <span class="etn-bracket">&gt;</span>
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
      <span class="etn-bracket">&lt;/</span><span class="etn-tag">{{ node.tag }}</span><span class="etn-bracket">&gt;</span>
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

/** 尖括号 —— 灰色 */
.etn-bracket {
  color: #808080;
}

/** 标签名 —— 蓝色 */
.etn-tag {
  color: #569cd6;
}

/** 属性名 —— 浅蓝 */
.etn-attr-name {
  color: #9cdcfe;
}

/** 属性值 —— 橙色 */
.etn-attr-val {
  color: #ce9178;
}

/** 内联文本 —— 灰白，截断 */
.etn-text-inline {
  color: #ce9178;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.etn-child-hint {
  color: #6a9955;
  font-style: italic;
  font-size: 11px;
}

.etn-shadow-hint {
  color: #7c3aed;
}

.etn-children {
  border-left: 1px solid rgba(127, 127, 127, 0.15);
}

.etn-shadow-root {
  border-left: 2px dashed rgba(124, 58, 237, 0.3);
  padding-left: 4px;
  margin-bottom: 2px;
}

.etn-shadow-label {
  color: #7c3aed;
  font-size: 10px;
  padding: 1px 4px;
  opacity: 0.7;
}

.etn-close {
  opacity: 0.85;
}

/** DOM 变化高亮动画：黄色闪烁后渐隐 */
@keyframes etn-flash {
  0% { background-color: rgba(250, 204, 21, 0.6); }
  100% { background-color: transparent; }
}
.etn-flash {
  animation: etn-flash 1.5s ease-out;
}
</style>
