/**
 * console 劫持 —— 移植自 pilot 的 log-collector
 *
 * 核心能力：
 * 1. 劫持 console.info/warn/error/debug/log，不破坏原行为
 * 2. 安全序列化（限深 3、限长 200 字符），防循环引用和巨型对象卡死
 * 3. 支持 exec 专属日志队列：exec 执行期间产生的日志被单独收集
 * 4. 日志限流：滑动窗口防 log 爆炸打爆 WS/server（error 级不限流）
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
 * 日志限流器 —— 滑动窗口
 *
 * 被调试页面可能有 log 爆炸（死循环 console、第三方库狂刷日志），
 * 不限流会把 WS 带宽和 server 内存打爆。
 * 策略：
 * - 滑动窗口 1s 内最多 maxPerWindow 条（非 error 日志）
 * - error 级永远上报（它最关键，量也最小）
 * - 触发限流后，每秒补充上报一条汇总提示（让 AI/人知道丢了多少）
 */
class RateLimiter {
  /** 窗口内最大非 error 日志条数 */
  private readonly maxPerWindow: number
  /** 当前 1s 窗口内已放行的非 error 日志计数 */
  private count = 0
  /** 当前窗口被丢弃的条数 */
  private dropped = 0
  /** 当前窗口的起始时间戳（ms） */
  private windowStart = 0

  constructor(maxPerWindow = 50) {
    this.maxPerWindow = maxPerWindow
    this.windowStart = Date.now()
  }

  /**
   * 判断一条日志是否放行
   *
   * @param type 日志级别
   * @returns 'pass' 放行 / 'drop' 丢弃（由调用方决定如何处理）
   */
  check(type: LogEntry['type']): 'pass' | 'drop' {
    /** error 级不限流 */
    if (type === 'error') return 'pass'
    const now = Date.now()
    /** 滚动到新窗口 */
    if (now - this.windowStart >= 1000) {
      this.windowStart = now
      this.count = 0
    }
    if (this.count < this.maxPerWindow) {
      this.count++
      return 'pass'
    }
    this.dropped++
    return 'drop'
  }

  /** 取走并重置丢弃计数，返回需要上报的汇总条数（0 表示无需上报） */
  takeDropped(): number {
    const d = this.dropped
    this.dropped = 0
    return d
  }
}

/** 限流器单例（installLogCollector 时创建） */
let limiter: RateLimiter | null = null

/** 限流汇总上报回调（由 installLogCollector 注入） */
let droppedReporter: ((count: number) => void) | null = null

/** 定时器句柄（每秒检查是否有丢弃需上报） */
let droppedTimer: ReturnType<typeof setInterval> | null = null

/**
 * 安装 console 劫持
 * @param sink 每条日志的接收回调（由 index 传入，负责 WS 上报）
 */
export function installLogCollector(sink: LogSink): void {
  limiter = new RateLimiter(50)
  /** 限流汇总上报：每秒检查一次，有丢弃则发一条提示 */
  droppedReporter = (count: number) => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      type: 'warn',
      message: `[clarosight] 日志限流：过去 1s 内丢弃了 ${count} 条非 error 日志（error 级始终上报）`,
    }
    sink(entry)
  }
  if (droppedTimer) clearInterval(droppedTimer)
  droppedTimer = setInterval(() => {
    if (limiter) {
      const d = limiter.takeDropped()
      if (d > 0 && droppedReporter) droppedReporter(d)
    }
  }, 1000)

  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const original = {} as Record<string, typeof console.log>

  for (const m of methods) {
    original[m] = console[m].bind(console)
    console[m] = (...args: unknown[]) => {
      original[m](...args)
      const message = serialize(args)
      const type: LogEntry['type'] = m === 'log' ? 'info' : m

      /** exec 捕获模式：不限流，直接入队列（诊断代码的日志必须完整） */
      if (execQueue) {
        execQueue.push(`[${type.toUpperCase()}] ${message}`)
      }

      /** 上报前限流（error 不限流） */
      if (limiter && limiter.check(type) === 'drop') return

      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        type,
        message,
      }
      sink(entry)
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
