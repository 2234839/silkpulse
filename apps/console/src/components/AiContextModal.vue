<script setup lang="ts">
/**
 * AI 诊断上下文弹窗
 *
 * 展示生成好的设备诊断上下文文本，支持一键复制。
 */
import { useAiContext } from "../composables/useAiContext";
import type { LogEntry, NetworkEntry, ErrorEntry } from "@silkpulse/shared";

const props = defineProps<{
  modelValue: boolean;
  deviceId: string;
  title: string;
  url: string;
  errors: ErrorEntry[];
  network: NetworkEntry[];
  logs: LogEntry[];
}>();

const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const {
  contextText,
  generating,
  copyState,
  generate: generateAiContext,
  copyToClipboard,
} = useAiContext();

/** 弹窗打开时自动生成 */
import { watch } from "vue";
watch(
  () => props.modelValue,
  async (v) => {
    if (v) {
      await generateAiContext({
        deviceId: props.deviceId,
        title: props.title,
        url: props.url,
        errors: props.errors,
        network: props.network,
        logs: props.logs,
      });
    }
  },
);
</script>

<template>
  <div
    v-if="modelValue"
    class="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
    @click.self="emit('update:modelValue', false)"
  >
    <div
      class="bg-surface rounded-lg shadow-xl w-full max-w-[720px] mx-4 max-h-[80vh] flex flex-col"
    >
      <div class="flex items-center justify-between px-5 py-3 border-b border-base">
        <h3 class="text-sm font-semibold text-primary">AI 诊断上下文</h3>
        <div class="flex items-center gap-2">
          <button
            @click="copyToClipboard"
            class="px-3 py-1 text-xs rounded font-medium"
            :class="
              copyState === 'copied'
                ? 'bg-green-100 text-green-700'
                : copyState === 'error'
                  ? 'bg-red-100 text-red-700'
                  : 'bg-elevated text-secondary bg-elevated-hover'
            "
          >
            {{
              copyState === "copied" ? "✓ 已复制" : copyState === "error" ? "复制失败" : "复制全部"
            }}
          </button>
          <button
            @click="emit('update:modelValue', false)"
            class="px-3 py-1 text-xs rounded bg-elevated text-secondary bg-elevated-hover"
          >
            关闭
          </button>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-5">
        <pre v-if="generating" class="text-sm text-faint">正在拉取设备快照...</pre>
        <pre v-else class="text-xs font-mono text-primary whitespace-pre-wrap">{{
          contextText
        }}</pre>
      </div>
    </div>
  </div>
</template>
