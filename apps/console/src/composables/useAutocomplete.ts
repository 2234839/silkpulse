/**
 * useAutocomplete —— 远程设备实时代码补全 hook
 *
 * 和 DevTools console 一样：每次输入都实时探测远程真实环境，
 * 返回当前作用域可访问的对象/属性。
 *
 * 工作方式：
 * 1. 用户输入 → 防抖 150ms → 通过 exec 通道在远程设备执行探测代码
 * 2. root 模式（如输入 "loc"）：探测 window 所有可访问的全局变量名，过滤匹配 prefix 的
 * 3. property 模式（如输入 "document.quer"）：获取 document 的所有属性，过滤匹配 prefix 的
 * 4. 静态词表（JS 关键字 + 内置全局 + silkpulse 辅助函数）同步即时展示
 *
 * 缓存策略：property 模式按 expr 缓存（同一对象不重复探测），root 模式每次实时。
 */
import { ref } from 'vue'
import { apiFetch } from '../utils/api'

/** 单条补全建议 */
export interface CompletionItem {
  /** 补全文本（插入到光标位置） */
  text: string
  /** 显示标签 */
  label: string
  /** 类型标签 */
  kind: 'keyword' | 'global' | 'dom' | 'helper' | 'property'
  /** 类型描述（hover 显示） */
  detail?: string
}

/* ==================== 静态词表（即时展示） ==================== */

/** JS 关键字 */
const JS_KEYWORDS = [
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'async', 'await', 'of', 'true', 'false', 'null', 'undefined',
]

/** JS 内置全局对象/函数 */
const JS_GLOBALS = [
  'console', 'document', 'window', 'globalThis', 'navigator', 'location',
  'history', 'screen', 'localStorage', 'sessionStorage', 'indexedDB',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'Event', 'CustomEvent',
  'Math', 'JSON', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Symbol', 'Proxy', 'Reflect', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Function', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'BigInt', 'URL', 'URLSearchParams', 'FormData', 'Headers',
  'Request', 'Response', 'AbortController', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'btoa', 'atob', 'encodeURIComponent',
  'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'getComputedStyle', 'structuredClone',
]

/** silkpulse 辅助函数 */
const SILKPULSE_HELPERS = [
  '__silkpulse_click', '__silkpulse_setValue', '__silkpulse_type',
  '__silkpulse_pressKey', '__silkpulse_scroll', '__silkpulse_scrollIntoView',
  '__silkpulse_hover', '__silkpulse_wait', '__silkpulse_snapshot',
]

/** 静态补全项 */
const STATIC_ITEMS: CompletionItem[] = [
  ...JS_KEYWORDS.map((k) => ({ text: k, label: k, kind: 'keyword' as const })),
  ...JS_GLOBALS.map((g) => ({ text: g, label: g, kind: 'global' as const, detail: '内置全局' })),
  ...SILKPULSE_HELPERS.map((h) => ({ text: h, label: h, kind: 'helper' as const, detail: 'silkpulse 辅助函数' })),
]

/** 内置全局集合（探测时过滤掉这些） */
const BUILTIN_SET = new Set([...JS_GLOBALS, ...SILKPULSE_HELPERS, 'window', 'globalThis', 'self', 'top', 'parent', 'frames'])

/* ==================== 探测代码生成（eval 模式，不需要 return） ==================== */

/**
 * 生成 root 模式探测代码：获取远程 window 所有可访问全局变量名
 *
 * exec 现在是 eval 模式，代码作为 async IIFE 体执行，
 * 最后一行表达式作为返回值，所以不用写 return。
 */
function buildRootProbeCode(prefix: string): string {
  return `const builtin = new Set(${JSON.stringify([...BUILTIN_SET])});
const result = [];
try {
  for (const k of Object.getOwnPropertyNames(globalThis)) {
    if (builtin.has(k) || k.startsWith('_')) continue;
    try {
      const v = globalThis[k];
      if (v === undefined) continue;
      if (typeof v === 'function' || (typeof v === 'object' && v !== null) || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        result.push(k);
      }
    } catch {}
  }
} catch {}
try {
  for (const el of document.querySelectorAll('[id]')) {
    if (el.id) result.push('#' + el.id);
  }
  const cls = new Set();
  for (const el of document.querySelectorAll('[class]')) {
    for (const c of el.classList) { if (c) cls.add(c); }
  }
  for (const c of cls) result.push('.' + c);
} catch {}
JSON.stringify(result.filter(k => k.toLowerCase().startsWith(${JSON.stringify(prefix.toLowerCase())})).sort().slice(0, 30))`
}

/**
 * 生成 property 模式探测代码：获取远程对象 expr 的所有属性名
 *
 * expr 只含 [\w.$\]]（extractCompletionContext 保证），安全内嵌。
 */
function buildPropertyProbeCode(expr: string, prefix: string): string {
  return `(() => {
  try {
    const obj = ${expr};
    if (obj === null || obj === undefined) return JSON.stringify([]);
    const props = new Set();
    try { for (const k of Object.getOwnPropertyNames(obj)) props.add(k); } catch {}
    let proto = Object.getPrototypeOf(obj);
    let depth = 0;
    while (proto && depth < 5) {
      try {
        for (const k of Object.getOwnPropertyNames(proto)) {
          if (k !== 'constructor') props.add(k);
        }
      } catch {}
      proto = Object.getPrototypeOf(proto);
      depth++;
    }
    const arr = Array.from(props).filter(k => typeof k === 'string' && !/^\\d+$/.test(k) && k.toLowerCase().startsWith(${JSON.stringify(prefix.toLowerCase())}));
    return JSON.stringify(arr.sort().slice(0, 30));
  } catch { return JSON.stringify([]); }
})()`
}

/* ==================== 远程探测执行 ==================== */

/** 正在加载标记 */
const contextLoading = ref(false)

/** 属性缓存（expr → 属性名列表，避免同一对象重复探测） */
const propertyCache = new Map<string, string[]>()

/** 当前请求序号（快速输入时丢弃旧请求结果） */
let probeSeq = 0

/**
 * 执行远程探测，返回匹配的属性/变量名列表
 */
async function probeRemote(
  deviceId: string,
  mode: 'root' | 'property',
  expr: string,
  prefix: string,
): Promise<string[]> {
  if (!deviceId) return []
  const mySeq = ++probeSeq

  const code = mode === 'root'
    ? buildRootProbeCode(prefix)
    : buildPropertyProbeCode(expr, prefix)

  if (mode === 'property') {
    const cached = propertyCache.get(expr)
    if (cached) {
      return cached.filter((k) => k.toLowerCase().startsWith(prefix.toLowerCase())).slice(0, 30)
    }
  }

  contextLoading.value = true
  try {
    const res = await apiFetch(`/api/devices/${deviceId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const data = await res.json()
    if (mySeq !== probeSeq) return []

    if (data.success && data.result) {
      /** exec 双重 JSON 编码修正 */
      let parsed: unknown = JSON.parse(data.result)
      if (typeof parsed === 'string') parsed = JSON.parse(parsed)
      const list = Array.isArray(parsed) ? parsed as string[] : []
      if (mode === 'property' && list.length > 0) {
        propertyCache.set(expr, list)
      }
      return list
    }
  } catch {
    /** 静默 */
  } finally {
    if (mySeq === probeSeq) contextLoading.value = false
  }
  return []
}

/* ==================== 补全上下文解析 ==================== */

/**
 * 从输入文本提取补全上下文
 */
function extractCompletionContext(input: string, cursorPos: number): {
  mode: 'root'
  prefix: string
} | {
  mode: 'property'
  expr: string
  prefix: string
} | null {
  let i = cursorPos - 1
  while (i >= 0 && /[\w.$\]]/.test(input[i])) i--
  const token = input.slice(i + 1, cursorPos)
  if (!token) return null

  const beforeToken = i >= 0 ? input[i] : ''
  if (beforeToken === '"' || beforeToken === "'" || beforeToken === '`') return null

  const lastDot = token.lastIndexOf('.')
  if (lastDot === -1) {
    if (/^\d+$/.test(token)) return null
    return { mode: 'root', prefix: token }
  }

  let expr = token.slice(0, lastDot)
  const prefix = token.slice(lastDot + 1)
  expr = expr.replace(/\]$/, '').replace(/\[(['"]?)([\w]+)\1$/, '$2')
  if (!expr) return null
  return { mode: 'property', expr, prefix }
}

/* ==================== 对外 API ==================== */

/**
 * 获取补全建议（异步，每次都实时探测远程）
 *
 * @param onAsync 远程探测结果回调
 * @returns 同步立即可展示的补全列表（静态词表匹配）
 */
function getCompletions(
  input: string,
  cursorPos: number,
  deviceId: string,
  onAsync: (items: CompletionItem[]) => void,
): CompletionItem[] {
  const ctx = extractCompletionContext(input, cursorPos)
  if (!ctx) return []

  if (ctx.mode === 'root') {
    const lower = ctx.prefix.toLowerCase()
    const staticMatched = STATIC_ITEMS.filter(
      (item) => !lower || item.text.toLowerCase().startsWith(lower),
    ).slice(0, 10)

    probeRemote(deviceId, 'root', '', ctx.prefix).then((remoteKeys) => {
      const remoteItems: CompletionItem[] = remoteKeys.map((k) => {
        if (k.startsWith('#')) return { text: `getElementById('${k.slice(1)}')`, label: k, kind: 'dom' as const, detail: 'DOM id' }
        if (k.startsWith('.')) return { text: `querySelectorAll('${k}')`, label: k, kind: 'dom' as const, detail: 'DOM class' }
        return { text: k, label: k, kind: 'global' as const, detail: '远程变量' }
      })
      const all = [...remoteItems, ...staticMatched.filter((s) => !remoteItems.some((r) => r.text === s.text))]
      onAsync(all.slice(0, 20))
    })

    return staticMatched
  }

  probeRemote(deviceId, 'property', ctx.expr, ctx.prefix).then((props) => {
    const items: CompletionItem[] = props.map((k) => ({ text: k, label: k, kind: 'property' }))
    onAsync(items)
  })

  return []
}

/**
 * 将选中的补全建议应用到输入文本
 */
function applyCompletion(
  input: string,
  cursorPos: number,
  item: CompletionItem,
): { text: string; cursorPos: number } {
  const ctx = extractCompletionContext(input, cursorPos)
  if (!ctx) return { text: input, cursorPos }

  let start = cursorPos - 1
  while (start >= 0 && /[\w.$\]]/.test(input[start])) start--
  start++

  if (ctx.mode === 'root') {
    const before = input.slice(0, start)
    const after = input.slice(cursorPos)
    return { text: before + item.text + after, cursorPos: start + item.text.length }
  }

  const prefixStart = start + ctx.expr.length + 1
  const before = input.slice(0, prefixStart)
  const after = input.slice(cursorPos)
  return { text: before + item.text + after, cursorPos: prefixStart + item.text.length }
}

/** 设备切换时清空缓存 */
function clearCache(): void {
  propertyCache.clear()
  probeSeq++
}

export { getCompletions, applyCompletion, clearCache, contextLoading }
