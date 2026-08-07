/**
 * 屏幕共享 —— 增量图传引擎
 *
 * 工作流程：
 * 1. 控制台发 start-screen-share → SDK 调 getDisplayMedia（用户授权）
 * 2. 授权后启动定时抓帧循环（默认 3fps）
 * 3. 首帧：完整 JPEG（keyframe）→ WS 上报
 * 4. 后续帧：与上一帧做像素 diff，只裁剪变化区域编码（增量帧）
 * 5. 无变化时跳过（不发包，省带宽）
 * 6. 每 N 帧强制发一次 keyframe（防累积误差）
 * 7. 控制台发 stop-screen-share 或用户手动停止 → 停止推流
 *
 * 帧差算法：
 * - 将画面降采样到低分辨率（如 160×90）做像素对比（O(n) 很快）
 * - 阈值过滤噪声（逐像素 RGB 差 > 阈值才算「变化」）
 * - 计算变化像素的包围盒（bounding box）
 * - 从原始画面裁剪包围盒区域编码成 JPEG
 */
import type { ScreenFrame } from '@clarosight/shared'

/** 抓帧间隔 ms（3fps，平衡流畅度和带宽） */
const FRAME_INTERVAL = 333

/** 关键帧间隔（每 15 帧 ≈ 5 秒强制全量刷新一次） */
const KEYFRAME_INTERVAL = 15

/** 像素变化判定阈值（RGB 差值之和 > 此值认为该像素变了） */
const PIXEL_DIFF_THRESHOLD = 30

/** 帧差对比用的降采样宽度（越小越快但越粗糙） */
const DIFF_SAMPLE_WIDTH = 160

/** JPEG 编码质量（增量帧用较低质量省带宽） */
const JPEG_QUALITY_KEY = 0.6
const JPEG_QUALITY_DELTA = 0.4

/** 最大输出宽度（防止 4K 屏生成过大帧） */
const MAX_OUTPUT_WIDTH = 1280

/** 增量区域最小尺寸（太小的变化不值得裁剪） */
const MIN_DIRTY_SIZE = 8

/** 视频流 */
let stream: MediaStream | null = null
/** 抓帧定时器 */
let frameTimer: ReturnType<typeof setInterval> | null = null
/** 用于抓帧的 video 元素 */
let video: HTMLVideoElement | null = null
/** 帧序号 */
let frameSeq = 0
/** 上一帧的画面数据（用于帧差对比） */
let prevImageData: ImageData | null = null
/** 帧差对比用的 canvas context */
let diffCtx: CanvasRenderingContext2D | null = null
/** 发送回调（由 index.ts 注入） */
let sender: ((frame: ScreenFrame) => void) | null = null
/** 共享状态回调 */
let statusCallback: ((status: 'sharing' | 'stopped' | 'denied' | 'error') => void) | null = null

/**
 * 开始屏幕共享（由 server 的 start-screen-share 消息触发）
 *
 * 浏览器会弹出原生授权弹窗，用户选择后才开始推流。
 */
export async function startScreenShare(
  onFrame: (frame: ScreenFrame) => void,
  onStatus?: (status: 'sharing' | 'stopped' | 'denied' | 'error') => void,
): Promise<void> {
  /** 已在共享中，不重复启动 */
  if (stream) return

  sender = onFrame
  statusCallback = onStatus ?? null

  if (!navigator.mediaDevices?.getDisplayMedia) {
    console.warn('[clarosight] getDisplayMedia 不可用')
    statusCallback?.('error')
    return
  }

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') {
      statusCallback?.('denied')
    } else {
      statusCallback?.('error')
    }
    return
  }

  /** 用户在浏览器原生 UI 中点了「停止共享」 */
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    stopScreenShare()
    statusCallback?.('stopped')
  })

  /** 创建 video 元素接收流 */
  video = document.createElement('video')
  video.srcObject = stream
  video.muted = true
  video.autoplay = true
  video.playsInline = true

  await new Promise<void>((resolve) => {
    if (!video) return resolve()
    video.onloadedmetadata = () => video!.play().then(() => resolve()).catch(() => resolve())
  })

  /** 重置帧状态 */
  frameSeq = 0
  prevImageData = null

  /** 创建帧差用的低分辨率 canvas */
  const diffCanvas = document.createElement('canvas')
  diffCtx = diffCanvas.getContext('2d', { willReadFrequently: true })

  statusCallback?.('sharing')

  /** 启动抓帧循环 */
  frameTimer = setInterval(captureFrame, FRAME_INTERVAL)
}

/** 停止屏幕共享 */
export function stopScreenShare(): void {
  if (frameTimer) {
    clearInterval(frameTimer)
    frameTimer = null
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop()
    stream = null
  }
  video = null
  prevImageData = null
  diffCtx = null
  sender = null
}

/** 当前是否在共享中 */
export function isScreenSharing(): boolean {
  return stream !== null
}

/**
 * 抓取一帧，计算帧差，决定发 keyframe 还是增量帧
 */
function captureFrame(): void {
  if (!video || !sender || !diffCtx) return

  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return

  /** 输出尺寸：限制最大宽度 */
  const outScale = Math.min(MAX_OUTPUT_WIDTH / vw, 1)
  const outW = Math.round(vw * outScale)
  const outH = Math.round(vh * outScale)

  /** 帧差采样尺寸 */
  const diffScale = DIFF_SAMPLE_WIDTH / vw
  const diffW = DIFF_SAMPLE_WIDTH
  const diffH = Math.round(vh * diffScale)

  diffCtx.canvas.width = diffW
  diffCtx.canvas.height = diffH

  /** 降采样绘制当前帧到 diff canvas */
  diffCtx.drawImage(video, 0, 0, diffW, diffH)
  const curData = diffCtx.getImageData(0, 0, diffW, diffH)

  const seq = frameSeq++
  const isKeyframe = seq % KEYFRAME_INTERVAL === 0

  if (isKeyframe || !prevImageData) {
    /** 关键帧：完整画面 */
    const dataUrl = encodeRegion(video, 0, 0, vw, vh, outW, outH, true)
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
    prevImageData = curData
    return
  }

  /** 增量帧：计算变化区域包围盒 */
  const dirty = computeDirtyBox(prevImageData, curData)
  prevImageData = curData

  if (!dirty) {
    /** 画面没变化，跳过（不发包 = 最大带宽节省） */
    return
  }

  /** 将 diff 坐标系（低分辨率）映射回原始视频坐标系 */
  const realX = Math.max(0, Math.floor(dirty.x / diffScale) - 4)
  const realY = Math.max(0, Math.floor(dirty.y / diffScale) - 4)
  const realW = Math.min(vw - realX, Math.ceil(dirty.w / diffScale) + 8)
  const realH = Math.min(vh - realY, Math.ceil(dirty.h / diffScale) + 8)

  /** 裁剪变化区域编码 */
  const dataUrl = encodeRegion(video, realX, realY, realW, realH, Math.round(realW * outScale), Math.round(realH * outScale), false)
  if (dataUrl) {
    sender({
      keyframe: false,
      dataUrl,
      seq,
      width: outW,
      height: outH,
      dx: Math.round(realX * outScale),
      dy: Math.round(realY * outScale),
      dw: Math.round(realW * outScale),
      dh: Math.round(realH * outScale),
      timestamp: Date.now(),
    })
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

/**
 * 从视频流中裁剪指定区域并编码成 JPEG dataURL
 */
function encodeRegion(
  source: HTMLVideoElement,
  sx: number, sy: number, sw: number, sh: number,
  outW: number, outH: number,
  isKey: boolean,
): string | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, outW, outH)
    return canvas.toDataURL('image/jpeg', isKey ? JPEG_QUALITY_KEY : JPEG_QUALITY_DELTA)
  } catch {
    return null
  }
}
