/**
 * console 劫持 —— 移植自 pilot 的 log-collector
 *
 * 核心能力：
 * 1. 劫持 console 全部方法（log/info/warn/error/debug/table/trace/group/groupEnd/
 *    groupCollapsed/count/countReset/time/timeEnd/timeLog/assert/dir/dirxml/clear），不破坏原行为
 * 2. 安全序列化（限深 3、限长 200 字符、WeakSet 循环引用标注、占位符 %s/%d/%o 替换），
 *    防循环引用和巨型对象卡死
 * 3. 特殊类型识别：Date/RegExp/Map/Set/Promise/TypedArray/ArrayBuffer/Error/DOM/Event
 * 4. 支持 exec 专属日志队列：exec 执行期间产生的日志被单独收集
 * 5. 日志限流：滑动窗口防 log 爆炸打爆 WS/server（error 级不限流）
 */

import type { LogEntry } from '@clarosight/shared'

/** 单条日志的内部收集回调 */
type LogSink = (entry: LogEntry) => void
/** 连续重复日志的回调（无 payload，语义：最后一条日志又重复了一次） */
type RepeatSink = () => void

/**
 * exec 期间日志队列上限
 *
 * exec 代码可能产生海量日志（如 for 循环 console.log 10 万次），不限流会
 * 撑爆 exec 结果的 WS 消息帧 + server 内存。
 *
 * 策略：保留头部前 100 条 + 尾部后 100 条，中间丢弃并标注省略数。
 * 头部是代码执行的早期输出（通常含关键诊断线索），尾部是最新的输出。
 */
const MAX_EXEC_HEAD = 100
const MAX_EXEC_TAIL = 100

/** exec 期间日志：头部队列（前 100 条） */
let execHead: string[] | null = null
/** exec 期间日志：尾部队列（最近 100 条，环形覆盖） */
let execTail: string[] | null = null
/** exec 期间日志总数（含被丢弃的，用于计算省略数） */
let execTotal = 0

/** 进入 exec 模式：此后的 console 输出同时入 exec 队列 */
export function startExecCapture(): void {
  execHead = []
  execTail = []
  execTotal = 0
}

/** 结束 exec 模式，返回期间收集的日志（格式：[TYPE] message） */
export function endExecCapture(): string[] {
  const head = execHead ?? []
  const tail = execTail ?? []
  const total = execTotal
  execHead = null
  execTail = null
  execTotal = 0
  /** 未超限：直接拼（head 就是全部） */
  if (total <= MAX_EXEC_HEAD) return head
  /** 超限：head + 省略标注 + tail */
  const dropped = total - head.length - tail.length
  return [...head, `…（省略 ${dropped} 条日志）`, ...tail]
}

/** 当前是否处于 exec 捕获模式 */
export function isCapturingExec(): boolean {
  return execHead !== null
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
 * @param repeatSink 连续重复日志回调（最后一条日志又重复一次时触发）
 */
export function installLogCollector(sink: LogSink, repeatSink: RepeatSink): void {
  limiter = new RateLimiter(50)
  /** 上一条放行上报的日志（type+message），用于检测连续重复 */
  let lastType: LogEntry['type'] | null = null
  let lastMessage = ''
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

  /** console.count 的计数器（label → 当前计数） */
  const countMap = new Map<string, number>()
  /** console.time 的计时器（label → 起始时间戳） */
  const timeMap = new Map<string, number>()

  /**
   * 统一的上报入口：所有劫持方法最终走这里
   *
   * 封装 exec 捕获、限流、重复聚合三个横切逻辑，让各方法的劫持体只关心自己的 message 生成。
   */
  function emit(type: LogEntry['type'], message: string, styledSegments?: { text: string; style?: string }[]): void {
    /** exec 捕获模式：不限流率，但限总量（防海量日志撑爆 WS 消息帧） */
    if (execHead && execTail) {
      const line = `[${type.toUpperCase()}] ${message}`
      execTotal++
      if (execHead.length < MAX_EXEC_HEAD) {
        execHead.push(line)
      } else {
        execTail.push(line)
        if (execTail.length > MAX_EXEC_TAIL) execTail.shift()
      }
    }

    /** 上报前限流（error 不限流） */
    if (limiter && limiter.check(type) === 'drop') return

    /**
     * 连续重复日志聚合（error 不参与，每条 error 都重要）。
     * group/groupEnd/clear 也不参与聚合（它们是结构控制信号，聚合会打乱层级）。
     */
    if (type !== 'error' && type !== 'group' && type !== 'groupEnd' && type !== 'clear'
      && lastType === type && lastMessage === message) {
      repeatSink()
      return
    }
    lastType = type
    lastMessage = message

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      type,
      message,
      /** 有 styledSegments 才挂到 entry（节省无样式日志的传输体积） */
      ...(styledSegments ? { styledSegments } : {}),
    }
    sink(entry)
  }

  /* ==================== 常规级别方法 ==================== */

  const levelMethods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const original = {} as Record<string, (...args: unknown[]) => void>

  for (const m of levelMethods) {
    original[m] = console[m].bind(console)
    console[m] = (...args: unknown[]) => {
      original[m](...args)
      const type: LogEntry['type'] = m === 'log' ? 'info' : m
      const { message, styledSegments } = serializeArgs(args)
      emit(type, message, styledSegments)
    }
  }

  /* ==================== table ==================== */

  original['table'] = console.table?.bind(console) ?? (() => {})
  console.table = (data?: unknown, columns?: string[]) => {
    original['table'](data, columns)
    /** table 数据序列化为文本表格（简化版：逐行展开，columns 参数只影响展示列，暂不实现列筛选） */
    let message: string
    if (Array.isArray(data)) {
      const rows = data.slice(0, 20).map((row, i) => `  [${i}]: ${stringify(row, 1, new WeakSet())}`)
      const ellipsis = data.length > 20 ? `\n  …（省略 ${data.length - 20} 行）` : ''
      message = `Table (${data.length} rows):\n${rows.join('\n')}${ellipsis}`
    } else if (data !== null && typeof data === 'object') {
      const entries = Object.entries(data as Record<string, unknown>).slice(0, 20)
      const rows = entries.map(([k, v]) => `  ${k}: ${stringify(v, 1, new WeakSet())}`)
      const ellipsis = Object.keys(data).length > 20 ? `\n  …（省略 ${Object.keys(data).length - 20} 个键）` : ''
      message = `Table (${Object.keys(data).length} keys):\n${rows.join('\n')}${ellipsis}`
    } else {
      message = `Table: ${stringify(data, 0, new WeakSet())}`
    }
    emit('table', message)
  }

  /* ==================== trace ==================== */

  original['trace'] = console.trace.bind(console)
  console.trace = (...args: unknown[]) => {
    original['trace'](...args)
    /** trace 的堆栈由浏览器原生 console.trace 输出到设备本地 console，
     *  我们这里用 Error().stack 抓一份上报（去掉前两帧：本函数 + emit 包装） */
    const prefix = args.length ? serialize(args) + '\n' : ''
    const stack = new Error().stack ?? ''
    const lines = stack.split('\n').slice(2).join('\n')
    emit('trace', `${prefix}Trace\n${lines}`)
  }

  /* ==================== group / groupEnd ==================== */

  original['group'] = console.group.bind(console)
  console.group = (...args: unknown[]) => {
    original['group'](...args)
    emit('group', args.length ? serialize(args) : 'group')
  }
  original['groupCollapsed'] = console.groupCollapsed.bind(console)
  console.groupCollapsed = (...args: unknown[]) => {
    original['groupCollapsed'](...args)
    /** groupCollapsed 归并为 group（前端不做折叠态区分，都按展开处理） */
    emit('group', args.length ? serialize(args) : 'group (collapsed)')
  }
  original['groupEnd'] = console.groupEnd.bind(console)
  console.groupEnd = () => {
    original['groupEnd']()
    emit('groupEnd', '')
  }

  /* ==================== count / countReset ==================== */

  original['count'] = console.count.bind(console)
  console.count = (label?: string) => {
    original['count'](label)
    const key = label ?? 'default'
    const n = (countMap.get(key) ?? 0) + 1
    countMap.set(key, n)
    emit('count', `${key}: ${n}`)
  }
  original['countReset'] = console.countReset.bind(console)
  console.countReset = (label?: string) => {
    original['countReset'](label)
    const key = label ?? 'default'
    countMap.delete(key)
    emit('count', `${key}: 0 (reset)`)
  }

  /* ==================== time / timeEnd / timeLog ==================== */

  original['time'] = console.time.bind(console)
  console.time = (label?: string) => {
    original['time'](label)
    const key = label ?? 'default'
    timeMap.set(key, performance.now())
    emit('time', `${key}: 计时开始`)
  }
  original['timeEnd'] = console.timeEnd.bind(console)
  console.timeEnd = (label?: string) => {
    original['timeEnd'](label)
    const key = label ?? 'default'
    const start = timeMap.get(key)
    if (start === undefined) {
      emit('time', `${key}: 计时器不存在`)
      return
    }
    timeMap.delete(key)
    emit('time', `${key}: ${(performance.now() - start).toFixed(2)}ms`)
  }
  original['timeLog'] = console.timeLog?.bind(console) ?? (() => {})
  console.timeLog = (label?: string, ...args: unknown[]) => {
    original['timeLog'](label, ...args)
    const key = label ?? 'default'
    const start = timeMap.get(key)
    if (start === undefined) {
      emit('time', `${key}: 计时器不存在`)
      return
    }
    const extra = args.length ? ' ' + serialize(args) : ''
    emit('time', `${key}: ${(performance.now() - start).toFixed(2)}ms${extra}`)
  }

  /* ==================== assert ==================== */

  original['assert'] = console.assert.bind(console)
  console.assert = (condition?: boolean, ...args: unknown[]) => {
    original['assert'](condition, ...args)
    /** 断言成功不上报（与 DevTools 行为一致：只有失败才输出） */
    if (condition) return
    const message = args.length ? serialize(args) : 'Assertion failed'
    emit('assert', `Assertion failed: ${message}`)
  }

  /* ==================== dir / dirxml ==================== */

  original['dir'] = console.dir.bind(console)
  console.dir = (obj?: unknown) => {
    original['dir'](obj)
    /** dir 的语义是"对象结构预览"，我们加深一层（4 层）比普通 log 更详细 */
    emit('dir', stringify(obj, 0, new WeakSet(), 4))
  }
  original['dirxml'] = console.dirxml?.bind(console) ?? (() => {})
  console.dirxml = (obj?: unknown) => {
    original['dirxml'](obj)
    emit('dir', stringify(obj, 0, new WeakSet(), 4))
  }

  /* ==================== clear ==================== */

  original['clear'] = console.clear.bind(console)
  console.clear = () => {
    original['clear']()
    emit('clear', '')
  }
}

/**
 * serializeArgs —— 安全序列化参数数组 + 占位符替换 + %c 样式提取
 *
 * 占位符规则（与 DevTools 对齐）：
 * - 第一个参数是 string 且含 %s/%d/%i/%f/%o/%O/%c 时，按顺序消费后续参数替换
 * - %c（CSS 样式）：消费后续参数作为 CSS 字符串，该样式作用于 %c 之后直到下一个 %c 的文本
 * - 多个 %c 叠加：后面的样式覆盖前面的同名属性（与 DevTools 一致）
 * - 替换剩余的参数继续拼接在后面（无样式）
 *
 * 返回 { message, styledSegments? }：
 * - message：纯文本（始终生成，作为搜索/复制/AI 上下文的事实标准）
 * - styledSegments：带样式信息的文本段（仅当存在 %c 时生成）
 */
interface SerializeResult {
  message: string
  styledSegments?: { text: string; style?: string }[]
}
function serializeArgs(args: unknown[]): SerializeResult {
  if (args.length === 0) return { message: '' }
  const first = args[0]
  /** 首参数非 string：无占位符，直接序列化 */
  if (typeof first !== 'string') {
    return { message: args.map((a) => stringify(a, 0, new WeakSet())).join(' ') }
  }

  /** 检测是否含占位符 */
  const formatRe = /%[sdifoOc]/g
  if (!formatRe.test(first)) {
    return { message: args.map((a) => stringify(a, 0, new WeakSet())).join(' ') }
  }

  /**
   * 逐段处理：把 format string 按 %c 拆成"普通段"和"样式切换点"
   *
   * 算法：
   * 1. 先用 formatRe 扫描，遇到 %s/%d/%i/%f/%o/%O 消费一个参数替换
   * 2. 遇到 %c 消费一个参数作为 CSS 字符串，在此处"切换当前样式"
   * 3. 切换样式后，之前的文本段闭合，新文本段用新样式
   * 4. 多个 %c 叠加：当前样式 = 之前所有 %c 的 CSS 合并（后者覆盖前者同名属性）
   */
  let argIndex = 1
  const seen = new WeakSet<object>()

  /** 当前累积的 CSS 样式（多个 %c 累加合并） */
  let currentStyle: Record<string, string> | null = null
  /** 输出文本段 */
  const segments: { text: string; style?: string }[] = []
  /** 当前段正在累积的文本 */
  let currentText = ''
  /** 是否出现过 %c（决定是否生成 styledSegments） */
  let hasStyleSpec = false

  /** 把 currentText flush 到 segments，用 currentStyle 标记 */
  function flushSegment() {
    if (currentText === '') return
    const styleStr = currentStyle ? cssObjectToString(currentStyle) : undefined
    segments.push({ text: currentText, style: styleStr })
    currentText = ''
  }

  /** 合并新的 CSS 到 currentStyle（后者覆盖前者同名属性） */
  function mergeStyle(css: string) {
    hasStyleSpec = true
    const parsed = parseCss(css)
    if (!currentStyle) {
      currentStyle = parsed
    } else {
      Object.assign(currentStyle, parsed)
    }
  }

  /** 用正则逐个匹配占位符，在匹配之间的 literal 文本原样累积 */
  formatRe.lastIndex = 0
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = formatRe.exec(first)) !== null) {
    const spec = match[0]
    const matchStart = match.index

    /** literal 文本（上一个匹配到此） */
    currentText += first.slice(lastIndex, matchStart)
    lastIndex = matchStart + 2

    if (spec === '%c') {
      /** %c：消费下一个参数作为 CSS */
      if (argIndex < args.length) {
        const css = String(args[argIndex++])
        /** 先 flush 当前段（用旧样式），再切换样式 */
        flushSegment()
        mergeStyle(css)
      }
    } else {
      /** %s/%d/%i/%f/%o/%O：消费下一个参数替换 */
      if (argIndex >= args.length) {
        currentText += spec
        continue
      }
      const val = args[argIndex++]
      switch (spec) {
        case '%s': currentText += String(val); break
        case '%d':
        case '%i': currentText += String(parseInt(String(val), 10)); break
        case '%f': currentText += String(parseFloat(String(val))); break
        case '%o':
        case '%O': currentText += stringify(val, 0, seen); break
      }
    }
  }
  /** 尾部 literal 文本 */
  currentText += first.slice(lastIndex)

  /** 剩余未被占位符消费的参数继续拼接（无样式） */
  const rest = args.slice(argIndex).map((a) => stringify(a, 0, seen))
  if (rest.length) {
    currentText += ' ' + rest.join(' ')
  }

  flushSegment()

  /** 拼纯文本 message */
  const message = segments.map((s) => s.text).join('')

  /** 有 %c 才生成 styledSegments */
  if (hasStyleSpec) {
    return { message, styledSegments: segments }
  }
  return { message }
}

/**
 * 解析 CSS 字符串为 { prop: value } 对象
 *
 * DevTools 支持的 CSS 属性子集（font-size/font-weight/color/background/padding 等），
 * 我们不白名单过滤——直接传给前端的 <span style>，浏览器自动忽略不支持的属性。
 */
function parseCss(css: string): Record<string, string> {
  const result: Record<string, string> = {}
  const declarations = css.split(';')
  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':')
    if (colonIdx === -1) continue
    const prop = decl.slice(0, colonIdx).trim().toLowerCase()
    const value = decl.slice(colonIdx + 1).trim()
    if (prop && value) {
      result[prop] = value
    }
  }
  return result
}

/** CSS 对象转回字符串（供前端 <span style> 使用） */
function cssObjectToString(obj: Record<string, string>): string {
  return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('; ')
}

/** 兼容旧调用（无 %c 场景，只取 message） */
function serialize(args: unknown[]): string {
  return serializeArgs(args).message
}

/**
 * 单值序列化，限深 maxDepth、限长 200 字符
 *
 * @param seen 当前递归路径上的祖先对象集合（WeakSet），用于检测循环引用。
 *             只检测"祖先链"循环：递归返回前 delete，兄弟节点共享同一对象不误判。
 *             例如 {a: obj, b: obj} 不会标 Circular（a 和 b 是兄弟），
 *             但 obj.self = obj 会标（self 在 obj 的祖先链上）。
 */
function stringify(val: unknown, depth: number, seen: WeakSet<object>, maxDepth = 3): string {
  if (depth > maxDepth) return '...'
  if (val === null) return 'null'
  if (val === undefined) return 'undefined'

  const t = typeof val
  if (t === 'string') return truncate(val as string)
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(val)
  if (t === 'function') return `[fn ${(val as { name?: string }).name || 'anonymous'}]`
  if (t === 'symbol') return String(val)

  /** 对象/数组：限深展开 + 循环引用标注 */
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
    if (val instanceof Date) {
      return isNaN(val.getTime()) ? 'Invalid Date' : val.toISOString()
    }
    if (val instanceof RegExp) {
      return String(val)
    }
    if (val instanceof Promise) {
      return 'Promise {<pending>}'
    }
    if (val instanceof Map) {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
      if (depth >= maxDepth) { seen.delete(val); return `Map(${val.size}) {...}` }
      const entries = [...val.entries()].slice(0, 10)
      const pairs = entries.map(([k, v]) => `${stringify(k, depth + 1, seen, maxDepth)} => ${stringify(v, depth + 1, seen, maxDepth)}`)
      const ellipsis = val.size > 10 ? ', ...' : ''
      seen.delete(val)
      return `Map(${val.size}) {${pairs.join(', ')}${ellipsis}}`
    }
    if (val instanceof Set) {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
      if (depth >= maxDepth) { seen.delete(val); return `Set(${val.size}) {...}` }
      const items = [...val.values()].slice(0, 10).map((v) => stringify(v, depth + 1, seen, maxDepth))
      const ellipsis = val.size > 10 ? ', ...' : ''
      seen.delete(val)
      return `Set(${val.size}) {${items.join(', ')}${ellipsis}}`
    }
    if (ArrayBuffer.isView(val)) {
      /** TypedArray / DataView：显示类型名 + 长度，内容太多不展开 */
      const name = val.constructor.name
      const len = (val as { length?: number }).length ?? (val as DataView).byteLength
      return `${name}(${len})`
    }
    if (val instanceof ArrayBuffer) {
      return `ArrayBuffer(${val.byteLength})`
    }
    if (Array.isArray(val)) {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
      if (depth >= maxDepth) { seen.delete(val); return '[...]' }
      const items = val.slice(0, 10).map((v) => stringify(v, depth + 1, seen, maxDepth))
      const ellipsis = val.length > 10 ? ', ...' : ''
      seen.delete(val)
      return `[${items.join(', ')}${ellipsis}]`
    }
    if (t === 'object') {
      if (seen.has(val as object)) return '[Circular]'
      seen.add(val as object)
      if (depth >= maxDepth) { seen.delete(val as object); return '{...}' }
      const obj = val as Record<string, unknown>
      const keys = Object.keys(obj).slice(0, 10)
      const pairs = keys.map((k) => {
        let v: unknown
        try {
          v = obj[k]
        } catch {
          v = '[getter error]'
        }
        return `${k}: ${stringify(v, depth + 1, seen, maxDepth)}`
      })
      const ellipsis = Object.keys(obj).length > 10 ? ', ...' : ''
      seen.delete(val as object)
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
