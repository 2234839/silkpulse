/**
 * 截图引擎 —— 基于 @zumer/snapdom 的统一截图入口
 *
 * 设计说明（曾评估 Chrome HTML-in-Canvas API 作为快路径，实测否决）：
 * drawElementImage / captureElementImage 在 Chrome 155 实测均要求
 * 「目标元素必须是 canvas 的最近祖先后代」——该 API 是把 DOM 搬进
 * canvas 内部布局的渲染 API，不是元素截图 API。用它截页面元素
 * 必须 reparent 目标节点，会瞬间破坏页面布局，不适合无感截图场景。
 * 相关探针脚本：scripts/probe-remote-html-in-canvas.mjs。
 *
 * 统一入口的意义：未来若出现真正可用的原生元素捕获 API，
 * 只需在此文件加快路径，调用方（screen-capture/exec-runner）不动。
 */

/** 截图选项 */
export interface CaptureOptions {
  /** 截图宽度（viewport 模式用，不传则取 target 的 bounding rect） */
  width?: number;
  /** 截图高度（viewport 模式用，不传则取 target 的 bounding rect） */
  height?: number;
  /** 背景色，默认 '#ffffff' */
  backgroundColor?: string;
  /** 缩放倍率，默认 1 */
  scale?: number;
  /** 是否截取视口（viewport 模式） */
  viewport?: boolean;
}

/**
 * per-capture plugin：修复 flex/grid 容器内 truncate 文字溢出
 *
 * snapdom 克隆 DOM 到 foreignObject 时，对 flex/grid 子项做 min-width:0 处理，
 * 但当子项 white-space:nowrap（如 Tailwind truncate）时该处理被跳过，
 * 导致 overflow:hidden + text-overflow:ellipsis 失效，文字溢出容器。
 *
 * 通过 afterClone 钩子向克隆 DOM 注入 <style> 实现等效效果。
 */
const minWidthPlugin = {
  name: "fix-min-width",
  afterClone(ctx: { clone?: HTMLElement | SVGElement | null }) {
    if (!ctx.clone) return;
    const style = document.createElement("style");
    style.textContent = `* { min-width: 0 !important; }`;
    ctx.clone.prepend(style);
  },
};

/**
 * 计算目标 canvas 尺寸
 */
function computeSize(
  target: Element,
  opts: CaptureOptions,
): { width: number; height: number } {
  const scale = opts.scale ?? 1;

  if (opts.viewport) {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    return {
      width: Math.round((opts.width ?? vw) * scale),
      height: Math.round((opts.height ?? vh) * scale),
    };
  }

  if (opts.width != null && opts.height != null) {
    return {
      width: Math.round(opts.width * scale),
      height: Math.round(opts.height * scale),
    };
  }

  const rect = target.getBoundingClientRect();
  return {
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  };
}

/**
 * 截取指定元素的截图，返回 Canvas（SnapDOM 实现）
 *
 * @param target 目标 DOM 元素
 * @param opts 截图选项
 */
export async function captureElement(
  target: Element,
  opts: CaptureOptions = {},
): Promise<HTMLCanvasElement> {
  const { snapdom } = await import("@zumer/snapdom");

  const backgroundColor = opts.backgroundColor ?? "#ffffff";
  const size = computeSize(target, opts);

  if (opts.viewport) {
    return snapdom.toCanvas(target, {
      width: size.width,
      height: size.height,
      backgroundColor,
      fast: true,
      clip: "viewport",
      plugins: [minWidthPlugin],
    });
  }

  return snapdom.toCanvas(target, {
    backgroundColor,
    fast: true,
    scale: opts.scale ?? 1,
    plugins: [minWidthPlugin],
  });
}
