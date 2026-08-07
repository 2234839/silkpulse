/**
 * useResizable —— 可拖拽边框改变宽度的通用 hook
 *
 * 用法：
 *   const { width, onDragStart } = useResizable({ initial: 288, min: 200, max: 500, direction: 'right' })
 *
 *   <div :style="{ width: width + 'px' }">...</div>
 *   <div @mousedown="onDragStart" class="w-1 cursor-col-resize" />
 *
 * direction 说明：
 * - 'right'：拖拽手柄在面板右侧，向右拖增大宽度（如左侧设备列表）
 * - 'left'：拖拽手柄在面板左侧，向左拖增大宽度（如右侧面板）
 */
import { ref, onUnmounted } from 'vue'

interface Options {
  /** 初始宽度 px */
  initial: number
  /** 最小宽度 px */
  min: number
  /** 最大宽度 px */
  max: number
  /**
   * 拖拽方向：
   * - 'right'：手柄在右侧，鼠标右移 → 宽度增大
   * - 'left'：手柄在左侧，鼠标左移 → 宽度增大
   */
  direction: 'right' | 'left'
}

export function useResizable(opts: Options) {
  const width = ref(opts.initial)
  let dragging = false
  /** 拖拽起始 X 坐标 */
  let startX = 0
  /** 拖拽起始宽度 */
  let startW = 0

  function onMouseMove(e: MouseEvent) {
    if (!dragging) return
    const delta = e.clientX - startX
    /** right 方向：delta > 0 增宽；left 方向：delta < 0 增宽 */
    const newW = opts.direction === 'right'
      ? startW + delta
      : startW - delta
    width.value = Math.max(opts.min, Math.min(opts.max, newW))
  }

  function onMouseUp() {
    dragging = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  /** 绑定到 mousedown 事件 */
  function onDragStart(e: MouseEvent) {
    e.preventDefault()
    dragging = true
    startX = e.clientX
    startW = width.value
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  onUnmounted(onMouseUp)

  return { width, onDragStart }
}
