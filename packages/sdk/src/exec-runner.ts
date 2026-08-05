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
    /** 使用原生 setter，绕过 React 等框架的受控组件保护 */
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) {
      setter.call(el, val)
    } else {
      el.value = val
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  /** 异步等待（exec code 中 await __clarosight_wait(100)） */
  w.__clarosight_wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** 取页面快照（exec code 也可手动调用） */
  w.__clarosight_snapshot = (): ReturnType<typeof takeSnapshot> => takeSnapshot()
}

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
    const ret = await fn()
    result = serializeResult(ret)
  } catch (e) {
    success = false
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
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
