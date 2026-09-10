<script setup lang="ts">
/**
 * HslPanel —— HSL 色彩空间调整面板（颜色选择器的 HSL 页）
 *
 * H/S/L 滑杆，轨道动态着色（拖 H 感受色相环）；v-model 为 { r,g,b,a }，内部转 HSL
 */
import { computed } from "vue";
import { rgbToHsl, hslToRgb, type Rgb } from "../../../utils/color";

/** 当前颜色 */
const rgb = defineModel<Rgb>({ required: true });

/** 当前颜色的 HSL 表示 */
const hslValue = computed(() => rgbToHsl(rgb.value));

/** H 滑杆改动 → 回写 rgb */
function onH(e: Event) {
  rgb.value = hslToRgb({
    h: Number((e.target as HTMLInputElement).value),
    s: hslValue.value.s,
    l: hslValue.value.l,
    a: rgb.value.a,
  });
}
/** S 滑杆改动 → 回写 rgb */
function onS(e: Event) {
  rgb.value = hslToRgb({
    h: hslValue.value.h,
    s: Number((e.target as HTMLInputElement).value),
    l: hslValue.value.l,
    a: rgb.value.a,
  });
}
/** L 滑杆改动 → 回写 rgb */
function onL(e: Event) {
  rgb.value = hslToRgb({
    h: hslValue.value.h,
    s: hslValue.value.s,
    l: Number((e.target as HTMLInputElement).value),
    a: rgb.value.a,
  });
}

/** 在色相环上按下/拖动：把指针角度换算为色相（0° 在正上方，顺时针） */
function onWheelPointerDown(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  /** 把事件坐标换算为色相角度 */
  const hueFromEvent = (ev: MouseEvent) => {
    const angle = (Math.atan2(ev.clientX - cx, cy - ev.clientY) * 180) / Math.PI;
    return Math.round((angle + 360) % 360);
  };
  rgb.value = hslToRgb({
    h: hueFromEvent(e),
    s: hslValue.value.s,
    l: hslValue.value.l,
    a: rgb.value.a,
  });
  const onMove = (ev: MouseEvent) => {
    rgb.value = hslToRgb({
      h: hueFromEvent(ev),
      s: hslValue.value.s,
      l: hslValue.value.l,
      a: rgb.value.a,
    });
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** 色相环 conic-gradient 背景（0° 在正上方顺时针，与 CSS 角度约定一致） */
const WHEEL_BG =
  "conic-gradient(from 0deg, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))";

/** 当前色相指针在色相环上的位置（圆心为 50%，半径 40%） */
const pointerStyle = computed(() => {
  const rad = ((hslValue.value.h - 90) * Math.PI) / 180;
  const x = 50 + 40 * Math.cos(rad);
  const y = 50 + 40 * Math.sin(rad);
  return { left: `${x}%`, top: `${y}%`, background: `hsl(${hslValue.value.h}, 100%, 50%)` };
});
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex items-baseline justify-between">
      <span class="text-xs font-medium text-primary">HSL</span>
      <span class="text-[10px] text-faint font-mono"
        >{{ hslValue.h }}, {{ hslValue.s }}%, {{ hslValue.l }}%</span
      >
    </div>
    <div class="flex items-center gap-2">
      <!-- 色相环：圆形直观展示 H 是角度概念，可点击/拖动取色 -->
      <div
        class="relative w-14 h-14 rounded-full flex-shrink-0 cursor-crosshair wheel"
        :style="{ background: WHEEL_BG }"
        title="色相环：H 是 0-360° 的角度（0° 红、120° 绿、240° 蓝），点击或拖动选取"
        @mousedown="onWheelPointerDown"
      >
        <!-- 中心挖白洞成环状 + 当前色相指针 -->
        <div class="absolute inset-[9px] rounded-full bg-surface pointer-events-none"></div>
        <span
          class="absolute w-3 h-3 rounded-full border-2 border-white shadow-[0_0_3px_rgba(0,0,0,0.6)] pointer-events-none -translate-x-1/2 -translate-y-1/2"
          :style="pointerStyle"
        ></span>
      </div>
      <div class="flex flex-col gap-1.5 flex-1 min-w-0">
        <label class="text-[10px] text-muted flex items-center gap-1.5">
          H
          <input
            type="range"
            min="0"
            max="360"
            class="slider flex-1"
            :style="{
              '--track':
                'linear-gradient(to right, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))',
            }"
            :value="hslValue.h"
            @input="onH"
          />
          <span class="w-7 text-right font-mono">{{ hslValue.h }}</span>
        </label>
        <label class="text-[10px] text-muted flex items-center gap-1.5">
          S
          <input
            type="range"
            min="0"
            max="100"
            class="slider flex-1"
            :style="{
              '--track': `linear-gradient(to right, hsl(${hslValue.h},0%,${hslValue.l}%), hsl(${hslValue.h},100%,${hslValue.l}%))`,
            }"
            :value="hslValue.s"
            @input="onS"
          />
          <span class="w-7 text-right font-mono">{{ hslValue.s }}</span>
        </label>
        <label class="text-[10px] text-muted flex items-center gap-1.5">
          L
          <input
            type="range"
            min="0"
            max="100"
            class="slider flex-1"
            :style="{
              '--track': `linear-gradient(to right, #000, hsl(${hslValue.h},${hslValue.s}%,50%), #fff)`,
            }"
            :value="hslValue.l"
            @input="onL"
          />
          <span class="w-7 text-right font-mono">{{ hslValue.l }}</span>
        </label>
      </div>
    </div>
    <label class="text-[10px] text-muted flex items-center gap-1.5">
      A
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        class="slider flex-1"
        :value="rgb.a"
        @input="rgb.a = Number(($event.target as HTMLInputElement).value)"
      />
      <span class="w-7 text-right font-mono">{{ rgb.a.toFixed(2) }}</span>
    </label>
    <p class="text-[10px] text-faint">色相环直观展示 H 是角度；也可拖滑杆。L 明暗、S 鲜淡</p>
  </div>
</template>

<style scoped>
/** 色相环外圈光晕，让环形更立体 */
.wheel {
  box-shadow:
    0 0 0 1px rgb(0 0 0 / 0.1),
    inset 0 0 4px rgb(0 0 0 / 0.2);
}

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
