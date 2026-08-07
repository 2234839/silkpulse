/**
 * 屏幕共享 —— 基于 SnapDOM 的页面截图增量推帧
 *
 * 工作流程：
 * 1. 控制台发 start-screen-share → SDK 用 @zumer/snapdom 截取 document.body
 * 2. 首帧：完整 JPEG（keyframe）→ WS 上报
 * 3. 后续帧：与上一帧做像素 diff，只裁剪变化区域编码（增量帧）
 * 4. 无变化时跳过（不发包，省带宽）
 * 5. 每 N 帧强制发一次 keyframe（防累积误差）
 * 6. 控制台发 stop-screen-share → 停止推帧
 *
 * 优势（相比 getDisplayMedia）：
 * - 不需要用户授权/选择窗口
 * - 直接截取当前页面自身（getDisplayMedia 无法捕获调用它的标签页）
 * - 无需用户手势激活
 *
 * 优势（相比 modern-screenshot）：
 * - SnapDOM 性能更好（benchmark 快 ~8x on complex pages）
 * - 体积更小、零依赖
 * - toCanvas 直接返回 Canvas（省去 Image 中间步骤）
 *
 * 帧差算法：
 * - 将画面降采样到低分辨率（如 160×90）做像素对比（O(n) 很快）
 * - 阈值过滤噪声（逐像素 RGB 差 > 阈值才算「变化」）
 * - 计算变化像素的包围盒（bounding box）
 * - 从原始画面裁剪包围盒区域编码成 JPEG
 */
import { snapdom } from '@zumer/snapdom'
import type { ScreenFrame, ScreenShareStatus } from '@clarosight/shared'

/** 抓帧间隔 ms（2fps，截图比视频流重，用较低帧率） */
const FRAME_INTERVAL = 500

/** 关键帧间隔（每 60 帧 ≈ 30 秒强制全量刷新一次，防累积误差） */
const KEYFRAME_INTERVAL = 60

/** 像素变化判定阈值（RGB 差值之和 > 此值认为该像素变了） */
const PIXEL_DIFF_THRESHOLD = 30

/** 帧差对比用的降采样宽度（越小越快但越粗糙） */
const DIFF_SAMPLE_WIDTH = 160

/** JPEG 编码质量（增量帧用较低质量省带宽） */
const JPEG_QUALITY_KEY = 0.6
const JPEG_QUALITY_DELTA = 0.4

/** 最大输出宽度（防止大页面生成过大帧） */
const MAX_OUTPUT_WIDTH = 1280

/** 增量区域最小尺寸（太小的变化不值得裁剪） */
const MIN_DIRTY_SIZE = 8

/** 抓帧定时器 */
let frameTimer: ReturnType<typeof setInterval> | null = null
/** 帧序号 */
let frameSeq = 0
/** 上一帧的完整 canvas（用于增量帧 diff + 裁剪源） */
let prevCanvas: HTMLCanvasElement | null = null
/** 帧差对比用的 canvas context */
let diffCtx: CanvasRenderingContext2D | null = null
/** 发送回调（由 index.ts 注入） */
let sender: ((frame: ScreenFrame) => void) | null = null
/** 共享状态回调（回报给控制台） */
let statusCallback: ((status: ScreenShareStatus) => void) | null = null
/** 是否正在抓帧（防止重叠） */
let capturing = false

/**
 * 开始屏幕共享（由 server 的 start-screen-share 消息触发）
 *
 * 直接对 document.body 截图，无需用户授权。
 */
export function startScreenShare(
  onFrame: (frame: ScreenFrame) => void,
  onStatus?: (status: ScreenShareStatus) => void,
): void {
  /** 更新回调（可能来自新的控制台连接） */
  sender = onFrame
  statusCallback = onStatus ?? null

  /** 已在共享中：只需重发当前状态（控制台可能刷新后重连） */
  if (frameTimer) {
    statusCallback?.('sharing')
    return
  }

  frameSeq = 0
  prevCanvas = null

  /** 创建帧差用的低分辨率 canvas */
  const diffCanvas = document.createElement('canvas')
  diffCtx = diffCanvas.getContext('2d', { willReadFrequently: true })

  statusCallback?.('sharing')

  /** 立即抓第一帧 */
  captureFrame()

  /** 启动定时抓帧循环 */
  frameTimer = setInterval(captureFrame, FRAME_INTERVAL)
}

/** 停止屏幕共享 */
export function stopScreenShare(): void {
  if (frameTimer) {
    clearInterval(frameTimer)
    frameTimer = null
  }
  prevCanvas = null
  diffCtx = null
  sender = null
  statusCallback = null
  capturing = false
}

/** 当前是否在共享中 */
export function isScreenSharing(): boolean {
  return frameTimer !== null
}

/**
 * 抓取一帧：用 SnapDOM 截取 document.body → canvas → 增量 diff
 */
async function captureFrame(): Promise<void> {
  if (!sender || !diffCtx || capturing) return
  capturing = true

  try {
    /** 截取页面可视区域 */
    const curCanvas = await screenshotViewport()
    if (!curCanvas) {
      capturing = false
      return
    }

    const vw = curCanvas.width
    const vh = curCanvas.height

    /** 输出尺寸：限制最大宽度 */
    const outScale = Math.min(MAX_OUTPUT_WIDTH / vw, 1)
    const outW = Math.round(vw * outScale)
    const outH = Math.round(vh * outScale)

    const seq = frameSeq++
    const isKeyframe = seq % KEYFRAME_INTERVAL === 0

    if (isKeyframe || !prevCanvas) {
      /** 关键帧：完整画面 */
      const dataUrl = canvasToJpeg(curCanvas, JPEG_QUALITY_KEY)
      if (dataUrl) {
        sender({
          keyframe: true,
          dataUrl,
          seq,
          width: outW,
          height: outH,
          dx: 0, dy: 0, dw: outW, dh: outH,
          timestamp: Date.now(),
        })
      }
      prevCanvas = curCanvas
      capturing = false
      return
    }

    /** 增量帧：先降采样到 diff canvas 做像素对比 */
    const diffScale = DIFF_SAMPLE_WIDTH / vw
    const diffW = DIFF_SAMPLE_WIDTH
    const diffH = Math.round(vh * diffScale)

    diffCtx.canvas.width = diffW
    diffCtx.canvas.height = diffH

    /** 当前帧降采样 */
    diffCtx.drawImage(curCanvas, 0, 0, diffW, diffH)
    const curDiffData = diffCtx.getImageData(0, 0, diffW, diffH)

    /** 上一帧降采样 */
    diffCtx.drawImage(prevCanvas, 0, 0, diffW, diffH)
    const prevDiffData = diffCtx.getImageData(0, 0, diffW, diffH)

    /** 计算变化区域包围盒 */
    const dirty = computeDirtyBox(prevDiffData, curDiffData)

    if (!dirty) {
      /** 画面没变化，跳过（不发包 = 最大带宽节省） */
      prevCanvas = curCanvas
      capturing = false
      return
    }

    /** 将 diff 坐标系（低分辨率）映射回原始截图坐标系 */
    const realX = Math.max(0, Math.floor(dirty.x / diffScale) - 4)
    const realY = Math.max(0, Math.floor(dirty.y / diffScale) - 4)
    const realW = Math.min(vw - realX, Math.ceil(dirty.w / diffScale) + 8)
    const realH = Math.min(vh - realY, Math.ceil(dirty.h / diffScale) + 8)

    /** 裁剪变化区域编码 */
    const regionCanvas = document.createElement('canvas')
    regionCanvas.width = Math.round(realW * outScale)
    regionCanvas.height = Math.round(realH * outScale)
    const regionCtx = regionCanvas.getContext('2d')
    if (!regionCtx) {
      prevCanvas = curCanvas
      capturing = false
      return
    }
    regionCtx.drawImage(
      curCanvas,
      realX, realY, realW, realH,
      0, 0, regionCanvas.width, regionCanvas.height,
    )
    const dataUrl = canvasToJpeg(regionCanvas, JPEG_QUALITY_DELTA)

    if (dataUrl) {
      sender({
        keyframe: false,
        dataUrl,
        seq,
        width: outW,
        height: outH,
        dx: Math.round(realX * outScale),
        dy: Math.round(realY * outScale),
        dw: regionCanvas.width,
        dh: regionCanvas.height,
        timestamp: Date.now(),
      })
    }

    prevCanvas = curCanvas
  } catch (e) {
    /** 截图失败（可能跨域资源 taint），静默跳过本帧 */
    console.warn('[clarosight] 截图失败:', e)
  } finally {
    capturing = false
  }
}

/**
 * 截取当前页面可视区域（viewport）
 *
 * 用 SnapDOM 的 clip: 'viewport' 选项只捕获视口可见区域，
 * 而非整个 body（包括滚动区域外的内容）。
 */
async function screenshotViewport(): Promise<HTMLCanvasElement | null> {
  const vw = document.documentElement.clientWidth
  const vh = window.innerHeight

  /** SnapDOM clip:'viewport' 只截视口区域 */
  const canvas = await snapdom.toCanvas(document.body, {
    width: vw,
    height: vh,
    backgroundColor: '#ffffff',
    fast: true,
    burst: true,
    clip: 'viewport',
  })

  return canvas
}

/**
 * canvas → JPEG dataURL
 */
function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): string | null {
  try {
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return null
  }
}

/**
 * 像素级帧差，计算变化区域的包围盒
 *
 * @returns 变化区域 {x,y,w,h}（在 diff 采样坐标系中），或 null（无变化）
 */
function computeDirtyBox(prev: ImageData, cur: ImageData): { x: number; y: number; w: number; h: number } | null {
  const { width: w, height: h, data: d1 } = prev
  const { data: d2 } = cur

  let minX = w, minY = h, maxX = 0, maxY = 0
  let changed = false

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const dr = Math.abs(d1[i] - d2[i])
      const dg = Math.abs(d1[i + 1] - d2[i + 1])
      const db = Math.abs(d1[i + 2] - d2[i + 2])
      if (dr + dg + db > PIXEL_DIFF_THRESHOLD) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        changed = true
      }
    }
  }

  if (!changed) return null
  if (maxX - minX < MIN_DIRTY_SIZE && maxY - minY < MIN_DIRTY_SIZE) return null

  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}
