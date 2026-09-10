<script setup lang="ts">
/**
 * ToolSplitLayout —— 工具页统一左右分栏容器
 *
 * 左右分栏 + 中间拖拽手柄（拖拽改宽，localStorage 持久化）。
 * 各工具传独立 storageKey 即可记住各自的分栏比例。
 *
 * 插槽：#left 左栏、#right 右栏。
 */
import { useResizable } from "../../composables/useResizable";

/** 分栏配置 */
const props = defineProps<{
  /** localStorage 持久化 key（每个工具独立，记住各自分栏比例） */
  storageKey: string;
  /** 初始左栏宽度 px */
  initialWidth?: number;
  /** 左栏最小宽度 px */
  minWidth?: number;
  /** 左栏最大宽度 px */
  maxWidth?: number;
}>();

const { width: leftWidth, onDragStart } = useResizable({
  initial: props.initialWidth ?? 480,
  min: props.minWidth ?? 240,
  max: props.maxWidth ?? 720,
  direction: "right",
  storageKey: props.storageKey,
});
</script>

<template>
  <div class="flex gap-4 h-full max-h-[calc(100vh-160px)]">
    <div class="flex flex-col gap-2 min-w-0 flex-shrink-0" :style="{ width: leftWidth + 'px' }">
      <slot name="left" />
    </div>
    <!-- 拖拽手柄：悬停/激活加宽高亮，易于发现和抓取 -->
    <div
      class="group relative w-1.5 cursor-col-resize flex-shrink-0 -mx-1 z-10"
      title="拖拽调整分栏比例"
      @mousedown="onDragStart"
    >
      <!-- 命中热区比视觉条更宽，容易抓 -->
      <div class="absolute inset-y-0 -left-1 -right-1"></div>
      <div
        class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 rounded bg-base transition-all group-hover:w-1 group-hover:bg-blue-400/60 group-active:bg-blue-500"
      ></div>
    </div>
    <div class="flex-1 overflow-auto min-w-0">
      <slot name="right" />
    </div>
  </div>
</template>
