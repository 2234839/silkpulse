<script setup lang="ts">
/**
 * RgbPanel —— RGB 色彩空间调整面板（颜色选择器的 RGB 页）
 *
 * R/G/B/A 四通道滑杆，轨道按通道特性着色；v-model 为 { r,g,b,a }
 */
import { computed } from "vue";
import type { Rgb } from "../../../utils/color";

/** 当前颜色 */
const rgb = defineModel<Rgb>({ required: true });
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex items-baseline justify-between">
      <span class="text-xs font-medium text-primary">RGB</span>
      <span class="text-[10px] text-faint font-mono">{{ rgb.r }}, {{ rgb.g }}, {{ rgb.b }}</span>
    </div>
    <label class="text-[10px] text-muted flex items-center gap-1.5">
      R
      <input
        v-model.number="rgb.r"
        type="range"
        min="0"
        max="255"
        class="slider flex-1"
        :style="{ '--track': 'linear-gradient(to right, #000, rgb(255,0,0))' }"
      />
      <span class="w-7 text-right font-mono">{{ rgb.r }}</span>
    </label>
    <label class="text-[10px] text-muted flex items-center gap-1.5">
      G
      <input
        v-model.number="rgb.g"
        type="range"
        min="0"
        max="255"
        class="slider flex-1"
        :style="{ '--track': 'linear-gradient(to right, #000, rgb(0,255,0))' }"
      />
      <span class="w-7 text-right font-mono">{{ rgb.g }}</span>
    </label>
    <label class="text-[10px] text-muted flex items-center gap-1.5">
      B
      <input
        v-model.number="rgb.b"
        type="range"
        min="0"
        max="255"
        class="slider flex-1"
        :style="{ '--track': 'linear-gradient(to right, #000, rgb(0,0,255))' }"
      />
      <span class="w-7 text-right font-mono">{{ rgb.b }}</span>
    </label>
    <label class="text-[10px] text-muted flex items-center gap-1.5">
      A
      <input
        v-model.number="rgb.a"
        type="range"
        min="0"
        max="1"
        step="0.01"
        class="slider flex-1"
      />
      <span class="w-7 text-right font-mono">{{ rgb.a.toFixed(2) }}</span>
    </label>
  </div>
</template>

<style scoped>
/*
 * 滑杆样式与 ColorTool 的 .slider 保持一致；
 * 因 HslPanel/OklchPanel/ColorPicker 的弹层需同样式，公共类在此三处各自声明（scoped 隔离）
 */
.slider {
  appearance: none;
  height: 6px;
  border-radius: 3px;
  background: var(--track, #ccc);
  outline: none;
}
.slider::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #3b82f6;
  cursor: pointer;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
}
</style>
