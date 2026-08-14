/**
 * 帧合成器 —— 将增量帧补丁合成到 Canvas 上
 *
 * SDK 端发送 keyframe（完整画面）+ delta frame（变化区域），
 * 控制台端用本合成器把帧逐个画到 canvas 上，最终得到完整画面。
 *
 * 用法：
 * const compositor = new FrameCompositor(canvas)
 * compositor.drawFrame(frame)  // 收到帧时调用
 */
import type { ScreenFrame } from '@silkpulse/shared'

export class FrameCompositor {
  private ctx: CanvasRenderingContext2D | null = null
  /** 最近关键帧的序号（用于检测丢帧后需要等待下一个 keyframe） */
  private lastKeyframeSeq = -1
  /** 上一帧序号（检测丢帧） */
  private lastSeq = -1
  /** canvas 元素 */
  private canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
  }

  /**
   * 处理一帧（keyframe 或增量帧），合成到 canvas
   *
   * @returns true 画面已更新，false 帧被丢弃（丢帧等待 keyframe）
   */
  drawFrame(frame: ScreenFrame): boolean {
    if (!this.ctx) return false

    /** 关键帧：重设 canvas 尺寸 + 全量绘制 */
    if (frame.keyframe) {
      if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
        this.canvas.width = frame.width
        this.canvas.height = frame.height
      }
      this.lastKeyframeSeq = frame.seq
      this.lastSeq = frame.seq
      this.drawImage(frame.dataUrl, 0, 0, frame.width, frame.height)
      return true
    }

    /** 增量帧：检查是否有对应的基础帧（如果丢了 keyframe 无法合成） */
    if (this.lastKeyframeSeq < 0) {
      /** 还没收到 keyframe，丢弃增量帧 */
      return false
    }

    /**
     * 丢帧检测：如果帧序号跳了太多（>5），说明网络丢包严重，
     * 累积误差可能很大，等下一个 keyframe 重来。
     */
    if (frame.seq - this.lastSeq > 5) {
      return false
    }

    /** 增量帧：将变化区域贴到 canvas 对应位置 */
    this.drawImage(frame.dataUrl, frame.dx, frame.dy, frame.dw, frame.dh)
    this.lastSeq = frame.seq
    return true
  }

  /**
   * 加载 dataURL 为 Image 并绘制到 canvas 指定位置
   *
   * 优化：每帧 dataURL 都是唯一的（JPEG 编码），imgCache 无法命中，
   * 所以不缓存，直接创建 Image → 加载完 → 绘制。
   */
  private drawImage(dataUrl: string, dx: number, dy: number, dw: number, dh: number): void {
    const img = new Image()
    img.src = dataUrl

    if (img.complete && img.naturalWidth > 0) {
      this.ctx!.drawImage(img, dx, dy, dw, dh)
    } else {
      img.onload = () => {
        this.ctx!.drawImage(img, dx, dy, dw, dh)
      }
    }
  }

  /** 清空 canvas（停止共享时调用） */
  clear(): void {
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }
    this.lastKeyframeSeq = -1
    this.lastSeq = -1
  }
}
