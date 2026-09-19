<script setup lang="ts" generic="T">
/**
 * VirtualList —— 轻量滚动窗口虚拟列表（无第三方依赖）
 *
 * 原理：容器固定高度滚动，内部撑一个 totalHeight 的空占位，
 * 只渲染可视区上下各带 overscan 缓冲的条目，绝对定位偏移到原位。
 * 条目行高统一 itemHeight（流事件等单行/固定行场景够用）。
 *
 * 插槽 #item({ item, index }) 渲染单条。
 */
import { ref, computed } from "vue";

/** 全量数据 */
const props = defineProps<{
  /** 全量数据 */
  items: T[];
  /** 单条固定行高 px */
  itemHeight: number;
  /** 容器高度 px（超出滚动） */
  height: number;
  /** 可视区上下额外渲染的缓冲条数 */
  overscan?: number;
}>();

const emit = defineEmits<{ scroll: [e: Event] }>();

/** 容器滚动位置 */
const scrollTop = ref(0);

/** 总高度占位（撑出滚动条） */
const totalHeight = computed(() => props.items.length * props.itemHeight);

/** 可视窗口内的首条下标（含 overscan） */
const startIndex = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / props.itemHeight) - (props.overscan ?? 5)),
);

/** 可视窗口末条下标（含 overscan） */
const endIndex = computed(() => {
  const visible = Math.ceil(props.height / props.itemHeight);
  return Math.min(props.items.length, startIndex.value + visible + (props.overscan ?? 5) * 2);
});

/** 窗口内条目 */
const windowItems = computed(() =>
  props.items.slice(startIndex.value, endIndex.value).map((item, i) => ({
    item,
    index: startIndex.value + i,
  })),
);

/** 窗口整体偏移（保持滚动位置视觉连续） */
const offsetY = computed(() => startIndex.value * props.itemHeight);

/**
 * 滚动事件：记录 scrollTop 触发窗口重算
 *
 * @param e 原生滚动事件
 */
function onScroll(e: Event) {
  scrollTop.value = (e.target as HTMLElement).scrollTop;
  emit("scroll", e);
}
</script>

<template>
  <div class="overflow-auto" :style="{ height: height + 'px' }" @scroll.passive="onScroll">
    <div :style="{ height: totalHeight + 'px', position: 'relative' }">
      <div :style="{ position: 'absolute', top: offsetY + 'px', left: 0, right: 0 }">
        <slot v-for="w in windowItems" :key="w.index" name="item" :item="w.item" :index="w.index" />
      </div>
    </div>
  </div>
</template>
