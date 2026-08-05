/**
 * 全局错误捕获 —— 捕获运行时错误和未处理的 Promise rejection
 *
 * 三类来源区分处理：
 * 1. window 'error' 事件（JS 运行时错误）—— 上报为 error，计入 errorCount
 * 2. 资源加载失败（img/script/css 404 等）—— 不计入 errorCount，避免
 *    一个 404 图片就让设备亮红条、误导 AI 诊断。降级记入 recentErrors 供快照附带
 * 3. window 'unhandledrejection' —— 上报为 error，计入 errorCount
 *
 * 若错误带 source/line/col，会异步尝试 source map 解析（2s 超时），
 * 解析成功则 entry.mapped 填充原始源码位置，再上报。
 * 解析失败/超时则立即上报原始 entry，绝不阻塞错误采集。
 */

import type { ErrorEntry } from '@clarosight/shared'
import { resolveOriginalPosition } from './source-map-helper.js'

type ErrorSink = (entry: ErrorEntry) => void

/** 全局错误计数（仅 JS 运行时错误 + Promise rejection，不含资源加载失败） */
let errorCount = 0

/** 取当前错误总数（register 时上报，之后随 error 事件递增） */
export function getErrorCount(): number {
  return errorCount
}

/**
 * 尝试解析 source map，有 2s 超时兜底
 * 解析成功返回带 mapped 的 entry，失败/超时返回原始 entry
 */
async function tryResolveMap(entry: ErrorEntry): Promise<ErrorEntry> {
  if (!entry.source || !entry.line || !entry.col) return entry
  try {
    const mapped = await Promise.race([
      resolveOriginalPosition(entry.source, entry.line, entry.col),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ])
    return mapped ? { ...entry, mapped } : entry
  } catch {
    return entry
  }
}

/**
 * 判断 error 事件是否为资源加载失败（而非 JS 运行时错误）
 *
 * 资源加载失败（img/script/css 404 等）的特征：
 * - event.error 为 null（JS 错误时是 Error 实例）
 * - event.target 是元素（img/link/script），event.message 常为空或 "Error loading ..."
 *
 * 这类"错误"不应计入 errorCount（会误导诊断：一个 404 图片就让设备亮红条），
 * 但仍需记录，让 AI 知道有资源没加载到。
 */
function isResourceError(e: ErrorEvent): boolean {
  /** event.error 为 null 且 message 缺失 → 资源加载失败 */
  if (e.error == null && !e.message) return true
  /** event.target 是资源元素（非 document/window） */
  const target = e.target
  if (target && target instanceof Element) {
    const tag = target.tagName
    if (tag === 'IMG' || tag === 'LINK' || tag === 'SCRIPT' || tag === 'SOURCE' || tag === 'AUDIO' || tag === 'VIDEO') {
      return true
    }
  }
  return false
}

/**
 * 安装全局错误捕获
 */
export function installErrorCatcher(sink: ErrorSink): void {
  window.addEventListener('error', (e: ErrorEvent) => {
    /** 资源加载失败：降级处理，不计入 errorCount，不上报为 error（避免噪音） */
    if (isResourceError(e)) {
      const src = (e.target as Element | null)
      const url = src instanceof Element ? (src.getAttribute('src') || src.getAttribute('href') || src.tagName.toLowerCase()) : 'unknown'
      /** 资源失败只进 recentErrors（快照附带），不进 error 流，不污染 errorCount */
      pushResourceError?.(`资源加载失败: ${url}`)
      return
    }

    errorCount++
    const entry: ErrorEntry = {
      timestamp: new Date().toISOString(),
      message: e.message || 'Unknown error',
      stack: e.error instanceof Error ? e.error.stack : undefined,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
    }
    /** 有 source/line/col 时异步解析 source map（最多等 2s），否则立即上报 */
    if (entry.source && entry.line && entry.col) {
      tryResolveMap(entry).then(sink)
    } else {
      sink(entry)
    }
  }, true) /** 使用捕获阶段：资源加载失败的 error 事件不冒泡，必须捕获阶段才能收到 */

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    errorCount++
    const reason = e.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    const entry: ErrorEntry = {
      timestamp: new Date().toISOString(),
      message: `Unhandled rejection: ${message}`,
      stack: reason instanceof Error ? reason.stack : undefined,
    }
    sink(entry)
  })
}

/**
 * 资源加载失败回调（由 index 注入，转发给 snapshot 的 recentErrors）
 *
 * 默认空实现：只有 index 把 pushRecentError 注入进来才生效。
 * 这样 error-catcher 不直接依赖 snapshot，保持模块边界清晰。
 */
let pushResourceError: ((msg: string) => void) | null = null

/** 注入资源错误转发回调（index 初始化时调用） */
export function setResourceErrorHandler(handler: (msg: string) => void): void {
  pushResourceError = handler
}
