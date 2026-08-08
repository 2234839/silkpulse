/**
 * DOM 变化采集器 —— MutationObserver 监听 DOM 变化并上报
 *
 * 策略：
 * 1. 监听 document.body 子树（childList + attributes + characterData）
 * 2. 收集变化后 debounce 200ms 上报，只传受影响的父元素 idx（精简）
 * 3. 自动追踪 shadow DOM：检测到新 shadow root 时挂载子 observer
 * 4. 只在控制台 Element 面板打开时才有意义，但始终挂载（开销极小）
 *
 * 上报数据结构：{ parentIdxs: number[], kinds: string[], timestamp }
 * 控制台收到后按 parentIdxs 刷新对应已展开节点。
 */

import type { DomChangeData } from '@silkpulse/shared'

/** 上报回调（SDK index.ts 注入 ws send） */
type Sink = (changes: DomChangeData) => void

/** debounce timer */
let debounceTimer: ReturnType<typeof setTimeout> | undefined

/** 待上报的变化收集器（debounce 窗口内累积） */
let pendingParentIdxs = new Set<number>()
let pendingKinds = new Set<DomChangeData['kinds'][number]>()

/** 已挂载的 observer 集合（断开时统一清理） */
const observers: MutationObserver[] = []

/** 控制台是否订阅了 dom-change（由 server set-watchers 消息控制，默认不发减少开销） */
let active = false

/**
 * 尝试给元素打 idx 并收集
 *
 * 元素可能还未被 __silkpulse_ensureIdx 注册（新插入的节点），
 * 打 idx 失败时跳过（不在此处注册——避免树未展开时打太多无效 idx）。
 */
function tryCollectIdx(el: Element | null, kind: DomChangeData['kinds'][number]): void {
  if (!el) return
  const w = window as unknown as {
    __silkpulse_ensureIdx?: (el: Element) => number
  }
  const ensure = w.__silkpulse_ensureIdx
  if (!ensure) return
  const idx = ensure(el)
  if (idx >= 0) {
    pendingParentIdxs.add(idx)
    pendingKinds.add(kind)
  }
}

/** flush：发送累积的变化 */
function flush(sink: Sink): void {
  if (pendingParentIdxs.size === 0) {
    pendingKinds.clear()
    return
  }
  sink({
    parentIdxs: [...pendingParentIdxs],
    kinds: [...pendingKinds],
    timestamp: Date.now(),
  })
  pendingParentIdxs = new Set()
  pendingKinds = new Set()
}

/** 调度 flush（debounce 200ms，批量上报减少消息频率） */
function scheduleFlush(sink: Sink): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined
    flush(sink)
  }, 200)
}

/**
 * 为目标节点创建 MutationObserver
 *
 * 对 body 和每个 shadow root 各创建一个 observer。
 * shadowRoot 不能用 subtree:true 跨边界观察，必须分别挂载。
 */
function observeTarget(target: Node, sink: Sink): MutationObserver {
  const observer = new MutationObserver((mutations) => {
    if (!active) return

    for (const mut of mutations) {
      switch (mut.type) {
        case 'childList': {
          /** 子元素增删 → 收集父元素（target 就是父节点） */
          const parent = mut.target as Element
          if (mut.addedNodes.length > 0) {
            tryCollectIdx(parent, 'added')
            /** 新增的 shadow host → 自动挂载 observer */
            for (const node of mut.addedNodes) {
              if (node instanceof Element && node.shadowRoot) {
                observeTarget(node.shadowRoot, sink)
              }
            }
          }
          if (mut.removedNodes.length > 0) {
            tryCollectIdx(parent, 'removed')
          }
          break
        }
        case 'attributes': {
          /** 属性变化 → 收集目标元素自身 */
          tryCollectIdx(mut.target as Element, 'attributes')
          break
        }
        case 'characterData': {
          /** 文本变化 → 收集父元素（文本节点本身没有 idx） */
          const parent = (mut.target as Text).parentElement
          tryCollectIdx(parent, 'text')
          break
        }
      }
    }
    scheduleFlush(sink)
  })

  observer.observe(target, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: target === document.body, /** body 用 subtree，shadow root 各自管自己的子树 */
  })

  observers.push(observer)
  return observer
}

/**
 * 扫描已有 shadow root（初始化时用）
 *
 * 页面可能在 SDK 加载前就有 shadow DOM，扫描一遍把已有的 shadow root 也纳入观察。
 */
function scanExistingShadowRoots(root: ParentNode, sink: Sink): void {
  const all = root.querySelectorAll('*')
  for (const el of all) {
    if (el.shadowRoot) {
      observeTarget(el.shadowRoot, sink)
      scanExistingShadowRoots(el.shadowRoot, sink)
    }
  }
}

/** 安装 DOM 变化采集器 */
export function installDomWatcher(sink: Sink): void {
  if (!document.body) {
    /** body 还没准备好，等 DOMContentLoaded */
    document.addEventListener('DOMContentLoaded', () => installDomWatcher(sink), { once: true })
    return
  }

  /** 观察 body 整棵树 */
  observeTarget(document.body, sink)

  /** 扫描已有 shadow root */
  scanExistingShadowRoots(document, sink)
}

/** 暂停/恢复上报（控制台未打开 Element 面板时可暂停减少开销） */
export function setDomWatcherActive(value: boolean): void {
  active = value
  if (!value && debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
    pendingParentIdxs.clear()
    pendingKinds.clear()
  }
}

/** 断开所有 observer（页面卸载时调用） */
export function disconnectDomWatcher(): void {
  for (const obs of observers) obs.disconnect()
  observers.length = 0
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
  pendingParentIdxs.clear()
  pendingKinds.clear()
}
