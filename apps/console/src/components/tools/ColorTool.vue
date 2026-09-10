<script setup lang="ts">
/**
 * ColorTool —— 颜色调试器（ToolsPanel 的颜色页签）
 *
 * 面向前端开发者的可视化颜色工具：
 * - 万能解析：HEX / RGB(A) / HSL / OKLCH / 常见 CSS 颜色名互相识别
 * - 五种格式同屏展示（HEX/RGB/HSL/OKLCH/named 近似），一键复制
 * - 每种色彩空间专属滑杆（RGB 三通道 / HSL 色相-饱和-亮 / OKLCH 亮度-色度-色相）
 * - 亮度梯度条（同色相 10 阶明度）、Alpha 透明度对比（浅/深底）
 * - 双色渐变生成器（三色彩空间插值对比，方向可选 + 生成 CSS 代码可复制）
 */
import { ref, computed, watch, type CSSProperties } from "vue";
import { useCopyFlash } from "../../composables/useCopyFlash";
import RgbPanel from "./color/RgbPanel.vue";
import HslPanel from "./color/HslPanel.vue";
import OklchPanel from "./color/OklchPanel.vue";
import ColorInput from "./color/ColorInput.vue";
import {
  rgbToHsl,
  hslToRgb,
  rgbToOklch,
  oklchToRgb,
  rgbToHex,
  parseColor,
  clamp,
  type Rgb,
} from "../../utils/color";

/** 复制反馈 */
const { copiedKey, copy: copyWithFlash } = useCopyFlash();

/* ════════ 核心状态：单一数据源为 RGB，各格式滑杆派生 ════════ */

const rgb = ref<Rgb>({ r: 79, g: 70, b: 229, a: 1 });

/** 各格式字符串（computed 生成，供展示/复制） */
const hexStr = computed(() => rgbToHex(rgb.value));
const rgbStr = computed(() =>
  rgb.value.a < 1
    ? `rgba(${rgb.value.r}, ${rgb.value.g}, ${rgb.value.b}, ${rgb.value.a.toFixed(2)})`
    : `rgb(${rgb.value.r}, ${rgb.value.g}, ${rgb.value.b})`,
);
const hslValue = computed(() => rgbToHsl(rgb.value));
const hslStr = computed(() =>
  rgb.value.a < 1
    ? `hsla(${hslValue.value.h}, ${hslValue.value.s}%, ${hslValue.value.l}%, ${rgb.value.a.toFixed(2)})`
    : `hsl(${hslValue.value.h}, ${hslValue.value.s}%, ${hslValue.value.l}%)`,
);
const oklchValue = computed(() => rgbToOklch(rgb.value));
const oklchStr = computed(() => {
  const lPct = Math.round(oklchValue.value.l * 100);
  const c3 = oklchValue.value.c.toFixed(3);
  const base = `oklch(${lPct}% ${c3} ${oklchValue.value.h})`;
  return rgb.value.a < 1 ? base.replace(")", ` / ${rgb.value.a.toFixed(2)})`) : base;
});

/** 展示用的格式列表（label + 字符串 + 格式说明 tooltip） */
const formats = computed(() => [
  {
    key: "hex",
    label: "HEX",
    value: hexStr.value,
    info: "十六进制记法 #RRGGBB，可带两位透明度 #RRGGBBAA；紧凑通用，设计稿/切图最常见",
  },
  {
    key: "rgb",
    label: "RGB",
    value: rgbStr.value,
    info: "sRGB 三通道红/绿/蓝各 0-255（设备显示的原始坐标），可带 alpha；屏幕发光直接对应它",
  },
  {
    key: "hsl",
    label: "HSL",
    value: hslStr.value,
    info: "色相 Hue 0-360°角度 / 饱和度 Saturation % / 亮度 Lightness %；符合直觉但感知不均匀，调出等亮色阶需换 OKLCH",
  },
  {
    key: "oklch",
    label: "OKLCH",
    value: oklchStr.value,
    info: "感知均匀：L 亮度 % / C 色度（鲜艳度，无上限）/ H 色相角度；CSS Color 4 标准，同 L 滑动亮度真的不变",
  },
]);

/* ════════ 万能输入解析 ════════ */

const colorInput = ref("#4f46e5");
const parseError = ref("");

watch(colorInput, (v) => {
  const parsed = parseColor(v);
  if (parsed) {
    rgb.value = parsed;
    parseError.value = "";
  } else {
    parseError.value = "无法识别的颜色格式，支持 HEX / rgb() / hsl() / oklch() / CSS 颜色名";
  }
});

/** 滑杆改动时同步万能输入框，保持一致 */
watch(rgb, (v) => {
  const hex = rgbToHex(v);
  if (colorInput.value.toLowerCase() !== hex) colorInput.value = hex;
});

/* ════════ 亮度梯度（同色相 10 阶） ════════ */

/** 同色相、饱和度下从暗到亮 10 阶的 css 色值列表 */
const lightnessScale = computed(() => {
  const { h, s } = hslValue.value;
  const steps: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const l = i * 10;
    steps.push(rgbToHex(hslToRgb({ h, s, l, a: 1 })));
  }
  return steps;
});

/** 当前亮度在 10 阶中的高亮下标（0-based） */
const currentLIndex = computed(() => clamp(Math.floor(hslValue.value.l / 10) - 1, 0, 9));

/** 当前颜色 alpha 0→1 横向渐变层（叠加在衬底上） */
const alphaLayer = computed(
  () => `linear-gradient(to right, ${rgbStrWithAlpha(0)}, ${rgbStrWithAlpha(1)})`,
);

/** 带 alpha 的 rgb 颜色字符串 */
function rgbStrWithAlpha(a: number): string {
  return `rgba(${rgb.value.r}, ${rgb.value.g}, ${rgb.value.b}, ${a})`;
}

/** 三种衬底：浅色 / 深色 / 棋盘格 */
const alphaBgs = [
  { label: "浅底", under: "#ffffff", checker: false },
  { label: "深底", under: "#1a1a2e", checker: false },
  { label: "棋盘格", under: "", checker: true },
];

/* ════════ 双色渐变生成器 ════════ */

/** 渐变起始色输入 */
const gradAInput = ref("#4f46e5");
/** 渐变结束色输入 */
const gradBInput = ref("#f59e0b");
/** 起始色解析结果 */
const gradA = ref<Rgb | null>(parseColor("#4f46e5"));
/** 结束色解析结果 */
const gradB = ref<Rgb | null>(parseColor("#f59e0b"));
/** 渐变解析错误（A 或 B） */
const gradError = ref("");

watch(gradAInput, (v) => {
  gradA.value = parseColor(v);
  updateGradError();
});
watch(gradBInput, (v) => {
  gradB.value = parseColor(v);
  updateGradError();
});

/** 任一端解析失败时给出错误提示 */
function updateGradError() {
  if (!gradA.value && gradAInput.value.trim())
    gradError.value = `起始色「${gradAInput.value}」无法解析`;
  else if (!gradB.value && gradBInput.value.trim())
    gradError.value = `结束色「${gradBInput.value}」无法解析`;
  else gradError.value = "";
}

/** 渐变方向选项 */
const gradDirs = [
  { id: "to right", label: "→" },
  { id: "to left", label: "←" },
  { id: "to bottom", label: "↓" },
  { id: "to top", label: "↑" },
  { id: "to bottom right", label: "↘" },
] as const;
const gradDir = ref<string>("to right");

/**
 * 各色彩空间插值的渐变对比：同一对端点色，不同插值空间中间过渡完全不同
 * （sRGB 容易发灰发脏；HSL 色相路径经过彩虹区；OKLCH 感知均匀最顺滑）
 */
const gradSpaces = computed(() => {
  if (!gradA.value || !gradB.value) return [];
  const a = gradA.value;
  const b = gradB.value;
  /** 生成某插值空间的 css：直接让浏览器插值（in srgb 为默认） */
  const css = (interp: string) =>
    `linear-gradient(${gradDir.value}${interp ? ` in ${interp}` : ""}, ${
      gradAInput.value.trim() || rgbToHex(a)
    }, ${gradBInput.value.trim() || rgbToHex(b)})`;
  return [
    {
      key: "srgb",
      label: "sRGB",
      desc: "默认插值，中段易发灰发脏",
      css: css(""),
      /** 取中点色回填到万能输入用 */
      mid: () => {
        const mid: Rgb = {
          r: Math.round((a.r + b.r) / 2),
          g: Math.round((a.g + b.g) / 2),
          b: Math.round((a.b + b.b) / 2),
          a: 1,
        };
        return rgbToHex(mid);
      },
    },
    {
      key: "hsl",
      label: "HSL",
      desc: "沿色相环过渡，跨色相时会扫过彩虹区",
      css: css("hsl"),
      mid: () =>
        rgbToHex(
          hslToRgb({
            ...midAngle(rgbToHsl(a).h, rgbToHsl(b).h),
            s: (rgbToHsl(a).s + rgbToHsl(b).s) / 2,
            l: (rgbToHsl(a).l + rgbToHsl(b).l) / 2,
            a: 1,
          }),
        ),
    },
    {
      key: "oklch",
      label: "OKLCH",
      desc: "感知均匀，过渡最顺滑（P3 色域可能被 sRGB 屏裁剪）",
      css: css("oklch"),
      mid: () =>
        rgbToHex(
          oklchToRgb({
            ...midAngle(rgbToOklch(a).h, rgbToOklch(b).h),
            c: (rgbToOklch(a).c + rgbToOklch(b).c) / 2,
            l: (rgbToOklch(a).l + rgbToOklch(b).l) / 2,
            a: 1,
          }),
        ),
    },
  ];
});

/** 色相取中点（走最短弧） */
function midAngle(h1: number, h2: number): { h: number } {
  let d = ((h2 - h1 + 540) % 360) - 180;
  return { h: (h1 + d / 2 + 360) % 360 };
}

/** 点击某条渐变把它的中点色反填到万能输入 */
function pickGradMid(space: (typeof gradSpaces.value)[number]) {
  colorInput.value = space.mid();
}

/* ════════ CSS 效果实验室 ════════ */

/** 当前色的 hex（无 alpha） */
const curHex = computed(() => rgbToHex(rgb.value));

/** 毛玻璃演示卡的背景 alpha */
const glassAlpha = ref(0.35);
/** 毛玻璃模糊半径 px */
const glassBlur = ref(12);

/** 毛玻璃卡片样式 */
const glassStyle = computed(() => ({
  background: `rgba(${rgb.value.r}, ${rgb.value.g}, ${rgb.value.b}, ${glassAlpha.value})`,
  backdropFilter: `blur(${glassBlur.value}px)`,
  WebkitBackdropFilter: `blur(${glassBlur.value}px)`,
}));

/** 毛玻璃 CSS 代码 */
const glassCss = computed(
  () =>
    `background: rgba(${rgb.value.r}, ${rgb.value.g}, ${rgb.value.b}, ${glassAlpha.value});\nbackdrop-filter: blur(${glassBlur.value}px);`,
);

/** 三级彩色阴影（浅/中/重） */
const shadowLevels = computed(() => [
  {
    label: "subtle",
    css: `box-shadow: 0 1px 3px ${hexA(0.2)};`,
    style: { boxShadow: `0 1px 3px ${hexA(0.2)}` },
  },
  {
    label: "md",
    css: `box-shadow: 0 4px 12px ${hexA(0.35)};`,
    style: { boxShadow: `0 4px 12px ${hexA(0.35)}` },
  },
  {
    label: "lg",
    css: `box-shadow: 0 12px 32px ${hexA(0.5)};`,
    style: { boxShadow: `0 12px 32px ${hexA(0.5)}` },
  },
]);

/** 带两位 alpha 的 hex */
function hexA(a: number): string {
  const h = rgbToHex(rgb.value).slice(1);
  const al = Math.round(a * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${h}${al}`;
}

/** 混合模式演示：当前色叠加在花底渐变上 */
const blendModes = [
  { label: "multiply 正片叠底（做深色变体）", mode: "multiply" },
  { label: "screen 滤色（做浅色变体）", mode: "screen" },
  { label: "overlay 叠加（保对比提饱和）", mode: "overlay" },
];

/** color-mix 状态色阶（前端最常用的派生色） */
const mixVariants = computed(() => [
  { label: "hover（混白 15%）", css: `color-mix(in oklch, ${curHex.value}, white 15%)` },
  { label: "active（混黑 15%）", css: `color-mix(in oklch, ${curHex.value}, black 15%)` },
  { label: "border（混透明 60%）", css: `color-mix(in oklab, ${curHex.value}, transparent 60%)` },
  { label: "bg-surface（混白 90%）", css: `color-mix(in oklch, ${curHex.value}, white 90%)` },
]);

/** 文字对比度预览：当前色做底 */
const contrastFg = computed(() => {
  /** 相对亮度（WCAG） */
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(rgb.value.r) + 0.7152 * lin(rgb.value.g) + 0.0722 * lin(rgb.value.b);
  return {
    L,
    white: (1.05 / (L + 0.05)).toFixed(2),
    black: ((L + 0.05) / 0.05).toFixed(2),
  };
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 万能输入 + 当前颜色大预览 -->
    <div class="flex gap-3 items-start">
      <div class="flex flex-col gap-1 flex-1 min-w-0">
        <label class="text-xs text-muted">颜色输入（HEX / rgb() / hsl() / oklch() / 颜色名）</label>
        <ColorInput v-model="colorInput" class="w-full" />
        <p v-if="parseError" class="text-xs text-red-500">⚠ {{ parseError }}</p>
      </div>
      <!-- 大色块（棋盘格衬底展示透明度） -->
      <div
        class="w-20 h-[62px] rounded border border-base flex-shrink-0 checker"
        :style="{ background: rgbStr }"
        title="当前颜色"
      ></div>
    </div>

    <!-- 多格式展示 + 复制 -->
    <div class="grid grid-cols-2 gap-2">
      <div
        v-for="f in formats"
        :key="f.key"
        class="flex items-center gap-2 border border-base rounded px-2 py-1.5"
      >
        <span class="text-[10px] text-faint w-12 flex-shrink-0">{{ f.label }}</span>
        <span
          class="relative group flex-shrink-0 cursor-help text-[10px] text-faint hover:text-primary"
          :title="f.info"
          >ⓘ</span
        >
        <code class="text-xs font-mono text-primary truncate flex-1">{{ f.value }}</code>
        <button
          @click="copyWithFlash('color:' + f.key, f.value)"
          class="text-xs px-1.5 py-0.5 border-l border-base flex-shrink-0 copy-btn"
          :class="
            copiedKey === 'color:' + f.key ? 'text-green-500' : 'text-muted hover:text-primary'
          "
        >
          {{ copiedKey === "color:" + f.key ? "✓" : "📋" }}
        </button>
      </div>
    </div>

    <!-- 三种色彩空间调整面板（独立组件，颜色选择器复用同一套） -->
    <div class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
      <div class="border border-base rounded p-2.5"><RgbPanel v-model="rgb" /></div>
      <div class="border border-base rounded p-2.5"><HslPanel v-model="rgb" /></div>
      <div class="border border-base rounded p-2.5 md:col-span-2 xl:col-span-1">
        <OklchPanel v-model="rgb" />
      </div>
    </div>

    <!-- Alpha 深浅底对比：每底展示 alpha 0→1 横向渐变 + 当前 alpha 位置指针 -->
    <div class="flex flex-col gap-1.5">
      <span class="text-xs font-medium text-primary"
        >透明度对比（alpha 0→1 从左到右，白线为当前 A={{ rgb.a.toFixed(2) }}，点击设定 alpha）</span
      >
      <div class="flex gap-2">
        <div
          v-for="bg in alphaBgs"
          :key="bg.label"
          class="flex-1 rounded border border-base overflow-hidden"
        >
          <div class="text-[10px] text-faint text-center py-0.5 bg-surface">{{ bg.label }}</div>
          <!-- 衬底层：纯色或棋盘格 -->
          <div
            class="relative h-10 cursor-pointer"
            :class="bg.checker ? 'checker' : ''"
            :style="bg.checker ? {} : { background: bg.under }"
            title="点击把 alpha 设为所点位置的值"
            @click="
              rgb.a =
                Math.round(
                  (($event as MouseEvent).offsetX / ($event.target as HTMLElement).offsetWidth) *
                    100,
                ) / 100
            "
          >
            <!-- 当前色 alpha 渐变层 -->
            <div class="absolute inset-0" :style="{ background: alphaLayer }"></div>
            <!-- 当前 alpha 指针 -->
            <span
              class="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_2px_rgba(0,0,0,0.8)] pointer-events-none"
              :style="{ left: `calc(${rgb.a * 100}% - 1px)` }"
            ></span>
          </div>
        </div>
      </div>
    </div>

    <!-- 亮度梯度条 -->
    <div class="flex flex-col gap-1.5">
      <span class="text-xs font-medium text-primary"
        >同色相明度色阶（H={{ hslValue.h }} S={{ hslValue.s }}%，点击取色）</span
      >
      <div class="flex rounded overflow-hidden border border-base h-10">
        <div
          v-for="(c, i) in lightnessScale"
          :key="c"
          class="flex-1 cursor-pointer relative hover:scale-y-110 transition-transform"
          :style="{ background: c }"
          :title="`${c}（L=${(i + 1) * 10}%）`"
          @click="colorInput = c"
        >
          <span
            v-if="i === currentLIndex"
            class="absolute inset-0 border-2 border-white ring-1 ring-black/40 pointer-events-none"
          ></span>
          <span
            class="absolute bottom-0 inset-x-0 text-center text-[9px] leading-3"
            :class="i < 5 ? 'text-white/90' : 'text-black/70'"
          >
            {{ (i + 1) * 10 }}
          </span>
        </div>
      </div>
    </div>

    <!-- 双色渐变生成器 -->
    <div class="flex flex-col gap-2 border border-base rounded p-3">
      <span class="text-xs font-medium text-primary">渐变生成器</span>
      <div class="flex gap-2 items-center flex-wrap">
        <ColorInput v-model="gradAInput" placeholder="起始色" />
        <ColorInput v-model="gradBInput" placeholder="结束色" />
        <div class="flex gap-0.5">
          <button
            v-for="d in gradDirs"
            :key="d.id"
            @click="gradDir = d.id"
            class="w-7 h-7 text-xs rounded border"
            :class="
              gradDir === d.id
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-base text-muted hover:text-primary'
            "
            :title="d.id"
          >
            {{ d.label }}
          </button>
        </div>
      </div>
      <p v-if="gradError" class="text-xs text-red-500">⚠ {{ gradError }}</p>
      <!-- 多色彩空间插值对比：同一对端点色在不同空间插值的过渡差异 -->
      <div v-if="gradA && gradB" class="flex flex-col gap-1.5">
        <div v-for="sp in gradSpaces" :key="sp.key" class="flex flex-col gap-0.5">
          <div class="flex items-baseline gap-2">
            <span class="text-xs font-medium text-primary">{{ sp.label }}</span>
            <span class="text-[10px] text-faint">{{ sp.desc }}</span>
          </div>
          <div
            class="h-10 rounded border border-base cursor-crosshair relative overflow-hidden"
            :style="{ background: sp.css }"
            :title="`点击取 ${sp.label} 插值的中点色`"
            @click="pickGradMid(sp)"
          >
            <span class="absolute inset-y-0 left-1/2 w-px bg-white/60"></span>
          </div>
          <div class="flex items-center gap-2">
            <code class="text-[10px] font-mono text-muted flex-1 truncate">{{ sp.css }}</code>
            <button
              @click="copyWithFlash('grad:' + sp.key, sp.css)"
              class="text-[10px] px-1.5 py-0.5 border-l border-base flex-shrink-0 copy-btn"
              :class="
                copiedKey === 'grad:' + sp.key ? 'text-green-500' : 'text-muted hover:text-primary'
              "
            >
              {{ copiedKey === "grad:" + sp.key ? "✓" : "📋" }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- CSS 效果实验室：当前颜色 × 常用 CSS 效果的组合预览 -->
    <div class="flex flex-col gap-3 border border-base rounded p-3">
      <span class="text-xs font-medium text-primary">CSS 效果实验室（当前颜色 × 常用效果）</span>

      <!-- 毛玻璃 + 彩色阴影 + 混合模式三列预览 -->
      <div class="grid md:grid-cols-3 gap-3">
        <!-- 毛玻璃卡片 -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between">
            <span class="text-xs font-medium">毛玻璃 backdrop-filter</span>
            <button
              @click="copyWithFlash('fx:glass', glassCss)"
              class="text-[10px] px-1.5 py-0.5 border-l border-base copy-btn"
              :class="copiedKey === 'fx:glass' ? 'text-green-500' : 'text-muted hover:text-primary'"
            >
              {{ copiedKey === "fx:glass" ? "✓" : "📋" }}
            </button>
          </div>
          <!-- 花底图上放玻璃卡 -->
          <div
            class="h-24 rounded relative overflow-hidden"
            :style="{
              background:
                'linear-gradient(135deg, #f59e0b, #ec4899, #8b5cf6, #06b6d4), conic-gradient(#f43f5e, #facc15, #22c55e, #f43f5e)',
            }"
          >
            <div
              class="absolute inset-x-4 inset-y-3 rounded-lg border border-white/30 p-2 text-[10px] text-white leading-4"
              :style="glassStyle"
            >
              Glass card · 玻璃拟态<br />文字在模糊层上仍可读
            </div>
          </div>
          <label class="text-[10px] text-muted flex items-center gap-1.5">
            alpha
            <input
              type="range"
              min="0.05"
              max="0.9"
              step="0.05"
              class="slider flex-1"
              :value="glassAlpha"
              @input="glassAlpha = Number(($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="text-[10px] text-muted flex items-center gap-1.5">
            blur
            <input
              type="range"
              min="0"
              max="30"
              step="1"
              class="slider flex-1"
              :value="glassBlur"
              @input="glassBlur = Number(($event.target as HTMLInputElement).value)"
            />
          </label>
          <code class="text-[10px] font-mono text-muted whitespace-pre-wrap">{{ glassCss }}</code>
        </div>

        <!-- 彩色阴影 -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between">
            <span class="text-xs font-medium">彩色阴影 box-shadow</span>
            <span class="text-[10px] text-faint">比灰阴影更通透，Web 2.0 起流行</span>
          </div>
          <div class="flex flex-col gap-3 items-center py-2">
            <div
              v-for="lv in shadowLevels"
              :key="lv.label"
              class="flex flex-col items-center gap-0.5"
            >
              <div class="w-20 h-8 rounded-lg bg-surface" :style="lv.style" :title="lv.css"></div>
              <span class="text-[9px] text-faint">{{ lv.label }}</span>
            </div>
          </div>
          <code class="text-[10px] font-mono text-muted">{{ shadowLevels[1].css }}</code>
        </div>

        <!-- 混合模式 -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between">
            <span class="text-xs font-medium">混合模式 mix-blend-mode</span>
            <span class="text-[10px] text-faint">叠在花底上看混合结果</span>
          </div>
          <div
            class="h-24 rounded relative overflow-hidden"
            :style="{
              background: 'linear-gradient(135deg, #f59e0b, #ec4899, #8b5cf6, #06b6d4)',
            }"
          >
            <div
              v-for="(bm, i) in blendModes"
              :key="bm.mode"
              class="absolute h-1/3 w-full flex items-center px-2"
              :style="{
                top: `${(i * 100) / 3}%`,
                background: curHex,
                mixBlendMode: bm.mode as CSSProperties['mixBlendMode'],
              }"
            >
              <span class="text-[9px] text-white/90">{{ bm.label }}</span>
            </div>
          </div>
          <code class="text-[10px] font-mono text-muted"
            >background: {{ curHex }}; mix-blend-mode: multiply;</code
          >
        </div>
      </div>

      <!-- color-mix 状态色阶 + 文字对比度 -->
      <div class="grid md:grid-cols-3 gap-3 pt-1 border-t border-base">
        <div class="flex flex-col gap-1.5 md:col-span-2">
          <span class="text-xs font-medium">color-mix 派生状态色（设计系统常用）</span>
          <div class="grid grid-cols-4 gap-2">
            <div v-for="mv in mixVariants" :key="mv.label" class="flex flex-col gap-0.5">
              <div
                class="h-8 rounded border border-base cursor-pointer"
                :style="{ background: mv.css }"
                :title="`点击复制 ${mv.css}`"
                @click="copyWithFlash('mix:' + mv.label, mv.css)"
              ></div>
              <span class="text-[9px] text-faint">{{ mv.label }}</span>
            </div>
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-xs font-medium">文字对比度（当前色做底）</span>
          <div class="flex gap-2">
            <div
              class="flex-1 h-8 rounded flex items-center justify-center text-sm font-medium text-white"
              :style="{ background: curHex }"
              :title="`白字对比度 ${contrastFg.white}:1`"
            >
              Aa {{ contrastFg.white }}
            </div>
            <div
              class="flex-1 h-8 rounded flex items-center justify-center text-sm font-medium text-black"
              :style="{ background: curHex }"
              :title="`黑字对比度 ${contrastFg.black}:1`"
            >
              Aa {{ contrastFg.black }}
            </div>
          </div>
          <span class="text-[9px] text-faint">WCAG AA 正文 ≥ 4.5:1，大字 ≥ 3:1</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/** 复制按钮：无边框盒子，只有左侧竖线分隔，贴着色值像行内附件 */
.copy-btn {
  background: transparent;
  cursor: pointer;
  line-height: 1.2;
}

/** 透明度棋盘格衬底 */
.checker {
  background-image:
    linear-gradient(45deg, #ccc 25%, transparent 25%),
    linear-gradient(-45deg, #ccc 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #ccc 75%),
    linear-gradient(-45deg, transparent 75%, #ccc 75%);
  background-size: 12px 12px;
  background-position:
    0 0,
    0 6px,
    6px -6px,
    -6px 0;
  background-color: #fff;
}
/** 滑杆：轨道着色 + 圆点 */
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
