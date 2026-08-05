/**
 * console 劫持 —— 移植自 pilot 的 log-collector
 *
 * 核心能力：
 * 1. 劫持 console.info/warn/error/debug/log，不破坏原行为
 * 2. 安全序列化（限深 3、限长 200 字符），防循环引用和巨型对象卡死
 * 3. 支持 exec 专属日志队列：exec 执行期间产生的日志被单独收集
 */

import type { LogEntry } from '@clarosight/shared'

/** 单条日志的内部收集回调 */
type LogSink = (entry: LogEntry) => void

/** exec 期间日志队列（exec-runner 设置，执行期间收集，结束后取走） */
let execQueue: string[] | null = null

/** 进入 exec 模式：此后的 console 输出同时入 execQueue */
export function startExecCapture(): void {
  execQueue = []
}

/** 结束 exec 模式，返回期间收集的日志（格式：[TYPE] message） */
export function endExecCapture(): string[] {
  const q = execQueue ?? []
  execQueue = null
  return q
}

/** 当前是否处于 exec 捕获模式 */
export function isCapturingExec(): boolean {
  return execQueue !== null
}

/**
 * 安装 console 劫持
 * @param sink 每条日志的接收回调（由 index 传入，负责 WS 上报）
 */
export function installLogCollector(sink: LogSink): void {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const original = {} as Record<string, typeof console.log>

  for (const m of methods) {
    original[m] = console[m].bind(console)
    console[m] = (...args: unknown[]) => {
      original[m](...args)
      const message = serialize(args)
      const type: LogEntry['type'] = m === 'log' ? 'info' : m
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        type,
        message,
      }
      sink(entry)
      /** exec 捕获模式：同时入队列 */
      if (execQueue) {
        execQueue.push(`[${type.toUpperCase()}] ${message}`)
      }
    }
  }
}

/**
 * 安全序列化参数数组 —— 限深限长防卡死
 * 移植自 pilot，简化为单行文本
 */
function serialize(args: unknown[]): string {
  return args.map((a) => stringify(a, 0)).join(' ')
}

/** 单值序列化，限深 depth、限长 maxLen */
function stringify(val: unknown, depth: number): string {
  if (depth > 3) return '...'
  if (val === null) return 'null'
  if (val === undefined) return 'undefined'

  const t = typeof val
  if (t === 'string') return truncate(val as string)
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(val)
  if (t === 'function') return `[fn ${(val as { name?: string }).name || 'anonymous'}]`
  if (t === 'symbol') return String(val)

  /** 对象/数组：限深展开 */
  try {
    if (val instanceof Error) {
      const e = val as Error
      return `${e.name}: ${truncate(e.message)}${e.stack ? '\n' + truncate(e.stack, 500) : ''}`
    }
    if (val instanceof Element) {
      return `<${(val as Element).tagName.toLowerCase()}>`
    }
    if (val instanceof Event) {
      return `[Event ${(val as Event).type}]`
    }
    if (Array.isArray(val)) {
      if (depth >= 3) return '[...]'
      const items = (val as unknown[]).slice(0, 10).map((v) => stringify(v, depth + 1))
      const ellipsis = val.length > 10 ? ', ...' : ''
      return `[${items.join(', ')}${ellipsis}]`
    }
    if (t === 'object') {
      if (depth >= 3) return '{...}'
      const obj = val as Record<string, unknown>
      const keys = Object.keys(obj).slice(0, 10)
      const pairs = keys.map((k) => {
        let v: unknown
        try {
          v = obj[k]
        } catch {
          v = '[getter error]'
        }
        return `${k}: ${stringify(v, depth + 1)}`
      })
      const ellipsis = Object.keys(obj).length > 10 ? ', ...' : ''
      return `{${pairs.join(', ')}${ellipsis}}`
    }
  } catch {
    return '[serialize error]'
  }
  return String(val)
}

/** 截断到 maxLen 字符，超出加省略号 */
function truncate(s: string, maxLen = 200): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen) + '…'
}
