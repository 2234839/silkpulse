<script setup lang="ts">
/**
 * UndoToast —— 清空撤销提示条
 *
 * 固定在底部居中，展示 message + 撤销按钮，由 useUndoToast 驱动。
 */
import { useUndoToast } from "../../composables/useUndoToast";

/** 撤销状态（visible/toastMessage/undo/dismiss 由父组件透传） */
const props = defineProps<{
  /** toast 是否可见 */
  visible: boolean;
  /** toast 文案 */
  message: string;
}>();

const emit = defineEmits<{
  /** 点击撤销 */
  undo: [];
}>();
</script>

<template>
  <Transition
    enter-active-class="transition duration-200"
    enter-from-class="opacity-0 translate-y-2"
    leave-active-class="transition duration-150"
    leave-to-class="opacity-0 translate-y-2"
  >
    <div
      v-if="visible"
      class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-gray-900 text-white text-xs px-4 py-2 rounded-lg shadow-lg"
    >
      <span>{{ message }}</span>
      <button @click="emit('undo')" class="text-blue-400 hover:text-blue-300 font-medium">
        撤销
      </button>
    </div>
  </Transition>
</template>
