/**
 * 截图采集与压缩 —— getDisplayMedia 方案
 *
 * 用户授权后通过 getDisplayMedia 获取屏幕/标签页视频流，
 * 截取一帧作为预览底图（像素级保真，替代 DOM 重建的低保真预览）。
 *
 * 压缩策略：
 * - 缩放到预览画布尺寸（无需原始分辨率）
 * - JPEG 格式，质量 0.5（截图只需辨识布局，不需像素级清晰）
 * - 输出约 10-50KB 的 dataURL
 */

/** 截图压缩质量 */
export const SCREENSHOT_QUALITY = 0.5

/** 截图最大宽度（防止超大屏幕生成过大的 dataURL） */
const SCREENSHOT_MAX_WIDTH = 800

/** 截图数据（压缩后的 dataURL + 采集时间戳） */
export interface ScreenshotData {
  /** JPEG dataURL */
  dataUrl: string
  /** 采集时间戳（ms） */
  timestamp: number
  /** 原始视口宽度 px */
  viewportWidth: number
  /** 原始视口高度 px */
  viewportHeight: number
}

/**
 * 将 video 帧截取并压缩成 dataURL
 *
 * @param video 已加载视频流的 <video> 元素
 * @param targetWidth 目标宽度（按比例缩放）
 * @returns 压缩后的 JPEG dataURL
 */
export function compressVideoFrame(video: HTMLVideoElement, targetWidth: number): string | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  try {
    /** 缩放到目标宽度，限制最大宽度 */
    const scale = Math.min(targetWidth / vw, SCREENSHOT_MAX_WIDTH / vw, 1)
    const w = Math.max(1, Math.round(vw * scale))
    const h = Math.max(1, Math.round(vh * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', SCREENSHOT_QUALITY)
  } catch {
    /** SecurityError 或其他异常 */
    return null
  }
}

/**
 * 将已有 ImageBitmap / canvas / 图片元素压缩成 dataURL
 *
 * 通用压缩函数，可用于非 getDisplayMedia 场景（如 html2canvas 替代方案）。
 */
export function compressScreenshot(
  source: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  targetWidth: number,
): string | null {
  let sw: number
  let sh: number

  if (source instanceof HTMLImageElement) {
    sw = source.naturalWidth
    sh = source.naturalHeight
  } else if (source instanceof HTMLCanvasElement) {
    sw = source.width
    sh = source.height
  } else {
    /** ImageBitmap */
    sw = source.width
    sh = source.height
  }

  if (!sw || !sh) return null

  try {
    const scale = Math.min(targetWidth / sw, SCREENSHOT_MAX_WIDTH / sw, 1)
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(source as CanvasImageSource, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', SCREENSHOT_QUALITY)
  } catch {
    return null
  }
}
