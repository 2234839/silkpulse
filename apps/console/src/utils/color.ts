/**
 * 颜色工具库 —— RGB / HSL / OKLCH 类型、互转纯函数、万能解析
 *
 * 从 ColorTool.vue 抽出，供 ColorTool 与颜色选择器组件（RgbPanel/HslPanel/OklchPanel/ColorPicker/ColorInput）共用
 */

/** RGB 分量 0-255 */
export interface Rgb {
  /** 红 0-255 */
  r: number;
  /** 绿 0-255 */
  g: number;
  /** 蓝 0-255 */
  b: number;
  /** 透明度 0-1 */
  a: number;
}

/** HSL：色相 0-360，饱和/亮度 0-100% */
export interface Hsl {
  /** 色相 0-360 */
  h: number;
  /** 饱和度 % */
  s: number;
  /** 亮度 % */
  l: number;
  /** 透明度 0-1 */
  a: number;
}

/** OKLCH：L 0-1，C 0-0.4，H 0-360 */
export interface Oklch {
  /** 亮度 0-1 */
  l: number;
  /** 色度 0-0.4 */
  c: number;
  /** 色相 0-360 */
  h: number;
  /** 透明度 0-1 */
  a: number;
}

/** 数值夹在 [min, max] */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** sRGB → 线性光（OKLab 转换用） */
function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** 线性光 → sRGB */
function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(clamp(c, 0, 1) * 255);
}

/** RGB → HSL */
export function rgbToHsl({ r, g, b, a }: Rgb): Hsl {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100), a };
}

/** HSL → RGB */
export function hslToRgb({ h, s, l, a }: Hsl): Rgb {
  const sn = s / 100,
    ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let rp = 0,
    gp = 0,
    bp = 0;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
    a,
  };
}

/** RGB → OKLCH（经 OKLab） */
export function rgbToOklch({ r, g, b, a }: Rgb): Oklch {
  const lr = srgbToLinear(r),
    lg = srgbToLinear(g),
    lb = srgbToLinear(b);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const C = Math.sqrt(A * A + B * B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { l: clamp(L, 0, 1), c: clamp(C, 0, 0.4), h: Math.round(H), a };
}

/** OKLCH → RGB（经 OKLab；超出 sRGB 色域的分量裁剪） */
export function oklchToRgb({ l, c, h, a }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.291485548 * B;
  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;
  return {
    r: linearToSrgb(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    g: linearToSrgb(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    b: linearToSrgb(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
    a,
  };
}

/** RGB → #rrggbb(aa) */
export function rgbToHex({ r, g, b, a }: Rgb): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  const base = `#${h(r)}${h(g)}${h(b)}`;
  return a < 1 ? base + h(Math.round(a * 255)) : base;
}

/* ════════ 色域判定与 P3 输出 ════════ */

/** linear sRGB → linear Display-P3（CSS Color 4 规范矩阵组合） */
function linearSrgbToLinearP3([r, g, b]: [number, number, number]): [number, number, number] {
  return [
    0.738206 * r + 0.232405 * g + 0.015061 * b,
    -0.062345 * r + 1.061177 * g - 0.050239 * b,
    -0.016601 * r + 0.11969 * g + 0.904577 * b,
  ];
}

/** 色域范围：sRGB（Web 基础）、P3（广色域，比 sRGB 大 ~50%）、out（连 P3 都装不下） */
export type Gamut = "srgb" | "p3" | "out";

/**
 * 判定 OKLCH 颜色落在哪个色域
 *
 * 判定链：OKLab → 未裁剪 linear sRGB（越界则不在 sRGB）→ 转 linear P3（越界则 out）
 */
export function oklchGamut({ l, c, h }: { l: number; c: number; h: number }): Gamut {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.291485548 * B;
  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;
  const lin: [number, number, number] = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  const eps = 1e-4;
  const inRange = (v: [number, number, number]) => v.every((x) => x >= -eps && x <= 1 + eps);
  if (inRange(lin)) return "srgb";
  if (inRange(linearSrgbToLinearP3(lin))) return "p3";
  return "out";
}

/**
 * OKLCH → color(display-p3 r g b / a) 字符串（P3 分量做 gamma 编码，不裁剪）
 *
 * 仅在颜色超出 sRGB 但在 P3 内时有意义
 */
export function oklchToP3Css({ l, c, h, a }: Oklch): string {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.291485548 * B;
  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;
  const lin: [number, number, number] = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  const p3 = linearSrgbToLinearP3(lin).map((v) => {
    const g = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(clamp(v, 0, 1), 1 / 2.4) - 0.055;
    return Math.round(g * 1000) / 1000;
  });
  const base = `color(display-p3 ${p3[0]} ${p3[1]} ${p3[2]})`;
  return a < 1 ? base.replace(")", ` / ${a})`) : base;
}

/** CSS 命名色表（常用子集，值为其 sRGB） */
export const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  orange: "#ffa500",
  pink: "#ffc0cb",
  purple: "#800080",
  violet: "#ee82ee",
  brown: "#a52a2a",
  gold: "#ffd700",
  navy: "#000080",
  teal: "#008080",
  salmon: "#fa8072",
  coral: "#ff7f50",
  tomato: "#ff6347",
  crimson: "#dc143c",
  indigo: "#4b0082",
  skyblue: "#87ceeb",
  steelblue: "#4682b4",
  seagreen: "#2e8b57",
  darkgray: "#a9a9a9",
  lightgray: "#d3d3d3",
};

/** 两位 hex → 十六进制数 */
function hex2(s: string): number {
  return parseInt(s, 16);
}

/**
 * 万能解析：把任意 CSS 颜色字符串解析为 RGB；失败返回 null
 *
 * 支持：#rgb #rgba #rrggbb #rrggbbaa、rgb()/rgba()、hsl()/hsla()、oklch()、CSS 命名色
 */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  // hex
  const mHex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (mHex) {
    const h = mHex[1];
    if (h.length === 3 || h.length === 4) {
      return {
        r: hex2(h[0] + h[0]),
        g: hex2(h[1] + h[1]),
        b: hex2(h[2] + h[2]),
        a: h.length === 4 ? hex2(h[3] + h[3]) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: hex2(h.slice(0, 2)),
        g: hex2(h.slice(2, 4)),
        b: hex2(h.slice(4, 6)),
        a: h.length === 8 ? hex2(h.slice(6, 8)) / 255 : 1,
      };
    }
    return null;
  }
  // rgb(a)
  const mRgb =
    /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/.exec(
      s,
    );
  if (mRgb) {
    const aRaw = mRgb[4];
    const a =
      aRaw == null ? 1 : aRaw.endsWith("%") ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
    return {
      r: clamp(Number(mRgb[1]), 0, 255),
      g: clamp(Number(mRgb[2]), 0, 255),
      b: clamp(Number(mRgb[3]), 0, 255),
      a: clamp(a, 0, 1),
    };
  }
  // hsl(a)
  const mHsl =
    /^hsla?\(\s*([\d.]+)(?:deg)?\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/.exec(
      s,
    );
  if (mHsl) {
    const aRaw = mHsl[4];
    const a =
      aRaw == null ? 1 : aRaw.endsWith("%") ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
    return hslToRgb({
      h: Number(mHsl[1]) % 360,
      s: clamp(Number(mHsl[2]), 0, 100),
      l: clamp(Number(mHsl[3]), 0, 100),
      a: clamp(a, 0, 1),
    });
  }
  // oklch
  const mOk =
    /^oklch\(\s*([\d.]+)%?\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:deg)?\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/.exec(
      s,
    );
  if (mOk) {
    const aRaw = mOk[4];
    const a =
      aRaw == null ? 1 : aRaw.endsWith("%") ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
    return oklchToRgb({
      l: clamp(Number(mOk[1]), 0, 1),
      c: clamp(Number(mOk[2]), 0, 0.4),
      h: Number(mOk[3]) % 360,
      a: clamp(a, 0, 1),
    });
  }
  // named
  if (NAMED_COLORS[s]) return parseColor(NAMED_COLORS[s]);
  return null;
}
