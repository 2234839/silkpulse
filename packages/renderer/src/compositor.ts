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
  /** 缓存的图片对象（增量帧 dataURL → Image 对象） */
  private imgCache = new Map<string, HTMLImageElement>()
  /** 最近关键帧的序号（用于检测丢帧后需要等待下一个 keyframe） */
  private lastKeyframeSeq = -1
  /** 上一帧序号（检测丢帧） */
  private lastSeq = -1

  constructor(
    private canvas: HTMLCanvasElement,
  ) {
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
   * dataURL 加载是异步的，但同一个 dataURL 只加载一次（imgCache）。
   */
  private drawImage(dataUrl: string, dx: number, dy: number, dw: number, dh: number): void {
    let img = this.imgCache.get(dataUrl)
    if (!img) {
      img = new Image()
      img.src = dataUrl
      this.imgCache.set(dataUrl, img)
      /** 控制 imgCache 大小（最多 100 张） */
      if (this.imgCache.size > 100) {
        const firstKey = this.imgCache.keys().next().value
        if (firstKey) this.imgCache.delete(firstKey)
      }
    }

    if (img.complete && img.naturalWidth > 0) {
      this.ctx!.drawImage(img, dx, dy, dw, dh)
    } else {
      /** 图片还没加载完，加载完后重绘 */
      img.onload = () => {
        this.ctx!.drawImage(img!, dx, dy, dw, dh)
      }
    }
  }

  /** 清空 canvas（停止共享时调用） */
  clear(): void {
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }
    this.imgCache.clear()
    this.lastKeyframeSeq = -1
    this.lastSeq = -1
  }
}
