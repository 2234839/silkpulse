<script setup lang="ts">
/**
 * ColorInput —— 色值输入框：输入任意 CSS 颜色 + 点击色块弹出 ColorPicker
 *
 * v-model 为字符串（HEX/rgb()/hsl()/oklch()/颜色名）；解析成功时选择器同步，
 * 选择器调色时把 HEX 回写输入框
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import ColorPicker from "./ColorPicker.vue";
import { parseColor, rgbToHex, type Rgb } from "../../../utils/color";

/** 色值字符串 */
const model = defineModel<string>({ required: true });

/** 解析结果（无效则为 null） */
const parsed = computed(() => parseColor(model.value));

/** 选择器内部操作的颜色对象（与 parsed 双向同步） */
const pickerRgb = ref<Rgb>(parsed.value ?? { r: 0, g: 0, b: 0, a: 1 });

/** 输入框占位文本 */
const props = defineProps<{
  /** 输入框占位提示 */
  placeholder?: string;
}>();

/**
 * 同步方向标志：true = 变化源自输入框（保留用户书写格式，不回写 hex）；
 * false/未设置 = 变化源自选择器调色（回写 hex 到输入框）
 */
let fromInput = false;

// 输入框合法值 → 选择器（标记方向，用户手输的 hsl()/oklch() 格式得以保留）
watch(parsed, (p) => {
  if (p) {
    fromInput = true;
    pickerRgb.value = p;
    // flush: 'sync' 保证 pickerRgb watch 在本 tick 内同步消费掉标志
  }
});
// 选择器调色 → 回写 HEX 到输入框
watch(
  pickerRgb,
  (c) => {
    if (fromInput) {
      fromInput = false;
      return;
    }
    const hex = rgbToHex(c);
    if (model.value.trim().toLowerCase() !== hex) model.value = hex;
  },
  { flush: "sync" },
);

/** 色块按钮样式：alpha=1 纯色；alpha<1 用大格低对比棋盘格衬底透出透明感 */
const swatchStyle = computed(() => {
  const c = parsed.value;
  if (!c) return { backgroundColor: "#fff" };
  if (c.a >= 1) return { backgroundColor: rgbToHex(c) };
  return {
    backgroundColor: rgbToHex({ ...c, a: 1 }),
    backgroundImage:
      "linear-gradient(45deg, #d1d5db 25%, transparent 25%, transparent 75%, #d1d5db 75%), linear-gradient(45deg, #d1d5db 25%, transparent 25%, transparent 75%, #d1d5db 75%)",
    backgroundSize: "16px 16px",
    backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
  };
});

/** 弹层开关 */
const open = ref(false);
/** 组件根（点外面关弹层） */
const root = ref<HTMLElement | null>(null);

function onDocClick(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener("mousedown", onDocClick));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocClick));
</script>

<template>
  <div ref="root" class="relative flex-1 min-w-32">
    <div class="flex items-stretch">
      <input
        v-model="model"
        spellcheck="false"
        class="flex-1 min-w-0 bg-input border rounded-l p-1.5 text-xs font-mono text-primary focus:outline-none"
        :class="parsed ? 'border-base focus:border-blue-500' : 'border-red-500'"
        :placeholder="props.placeholder ?? '颜色'"
      />
      <!-- 色块按钮：点击弹出选择器。alpha=1 纯色；alpha<1 才透出大格棋盘格衬底 -->
      <button
        class="w-9 rounded-r border border-l-0 border-base flex-shrink-0"
        :style="swatchStyle"
        title="打开颜色选择器"
        @click="open = !open"
      ></button>
    </div>
    <!-- 弹出的颜色选择器 -->
    <div
      v-if="open"
      class="absolute z-50 top-full mt-1 right-0 w-64 p-2.5 bg-surface border border-base rounded shadow-lg"
    >
      <ColorPicker v-model="pickerRgb" />
    </div>
  </div>
</template>
