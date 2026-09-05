/**
 * 预览画布计算 —— 纯函数
 *
 * 根据容器宽度和快照视口尺寸，计算缩放比例、画布尺寸、可见元素列表。
 */
import type { SnapshotData, SnapshotElement } from "@silkpulse/shared";

/** 预览画布的内边距（左右各留一些空隙） */
export const PREVIEW_PADDING = 32;

/** 预览布局计算结果 */
export interface PreviewLayout {
  /** 缩放比例（画布 / 实际视口） */
  scale: number;
  /** 画布宽度 px */
  canvasWidth: number;
  /** 画布高度 px */
  canvasHeight: number;
}

/**
 * 计算缩放比例
 *
 * @param containerWidth 预览容器实际宽度 px
 * @param viewportWidth 快照视口宽度 px
 */
export function computeScale(containerWidth: number, viewportWidth: number): number {
  return Math.max(0.1, (containerWidth - PREVIEW_PADDING) / viewportWidth);
}

/**
 * 从快照中过滤出有有效 rect 的元素（预览渲染用）
 */
export function filterRectElements(els: SnapshotElement[]): SnapshotElement[] {
  return els.filter((e) => e.rect && e.rect.w > 0 && e.rect.h > 0);
}

/**
 * 计算预览画布尺寸
 *
 * @param snapshot 快照数据
 * @param scale 缩放比例
 */
export function computeCanvasSize(snapshot: SnapshotData, scale: number): PreviewLayout {
  return {
    scale,
    canvasWidth: Math.round(snapshot.viewportWidth * scale),
    canvasHeight: Math.round(snapshot.viewportHeight * scale),
  };
}
