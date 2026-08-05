/**
 * 全局错误捕获 —— 捕获运行时错误和未处理的 Promise rejection
 *
 * 两类来源：
 * 1. window 'error' 事件 —— 同步运行时错误、资源加载失败
 * 2. window 'unhandledrejection' 事件 —— 未 catch 的 Promise 错误
 *
 * 若错误带 source/line/col，会异步尝试 source map 解析（2s 超时），
 * 解析成功则 entry.mapped 填充原始源码位置，再上报。
 * 解析失败/超时则立即上报原始 entry，绝不阻塞错误采集。
 */

import type { ErrorEntry } from '@clarosight/shared'
import { resolveOriginalPosition } from './source-map-helper.js'

type ErrorSink = (entry: ErrorEntry) => void

/** 全局错误计数（用于 DeviceInfo.errorCount 上报） */
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
 * 安装全局错误捕获
 */
export function installErrorCatcher(sink: ErrorSink): void {
  window.addEventListener('error', (e: ErrorEvent) => {
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
  })

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
