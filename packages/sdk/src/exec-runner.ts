/**
 * exec 通道 —— 接收 server 下发的 JS 代码，在页面执行，回传结果
 *
 * 移植自 pilot 的 exec 设计，改 WS 主动下发：
 * 1. server 通过 WS 发 {type:'exec', execId, code}
 * 2. SDK 端用 new Function 执行 code（非 eval，隔离作用域）
 * 3. 执行期间 console 被单独捕获（startExecCapture / endExecCapture）
 * 4. 回传 {type:'exec-result', execId, result: ExecResult}
 *
 * 暴露给 AI 的页面级辅助函数（exec code 里可直接调用）：
 * - __clarosight_click(idx)
 * - __clarosight_setValue(idx, val)
 * - __clarosight_wait(ms)
 * - __clarosight_snapshot()
 */

import type { ServerToDeviceMessage, ExecResult } from '@clarosight/shared'
import { startExecCapture, endExecCapture } from './log-collector.js'
import { takeSnapshot, getElement } from './snapshot.js'
import { resolveOriginalPosition, resolveStack } from './source-map-helper.js'

/** exec 回调类型（由 ws-client 设置，负责 WS 回传） */
export type ExecHandler = (message: ServerToDeviceMessage) => void

let resultSender: ((execId: string, result: ExecResult) => void) | null = null

/** 注册 exec 结果回传器（ws-client 初始化时调用） */
export function setResultSender(sender: (execId: string, result: ExecResult) => void): void {
  resultSender = sender
}

/** 序列化 exec 返回值（限深限长，移植 pilot serializeResult） */
function serializeResult(val: unknown): string {
  try {
    return JSON.stringify(val, (_, v) => {
      if (typeof v === 'bigint') return String(v)
      if (typeof v === 'function') return `[fn]`
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }
      if (typeof v === 'object' && v !== null && typeof (v as { toISOString?: unknown }).toISOString === 'function') {
        return (v as { toISOString(): string }).toISOString()
      }
      return v
    }, 0)?.slice(0, 4000) ?? 'undefined'
  } catch (e) {
    return `[serialize failed: ${e instanceof Error ? e.message : String(e)}]`
  }
}

/**
 * 安装全局辅助函数（exec code 中可直接调用）
 * 必须在 exec 执行前就挂到 window，否则 new Function 作用域找不到
 */
export function installHelpers(): void {
  const w = window as unknown as Record<string, unknown>

  /**
   * 用原生 setter 设置 input/textarea 的 value
   *
   * 直接 el.value = x 在 React 等框架的受控组件上不生效（框架覆盖了 setter）。
   * 用原型链上的原生 setter（HTMLInputElement.prototype.value 的 setter）绕过。
   * setValue 和 type 共用此 helper，确保两者在 React/Vue 上行为一致。
   */
  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, val: string): void => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) {
      setter.call(el, val)
    } else {
      el.value = val
    }
  }

  /** 点击元素 */
  w.__clarosight_click = (idx: number): boolean => {
    const el = getElement(idx)
    if (!el) return false
    ;(el as HTMLElement).click()
    return true
  }

  /** 设置表单值（触发 input 事件，兼容 Vue/React v-model） */
  w.__clarosight_setValue = (idx: number, val: string): boolean => {
    const el = getElement(idx) as HTMLInputElement | undefined
    if (!el) return false
    setNativeValue(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  /**
   * 模拟键盘逐字输入（触发 keydown/keypress/input/keyup 序列）
   * 用于搜索框 autocomplete、监听 keyup 的场景，setValue 不够用时使用
   */
  w.__clarosight_type = (idx: number, text: string): boolean => {
    const el = getElement(idx) as HTMLInputElement | undefined
    if (!el) return false
    el.focus()
    setNativeValue(el, '')
    for (const ch of text) {
      /**
       * 逐字累加也要用原生 setter —— 直接 el.value += ch 在 React 受控组件上
       * 会被框架覆盖，导致输入不生效。每次累加后用 setNativeValue 写入完整值。
       */
      setNativeValue(el, el.value + ch)
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }))
    }
    return true
  }

  /** 异步等待（exec code 中 await __clarosight_wait(100)） */
  w.__clarosight_wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** 取页面快照（exec code 也可手动调用） */
  w.__clarosight_snapshot = (): ReturnType<typeof takeSnapshot> => takeSnapshot()

  /**
   * source map 解析：把压缩代码位置映射回原始源码位置
   * 用法：const pos = await __clarosight_sourcemap(line, col, sourceUrl?)
   * sourceUrl 省略时用当前页面 URL
   * 返回 { source, line, column, name? } 或 null
   */
  w.__clarosight_sourcemap = (
    line: number,
    col: number,
    sourceUrl?: string,
  ): Promise<import('@clarosight/shared').SourceMapPosition | null> =>
    resolveOriginalPosition(sourceUrl ?? location.href, line, col)

  /**
   * 批量解析堆栈帧（紧凑文本输出，AI 直接读）
   * 用法：const lines = await __clarosight_sourcemapStack([{url, line, col}, ...])
   */
  w.__clarosight_sourcemapStack = (
    frames: Array<{ url: string; line: number; col: number }>,
  ): Promise<string[]> => resolveStack(frames)
}

/**
 * SDK 端 exec 超时（ms），比 server 端（10s）早 1s 触发
 *
 * 异步永不 resolve 的代码（如 `return new Promise(() => {})`）会让 await fn() 永久挂起。
 * 若靠 server 端 10s 超时来兜底，server 会回"超时"给 AI，但 SDK 端的 promise 仍泄漏、
 * exec 日志捕获队列永不结束。SDK 端先于 server 触发，能干净地回传超时 + 释放资源。
 * 同步死循环（while(true){}）无法救——它阻塞主线程，连定时器都跑不了。
 */
const SDK_EXEC_TIMEOUT = 9000

/**
 * 处理 server 下发的 exec 指令
 * 异步执行 code，捕获 console，取快照，回传 ExecResult
 */
export async function handleExec(code: string, execId: string): Promise<void> {
  startExecCapture()
  let success = true
  let result: string | undefined
  let error: string | undefined

  try {
    /**
     * 把 code 作为 async 函数体执行 —— AI 可以写多条语句，自己决定 return 什么。
     * 辅助函数（__clarosight_click 等）已挂到 window，函数体内可直接访问。
     */
    const fn = new Function(`"use strict"; return (async () => {\n${code}\n})()`) as () => Promise<unknown>
    /**
     * 超时兜底 + 定时器清理
     *
     * 正常完成时必须 clearTimeout，否则：
     * 1. 定时器句柄泄漏 9s
     * 2. 超时 promise reject 时无人接住 → 触发 unhandledrejection →
     *    被 error-catcher 当成设备错误上报，污染 errorCount
     */
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('执行超时（SDK 9s）')), SDK_EXEC_TIMEOUT)
    })
    try {
      const ret = await Promise.race([fn(), timeoutPromise])
      result = serializeResult(ret)
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (e) {
    success = false
    /**
     * 错误信息增强：运行时错误附带 stack（截断 6 行），帮 AI 定位出错位置。
     * 语法错误（SyntaxError 无 stack）只返回 name: message。
     * stack 含压缩代码位置没关系——source map 解析能力已具备，AI 可进一步解析。
     */
    if (e instanceof Error) {
      error = `${e.name}: ${e.message}`
      if (e.stack) {
        const stackLines = e.stack.split('\n').slice(0, 6).join('\n')
        error += `\n${stackLines}`
      }
    } else {
      error = String(e)
    }
  }

  const logs = endExecCapture()

  /** exec 后自动取一次快照，让 AI 看到 操作后的页面变化 */
  let snapshotText: string | undefined
  if (success) {
    try {
      const snap = takeSnapshot()
      snapshotText = JSON.stringify(snap)
    } catch {
      /** 快照失败不影响 exec 结果回传 */
    }
  }

  resultSender?.(execId, { success, result, error, logs, snapshotText })
}
