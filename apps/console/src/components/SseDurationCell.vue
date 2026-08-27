<script setup lang="ts">
/**
 * SSE/流式请求的动态耗时单元格（NetworkPanel 列表行专用）
 *
 * 只有 sseState=open 的行需要每秒刷新耗时；把它抽成独立组件后，
 * 每秒 tick 只命中打开中的那几行的单元格子树，而不是整张表格。
 * 非 open 行（绝大多数）退化为静态值渲染、零开销。
 */
import { ref, computed, onUnmounted } from "vue";
import type { NetworkEntry } from "@silkpulse/shared";

const props = defineProps<{
  /** 网络请求条目 */
  entry: NetworkEntry;
}>();

/** 父组件传来的最终显示值（ms）；open 流式行自行驱动刷新 */
const value = defineModel<number>("durationMs");

/** 本组件自己的节拍：只在 mounted 时启动 */
const tick = ref(0);
const timer = setInterval(() => {
  tick.value++;
}, 1000);
onUnmounted(() => clearInterval(timer));

/** 是否是「仍在进行中」的流式连接（需要动态时长） */
const isLive = computed(() => props.entry.sseState === "open");
</script>

<template>
  <span :title="isLive ? `流式连接已持续 ${(value ?? 0) / 1000}s` : undefined"
    >{{ value ?? 0 }}ms</span
  >
</template>
