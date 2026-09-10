<script setup lang="ts">
/**
 * OklchPanel —— OKLCH 色彩空间调整面板（颜色选择器的 OKLCH 页）
 *
 * L/C/H 滑杆，轨道用 `in oklch` 插值着色（等 L 滑动感知亮度不变）；v-model 为 { r,g,b,a }
 *
 * 色域语义：本地保存未裁剪的 raw OKLCH（可超出 sRGB 进入 P3/out 区），RGB 数据源 = 裁剪后的近似显示值；
 * 滑杆不在边界被"弹回来"，能真正调到广色域并得到 color(display-p3 ...) 输出
 */
import { computed, ref, watch } from "vue";
import {
  rgbToOklch,
  oklchToRgb,
  oklchGamut,
  oklchToP3Css,
  clamp,
  type Gamut,
  type Oklch,
  type Rgb,
} from "../../../utils/color";

/** 当前颜色（裁剪后的 RGB，单一数据源） */
const rgb = defineModel<Rgb>({ required: true });

/** 本地未裁剪 OKLCH：外部改色时从 rgb 重建，面板内滑杆时直接写 raw */
const raw = ref<Oklch>(rgbToOklch(rgb.value));

/** true = raw 刚被本面板写入，外部 rgb 同步时跳过回读（保留未裁剪值） */
let fromLocal = false;
watch(
  rgb,
  (c) => {
    if (fromLocal) {
      fromLocal = false;
      return;
    }
    raw.value = rgbToOklch(c);
  },
  { flush: "sync" },
);

/** 当前颜色的 OKLCH 表示 */
const oklchValue = computed(() => raw.value);

/** 面板内改动：写 raw，再把裁剪近似值回写 rgb 数据源 */
function applyLocal(next: Oklch) {
  raw.value = next;
  fromLocal = true;
  rgb.value = oklchToRgb(next);
}

/** L 百分数（0-100 整数，轨道着色与展示共用） */
const lPct = computed(() => Math.round(oklchValue.value.l * 100));

/** L 滑杆改动 */
function onL(e: Event) {
  applyLocal({
    l: Number((e.target as HTMLInputElement).value),
    c: raw.value.c,
    h: raw.value.h,
    a: rgb.value.a,
  });
}
/** C 滑杆改动 */
function onC(e: Event) {
  applyLocal({
    l: raw.value.l,
    c: Number((e.target as HTMLInputElement).value),
    h: raw.value.h,
    a: rgb.value.a,
  });
}
/** H 滑杆改动 */
function onH(e: Event) {
  applyLocal({
    l: raw.value.l,
    c: raw.value.c,
    h: Number((e.target as HTMLInputElement).value),
    a: rgb.value.a,
  });
}

/* ════════ 色域可视化 ════════ */

/** 当前颜色的色域：srgb / p3（超出 sRGB 但 P3 可表示）/ out（连 P3 都装不下） */
const gamut = computed(() => oklchGamut(oklchValue.value));

/** 超出 sRGB 时的 display-p3 CSS 输出 */
const p3Css = computed(() =>
  gamut.value !== "srgb" ? oklchToP3Css({ ...oklchValue.value, a: rgb.value.a }) : "",
);

/**
 * 当前 L/H 下扫描 C 轴的色域边界（二分法找 oklchGamut 突变点）
 *
 * 返回 sRGB 边界和 P3 边界在 0-0.4 色度轴上的位置，用于可视化条分段着色
 */
const cBounds = computed(() => {
  const { l, h } = oklchValue.value;
  /** 二分找从 c0 起向右首个改变色域判定的色度；找不到返回 0.4 */
  function findBoundary(from: Gamut, cStart: number): number {
    let lo = cStart,
      hi = 0.4;
    if (oklchGamut({ l, c: hi, h }) === from) return 0.4;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (oklchGamut({ l, c: mid, h }) === from) lo = mid;
      else hi = mid;
    }
    return hi;
  }
  const srgbEnd = oklchGamut({ l, c: 0, h }) === "srgb" ? findBoundary("srgb", 0) : 0;
  const p3End =
    oklchGamut({ l, c: Math.min(srgbEnd + 0.001, 0.4), h }) === "p3"
      ? findBoundary("p3", Math.min(srgbEnd + 0.001, 0.4))
      : srgbEnd;
  return {
    /** sRGB 段终点（0-1 占比） */
    srgbPct: (srgbEnd / 0.4) * 100,
    /** P3 段终点（0-1 占比） */
    p3Pct: (p3End / 0.4) * 100,
  };
});

/** 色域可视化条的分段渐变（灰 = sRGB 内可显示，蓝 = 仅 P3，红 = 两都装不下） */
const gamutBarStyle = computed(
  () =>
    `linear-gradient(to right, #9ca3af 0%, #9ca3af ${cBounds.value.srgbPct}%, #3b82f6 ${cBounds.value.srgbPct}%, #3b82f6 ${cBounds.value.p3Pct}%, #ef4444 ${cBounds.value.p3Pct}%, #ef4444 100%)`,
);

/** 当前 C 指针在可视化条上的位置（0-1 占比） */
const cPointerPct = computed(() => (oklchValue.value.c / 0.4) * 100);

/** 点击可视化条设定 C */
function onGamutBarClick(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const c = clamp((e.offsetX / el.offsetWidth) * 0.4, 0, 0.4);
  applyLocal({ l: raw.value.l, c, h: raw.value.h, a: rgb.value.a });
}

/** 色域标签文案 */
const gamutLabel = computed(
  () => ({ srgb: "sRGB 内", p3: "P3 广色域", out: "超出 P3" })[gamut.value],
);

/** 在色相环上按下/拖动：把指针角度换算为 OKLCH 色相（0° 在正上方，顺时针），写 raw 不受 sRGB 裁剪 */
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
  applyLocal({ l: raw.value.l, c: raw.value.c, h: hueFromEvent(e), a: rgb.value.a });
  const onMove = (ev: MouseEvent) => {
    applyLocal({ l: raw.value.l, c: raw.value.c, h: hueFromEvent(ev), a: rgb.value.a });
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** 色相环 conic-gradient 背景（0° 正上方顺时针；环色用 oklch 自身语法，固定当前 L/C 转动 H，直观反映当前亮度/色度下的色相分布） */
const wheelBg = computed(
  () =>
    `conic-gradient(from 0deg, oklch(${lPct.value}% ${oklchValue.value.c} 0), oklch(${lPct.value}% ${oklchValue.value.c} 60), oklch(${lPct.value}% ${oklchValue.value.c} 120), oklch(${lPct.value}% ${oklchValue.value.c} 180), oklch(${lPct.value}% ${oklchValue.value.c} 240), oklch(${lPct.value}% ${oklchValue.value.c} 300), oklch(${lPct.value}% ${oklchValue.value.c} 360))`,
);

/** 当前色相指针在色相环上的位置（圆心 50%，半径 40%） */
const wheelPointerStyle = computed(() => {
  const rad = ((oklchValue.value.h - 90) * Math.PI) / 180;
  const x = 50 + 40 * Math.cos(rad);
  const y = 50 + 40 * Math.sin(rad);
  return {
    left: `${x}%`,
    top: `${y}%`,
    background: `oklch(${lPct.value}% ${oklchValue.value.c} ${oklchValue.value.h})`,
  };
});
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex items-baseline justify-between">
      <span class="text-xs font-medium text-primary"
        >OKLCH <span class="text-faint">L 亮度 · C 鲜艳度 · H 色相</span></span
      >
      <span class="text-[10px] text-faint font-mono"
        >{{ lPct }}% {{ oklchValue.c.toFixed(3) }} {{ oklchValue.h }}</span
      >
    </div>
    <div class="flex items-center gap-2">
      <!-- 色相环：H 同样是角度，但环色用 oklch 生成（同 L/C 下转动 H），与 HSL 环观感不同 -->
      <div
        class="relative w-14 h-14 rounded-full flex-shrink-0 cursor-crosshair wheel"
        :style="{ background: wheelBg }"
        title="OKLCH 色相环：H 也是 0-360° 角度，但角度定义与 HSL 不同（如 OKLCH 30° ≈ HSL 25° 附近）；环色固定当前 L/C，反映真实亮度下的色相分布"
        @mousedown="onWheelPointerDown"
      >
        <div class="absolute inset-[9px] rounded-full bg-surface pointer-events-none"></div>
        <span
          class="absolute w-3 h-3 rounded-full border-2 border-white shadow-[0_0_3px_rgba(0,0,0,0.6)] pointer-events-none -translate-x-1/2 -translate-y-1/2"
          :style="wheelPointerStyle"
        ></span>
      </div>
      <div class="flex flex-col gap-1.5 flex-1 min-w-0">
        <label class="text-[10px] text-muted flex items-center gap-1.5">
          L
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            class="slider flex-1"
            :style="{
              '--track': `linear-gradient(to right in oklch, oklch(0% ${oklchValue.c} ${oklchValue.h}), oklch(100% ${oklchValue.c} ${oklchValue.h}))`,
            }"
            :value="oklchValue.l"
            @input="onL"
          />
          <span class="w-7 text-right font-mono">{{ lPct }}</span>
        </label>
        <label class="text-[10px] text-muted flex items-center gap-1.5">
          C
          <input
            type="range"
            min="0"
            max="0.4"
            step="0.005"
            class="slider flex-1"
            :style="{
              '--track': `linear-gradient(to right in oklch, oklch(${lPct}% 0 ${oklchValue.h}), oklch(${lPct}% 0.4 ${oklchValue.h}))`,
            }"
            :value="oklchValue.c"
            @input="onC"
          />
          <span class="w-9 text-right font-mono">{{ oklchValue.c.toFixed(3) }}</span>
        </label>
        <label class="text-[10px] text-muted flex items-center gap-1.5">
          H
          <input
            type="range"
            min="0"
            max="360"
            class="slider flex-1"
            :style="{
              '--track': `linear-gradient(to right in oklch, oklch(${lPct}% ${oklchValue.c} 0), oklch(${lPct}% ${oklchValue.c} 60), oklch(${lPct}% ${oklchValue.c} 120), oklch(${lPct}% ${oklchValue.c} 180), oklch(${lPct}% ${oklchValue.c} 240), oklch(${lPct}% ${oklchValue.c} 300), oklch(${lPct}% ${oklchValue.c} 360))`,
            }"
            :value="oklchValue.h"
            @input="onH"
          />
          <span class="w-7 text-right font-mono">{{ oklchValue.h }}</span>
        </label>
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

        <!-- 色域可视化：当前 L/H 下扫描 C 轴，灰 = sRGB 内 / 蓝 = 仅 P3 / 红 = 两都装不下 -->
        <div class="flex flex-col gap-0.5 pt-1 border-t border-base">
          <div class="flex items-baseline justify-between">
            <span class="text-[10px] font-medium text-primary"
              >色域（C 轴扫描 @ L={{ lPct }}% H={{ oklchValue.h }}°）</span
            >
            <span
              class="text-[10px] font-mono"
              :class="
                gamut === 'srgb' ? 'text-muted' : gamut === 'p3' ? 'text-blue-500' : 'text-red-500'
              "
              >{{ gamutLabel }}</span
            >
          </div>
          <div
            class="relative h-4 rounded cursor-pointer gamut-bar"
            :style="{ background: gamutBarStyle }"
            title="点击设定色度 C；灰色段 sRGB 可显示，蓝色段仅 P3 屏更艳，红色段两边都装不下"
            @click="onGamutBarClick"
          >
            <span
              class="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_2px_rgba(0,0,0,0.8)] pointer-events-none"
              :style="{ left: `calc(${cPointerPct}% - 1px)` }"
            ></span>
          </div>
          <div class="flex justify-between text-[9px] text-faint">
            <span>0 灰</span><span class="text-muted">sRGB 边界</span
            ><span class="text-blue-500">P3 边界</span><span>0.4</span>
          </div>
          <!-- 固定占位：始终渲染，避免出现/消失时页面高度抖动 -->
          <div class="flex items-center gap-1 min-h-[15px]">
            <code v-if="p3Css" class="text-[10px] font-mono text-blue-500 truncate flex-1">{{
              p3Css
            }}</code>
          </div>
        </div>
      </div>
    </div>
    <p class="text-[10px] text-faint">
      等 L 滑动时 perceived 亮度不变，适合做设计系统色阶；色相环转动 H，环色固定当前 L/C
    </p>
  </div>
</template>

<style scoped>
/** 色相环外圈光晕，与 HslPanel 一致 */
.wheel {
  box-shadow:
    0 0 0 1px rgb(0 0 0 / 0.1),
    inset 0 0 4px rgb(0 0 0 / 0.2);
}

/** 色域条背景尺寸固定，防止渐变段随宽度抖动 */
.gamut-bar {
  background-size: 100% 100%;
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
