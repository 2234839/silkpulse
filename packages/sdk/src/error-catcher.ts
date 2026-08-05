/**
 * 全局错误捕获 —— 捕获运行时错误和未处理的 Promise rejection
 *
 * 两类来源：
 * 1. window 'error' 事件 —— 同步运行时错误、资源加载失败
 * 2. window 'unhandledrejection' 事件 —— 未 catch 的 Promise 错误
 */

import type { ErrorEntry } from '@clarosight/shared'

type ErrorSink = (entry: ErrorEntry) => void

/** 全局错误计数（用于 DeviceInfo.errorCount 上报） */
let errorCount = 0

/** 取当前错误总数（register 时上报，之后随 error 事件递增） */
export function getErrorCount(): number {
  return errorCount
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
    sink(entry)
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
