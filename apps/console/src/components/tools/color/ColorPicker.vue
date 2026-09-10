<script setup lang="ts">
/**
 * ColorPicker —— 颜色选择器（RGB / HSL / OKLCH 三个调整面板 + HEX/alpha 精调）
 *
 * 复用 RgbPanel/HslPanel/OklchPanel；v-model 为 { r,g,b,a }
 */
import { ref, computed } from "vue";
import RgbPanel from "./RgbPanel.vue";
import HslPanel from "./HslPanel.vue";
import OklchPanel from "./OklchPanel.vue";
import { rgbToHex, type Rgb } from "../../../utils/color";

/** 当前颜色 */
const rgb = defineModel<Rgb>({ required: true });

/** 空间页签 */
const tabs = [
  { id: "rgb", label: "RGB" },
  { id: "hsl", label: "HSL" },
  { id: "oklch", label: "OKLCH" },
] as const;
/** 当前激活的空间页签 */
const activeTab = ref<(typeof tabs)[number]["id"]>("rgb");

/** 当前颜色的 HEX（含 alpha） */
const hexStr = computed(() => rgbToHex(rgb.value));

/** 大色块背景（棋盘格衬底 + 实际颜色，透明度可见） */
const swatchStyle = computed(() => ({
  backgroundImage: `linear-gradient(${rgb.value.a < 1 ? "45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%), linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%)" : "none"}`,
  backgroundColor: rgbToHex({ ...rgb.value, a: 1 }),
  backgroundSize: "12px 12px",
  backgroundPosition: "0 0, 0 6px, 6px -6px, -6px 0",
}));
</script>

<template>
  <div class="flex flex-col gap-2">
    <!-- 当前色预览 + HEX 值 -->
    <div class="flex items-center gap-2">
      <div class="w-9 h-9 rounded border border-base flex-shrink-0" :style="swatchStyle"></div>
      <code class="text-xs font-mono text-primary flex-1">{{ hexStr }}</code>
    </div>
    <!-- 空间页签 -->
    <div class="flex gap-0.5">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="px-2 py-1 text-xs rounded border"
        :class="
          activeTab === t.id
            ? 'bg-blue-600 text-white border-blue-600'
            : 'border-base text-muted hover:text-primary'
        "
        @click="activeTab = t.id"
      >
        {{ t.label }}
      </button>
    </div>
    <!-- 三个色彩空间调整面板（即颜色选择器本体） -->
    <RgbPanel v-if="activeTab === 'rgb'" v-model="rgb" />
    <HslPanel v-else-if="activeTab === 'hsl'" v-model="rgb" />
    <OklchPanel v-else v-model="rgb" />
  </div>
</template>
