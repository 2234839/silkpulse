/**
 * 鼠标/触摸事件采集器 —— 实时上报用户操作到控制台
 *
 * 监听 pointermove / click 事件，节流后通过回调上报归一化坐标。
 * 控制台在画面/布局预览上渲染虚拟光标，实现"看到用户在做什么"。
 *
 * 设计要点：
 * - move 事件节流 50ms（~20fps），足够流畅且不淹没问题
 * - 坐标归一化为 0~1（除以视口宽高），控制台乘以画布尺寸即可定位
 * - 采集始终开启（不按 watcher 控制），因为鼠标数据轻量且价值高
 */

import type { MouseEventData } from '@clarosight/shared'

/** move 事件最小间隔 ms */
const MOVE_THROTTLE = 50

/** 发送回调 */
let sender: ((mouse: MouseEventData) => void) | null = null
/** 上次 move 上报时间 */
let lastMoveTime = 0
/** 是否已激活 */
let active = false

/** move 事件处理（节流） */
function onPointerMove(e: PointerEvent): void {
  if (!sender) return
  const now = Date.now()
  if (now - lastMoveTime < MOVE_THROTTLE) return
  lastMoveTime = now
  sender({
    type: 'move',
    x: e.clientX / window.innerWidth,
    y: e.clientY / window.innerHeight,
    t: now,
  })
}

/** click 事件处理 */
function onClick(e: PointerEvent): void {
  if (!sender) return
  const now = Date.now()
  sender({
    type: 'click',
    x: e.clientX / window.innerWidth,
    y: e.clientY / window.innerHeight,
    t: now,
  })
}

/**
 * 启动鼠标采集
 *
 * @param onEvent 鼠标事件回调（由 index.ts 注入 send）
 */
export function startMouseTracker(onEvent: (mouse: MouseEventData) => void): void {
  sender = onEvent
  if (active) return
  active = true
  /** passive:true 不阻塞滚动 */
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('click', onClick, { passive: true })
}

/** 停止鼠标采集 */
export function stopMouseTracker(): void {
  if (!active) return
  active = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('click', onClick)
  sender = null
}
