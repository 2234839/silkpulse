<script setup lang="ts">
/**
 * ToolsPanel —— Web Debug 工具箱
 *
 * 纯前端工具集合，不依赖远程设备，不需要选中设备即可使用。
 * 复用 ObjectInspector 组件做 JSON 可视化。
 *
 * 工具列表：
 * 1. JSON 可视化 + JQ 过滤
 * 2. SSE/JSONL 流分析器（带 Parser 变换）
 * 3. JWT 解码
 * 4. 编解码（Base64/URL/HTML Entity）
 * 5. 时间戳转换
 * 6. 正则测试
 * 7. Diff 对比
 */
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useResizable } from '../composables/useResizable'
import { diffLines, diffText, type TextDiffSegment } from '@silkpulse/renderer'
import ObjectInspector from './ObjectInspector.vue'

/** 工具页左右分栏宽度可拖拽 */
const { width: toolLeftWidth, onDragStart: onToolLeftResize } = useResizable({
  initial: 480,
  min: 280,
  max: 800,
  direction: 'right',
  storageKey: 'silkpulse.tools-left-width',
})

/** 工具 tab 列表 */
const tools = [
  { id: 'json', icon: '📦', label: 'JSON' },
  { id: 'stream', icon: '🌊', label: 'SSE/JSONL' },
  { id: 'jwt', icon: '🔑', label: 'JWT' },
  { id: 'codec', icon: '🔄', label: '编解码' },
  { id: 'timestamp', icon: '⏰', label: '时间戳' },
  { id: 'regex', icon: '🔍', label: '正则' },
  { id: 'diff', icon: '📋', label: 'Diff' },
] as const

const route = useRoute()
const router = useRouter()

/** 当前激活的工具 —— 初始值从 URL ?tool= 读取，支持复制链接直达 */
const activeTool = ref<typeof tools[number]['id']>(
  tools.some((t) => t.id === route.query.tool) ? (route.query.tool as typeof tools[number]['id']) : 'json',
)

/** URL → activeTool：外部导航（前进/后退/粘贴链接）时同步 */
watch(() => route.query.tool, (val) => {
  if (typeof val === 'string' && tools.some((t) => t.id === val)) {
    activeTool.value = val as typeof tools[number]['id']
  } else if (!val) {
    activeTool.value = 'json'
  }
})

/** activeTool → URL：点击切换时用 replace 不污染历史栈 */
watch(activeTool, (val) => {
  if (route.query.tool !== val) {
    router.replace({ query: { ...route.query, tool: val } })
  }
})

/* ════════ 1. JSON 可视化 + JQ ════════ */
const jsonInput = ref('')
const jsonJqFilter = ref('')

/** 解析模式：JSON（标准）/ JSONC（带注释+尾逗号）/ JSON5（更宽松） */
const jsonParseMode = ref<'json' | 'jsonc' | 'json5'>('json')

/**
 * 去除 JSONC 注释（不破坏字符串内的内容）
 *
 * 遍历每个字符，跟踪是否在字符串内部（及转义状态），
 * 遇到字符串外的单行或多行注释标记时跳过。
 */
function stripComments(text: string): string {
  let result = ''
  let i = 0
  /** 是否在字符串内部 */
  let inString = false
  /** 字符串的引号类型（双引号或单引号） */
  let quoteChar = ''

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]

    /** 转义字符：跳过下一位 */
    if (ch === '\\' && inString) {
      result += ch + (next ?? '')
      i += 2
      continue
    }

    /** 进入/退出字符串 */
    if ((ch === '"' || ch === "'") && !inString) {
      inString = true
      quoteChar = ch
      result += ch
      i++
      continue
    }
    if (ch === quoteChar && inString) {
      inString = false
      quoteChar = ''
      result += ch
      i++
      continue
    }

    if (!inString) {
      /** 单行注释 // */
      if (ch === '/' && next === '/') {
        /** 跳到行尾 */
        while (i < text.length && text[i] !== '\n') i++
        continue
      }
      /** 多行注释 /* */
      if (ch === '/' && next === '*') {
        i += 2
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
        i += 2
        continue
      }
    }

    result += ch
    i++
  }
  return result
}

/**
 * 去除尾逗号（},] 或 },} 前面多余的逗号）
 *
 * 在 stripComments 之后执行，此时注释已清除。
 */
function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([\]}])/g, '$1')
}

/**
 * JSON5 → 标准 JSON 的预处理
 *
 * 处理 JSON5 的核心扩展语法：
 * - 单引号字符串 → 双引号
 * - 无引号的对象 key → 加双引号
 * - 十六进制数字 (0x1F) → 十进制
 * - 前导/尾随小数点 (.5 → 0.5, 5. → 5.0)
 * - + 号开头的正数 (+42 → 42)
 * - Infinity / -Infinity / NaN
 */
function json5ToStandardJson(text: string): string {
  /** 先去注释和尾逗号 */
  let s = stripTrailingCommas(stripComments(text))

  /** 单引号字符串 → 双引号（逐字符遍历，正确处理转义） */
  s = s.replace(/(['"])((?:\\.|(?!\1).)*)\1/g, (_, q, content) => {
    if (q === '"') return _
    /** 单引号：反转义单引号，转义双引号 */
    const unescaped = content.replace(/\\'/g, "'").replace(/\\"/g, '"')
    /** 转义内嵌双引号 */
    const reEscaped = unescaped.replace(/"/g, '\\"')
    return '"' + reEscaped + '"'
  })

  /** 无引号的 key：{ key: → { "key": 或 , key: → , "key": */
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')

  /** 十六进制数字 → 十进制 */
  s = s.replace(/(^|[^\w.])-?(0x[0-9a-fA-F]+)/g, (_match, pre, hex) => {
    return pre + String(parseInt(hex, 16))
  })

  /** 前导小数点 .5 → 0.5 */
  s = s.replace(/(^|[^\w.])\.(\d)/g, '$10.$2')

  /** + 开头正数 → 去掉 + */
  s = s.replace(/([:{,\[\s])\+(\d)/g, '$1$2')

  /** Infinity / -Infinity / NaN → null（JSON 不支持） */
  s = s.replace(/(^|[^\w])Infinity/g, '$1null').replace(/(^|[^\w])-Infinity/g, '$1null')
  s = s.replace(/(^|[^\w])NaN/g, '$1null')

  return s
}

/** 根据当前模式解析 JSON */
function parseByMode(text: string): unknown {
  switch (jsonParseMode.value) {
    case 'json':
      return JSON.parse(text)
    case 'jsonc':
      return JSON.parse(stripTrailingCommas(stripComments(text)))
    case 'json5':
      return JSON.parse(json5ToStandardJson(text))
  }
}

/** 当前模式下的输入框 placeholder */
const jsonPlaceholder = computed(() => {
  if (jsonParseMode.value === 'jsonc') {
    return '// 配置文件\n{\n  "name": "silkpulse",\n  "debug": true,\n}'
  }
  if (jsonParseMode.value === 'json5') {
    return "// JSON5\n{\n  name: 'silkpulse',\n  items: [1, 2, 3,]\n}"
  }
  return '{"name":"silkpulse","items":[{"id":1,"msg":"hello"}]}'
})

/** 当前模式的提示文案 */
const jsonModeHint = computed(() => {
  if (jsonParseMode.value === 'jsonc') return 'JSONC：支持单行/多行注释、尾逗号'
  if (jsonParseMode.value === 'json5') return 'JSON5：支持注释、单引号、无引号 key、尾逗号、十六进制'
  return '语法：.key 取字段，.arr[] 遍历数组，.a.b 嵌套路径'
})

/** 应用 JQ 风格路径表达式 */
function applyJq(data: unknown, expr: string): unknown {
  let cur = data
  /** 按 . 和 [] 拆分路径段 */
  const tokens = expr.match(/\.(\w+)|\[(\d+)\]|\[\]/g)
  if (!tokens) return cur
  for (const tok of tokens) {
    if (tok === '[]') {
      if (!Array.isArray(cur)) throw new Error('[] 只能用于数组')
      /** 剩余路径递归应用于每个元素 */
      const restExpr = expr.slice(expr.indexOf('[]') + 2)
      if (!restExpr) return cur
      return cur.map((item) => applyJq(item, restExpr))
    }
    const key = tok.startsWith('.') ? tok.slice(1) : tok.slice(1, -1)
    cur = (cur as Record<string, unknown>)[key]
    if (cur === undefined) throw new Error(`路径 "${tok}" 无值`)
  }
  return cur
}

const jsonParsed = computed(() => {
  if (!jsonInput.value.trim()) return undefined
  try {
    let parsed: unknown = parseByMode(jsonInput.value)
    const jq = jsonJqFilter.value.trim()
    if (jq && jq.startsWith('.')) {
      parsed = applyJq(parsed, jq)
    }
    return { ok: true as const, data: parsed }
  } catch (e) {
    return { ok: false as const, error: (e as Error).message }
  }
})

/* ════════ 2. SSE/JSONL 流分析器 ════════ */
const streamInput = ref('')
const streamMode = ref<'sse' | 'jsonl' | 'raw'>('sse')
const streamFilter = ref('')
const streamParserCode = ref('')
const streamParserOpen = ref(false)

/** 解析 SSE 文本块 */
function parseSse(text: string) {
  const events: { data: string; type: string; id: string }[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const ev = { data: '', type: '', id: '' }
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (!line.trim() || line.startsWith(':')) continue
      const ci = line.indexOf(':')
      const field = ci > 0 ? line.slice(0, ci) : ''
      const val = ci > 0 ? line.slice(ci + 1).replace(/^ /, '') : line
      if (field === 'data') dataLines.push(val)
      else if (field === 'event') ev.type = val
      else if (field === 'id') ev.id = val
      else dataLines.push(line)
    }
    ev.data = dataLines.join('\n')
    if (ev.data || ev.type) events.push(ev)
  }
  return events
}

/** 解析 JSONL */
function parseJsonl(text: string) {
  const events: { data: string; type: string; id: string }[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      events.push({
        data: JSON.stringify(obj),
        type: String(obj.level || obj.type || ''),
        id: String(obj.id ?? obj.ts ?? ''),
      })
    } catch {
      events.push({ data: line, type: '', id: '' })
    }
  }
  return events
}

const streamEvents = computed(() => {
  const input = streamInput.value.trim()
  if (!input) return []
  if (streamMode.value === 'sse') return parseSse(input)
  if (streamMode.value === 'jsonl') return parseJsonl(input)
  return input.split('\n').filter((l) => l.trim()).map((l) => ({ data: l, type: '', id: '' }))
})

/** Parser 函数编译 */
let compiledParser: ((data: string) => unknown) | null = null
const streamParserError = ref('')
watch(streamParserCode, (code) => {
  const trimmed = code.trim()
  if (!trimmed) { compiledParser = null; streamParserError.value = ''; return }
  try {
    compiledParser = new Function('data', code) as (data: string) => unknown
    streamParserError.value = ''
  } catch (e) {
    compiledParser = null
    streamParserError.value = (e as Error).message
  }
}, { immediate: true })

/** 处理后的流事件（应用 filter + parser） */
const processedStreamEvents = computed(() => {
  const q = streamFilter.value.trim().toLowerCase()
  const result: { type: string; id: string; display: string; parseError?: string }[] = []
  for (const e of streamEvents.value) {
    if (q && !e.data.toLowerCase().includes(q) && !e.type.toLowerCase().includes(q)) continue
    if (!compiledParser) {
      result.push({ type: e.type, id: e.id, display: e.data })
      continue
    }
    try {
      const r = compiledParser(e.data)
      result.push({ type: e.type, id: e.id, display: typeof r === 'string' ? r : JSON.stringify(r, null, 2) })
    } catch (e2) {
      result.push({ type: e.type, id: e.id, display: e.data, parseError: (e2 as Error).message })
    }
  }
  return result
})

const sseSample = `event: message
data: {"ts":"2026-08-09T06:00:00Z","level":"info","msg":"服务启动"}

event: update
id: 1
data: {"ts":"2026-08-09T06:00:01Z","level":"info","msg":"收到请求","path":"/api/users"}

event: error
id: 2
data: {"ts":"2026-08-09T06:00:02Z","level":"error","msg":"数据库超时","code":"DB_TIMEOUT"}

event: done
data: [DONE]`

const jsonlSample = `{"ts":"2026-08-09T06:00:00Z","level":"info","msg":"服务启动","pid":1234}
{"ts":"2026-08-09T06:00:01Z","level":"info","msg":"收到请求","path":"/api/users","duration":45}
{"ts":"2026-08-09T06:00:02Z","level":"error","msg":"数据库超时","code":"DB_TIMEOUT","duration":5000}
{"ts":"2026-08-09T06:00:03Z","level":"warn","msg":"重连成功","retry":2}`

/* ════════ 3. JWT 解码 ════════ */
const jwtInput = ref('')

const jwtDecoded = computed(() => {
  const token = jwtInput.value.trim()
  if (!token || token.split('.').length < 2) return null
  try {
    const parts = token.split('.')
    const decode = (s: string): Record<string, unknown> => {
      const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=')
      return JSON.parse(atob(padded))
    }
    const header = decode(parts[0])
    const payload = decode(parts[1])
    let expTime: string | null = null
    let expired = false
    if (payload.exp && typeof payload.exp === 'number') {
      expTime = new Date(payload.exp * 1000).toLocaleString('zh-CN')
      expired = payload.exp * 1000 < Date.now()
    }
    return { header, payload, expTime, expired }
  } catch {
    return null
  }
})

/* ════════ 4. 编解码 ════════ */
const codecModes = ['Base64', 'URL', 'URI Component', 'HTML Entity'] as const
const codecMode = ref<typeof codecModes[number]>('Base64')
const codecInput = ref('')
const codecResult = ref('')
const codecError = ref('')

function doEncode() {
  codecError.value = ''
  try {
    const s = codecInput.value
    switch (codecMode.value) {
      case 'Base64': codecResult.value = btoa(unescape(encodeURIComponent(s))); break
      case 'URL': codecResult.value = encodeURI(s); break
      case 'URI Component': codecResult.value = encodeURIComponent(s); break
      case 'HTML Entity': codecResult.value = s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); break
    }
  } catch (e) { codecError.value = (e as Error).message }
}

function doDecode() {
  codecError.value = ''
  try {
    const s = codecInput.value
    switch (codecMode.value) {
      case 'Base64': codecResult.value = decodeURIComponent(escape(atob(s))); break
      case 'URL': codecResult.value = decodeURI(s); break
      case 'URI Component': codecResult.value = decodeURIComponent(s); break
      case 'HTML Entity': {
        const el = document.createElement('div')
        el.innerHTML = s
        codecResult.value = el.textContent ?? ''
        break
      }
    }
  } catch (e) { codecError.value = (e as Error).message }
}

/* ════════ 5. 时间戳 ════════ */
const tsInput = ref('')
const tsResult = ref<{ local: string; utc: string; iso: string; relative: string } | null>(null)

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + '秒'
  if (s < 3600) return Math.floor(s / 60) + '分钟'
  if (s < 86400) return Math.floor(s / 3600) + '小时'
  return Math.floor(s / 86400) + '天'
}

function convertTs() {
  const raw = tsInput.value.trim()
  if (!raw || isNaN(Number(raw))) { tsResult.value = null; return }
  let num = Number(raw)
  if (raw.length <= 10) num *= 1000
  const d = new Date(num)
  if (isNaN(d.getTime())) { tsResult.value = null; return }
  const diff = Date.now() - num
  const rel = diff > 0 ? `${humanDuration(Math.abs(diff))} 前` : `${humanDuration(Math.abs(diff))} 后`
  tsResult.value = { local: d.toLocaleString('zh-CN'), utc: d.toUTCString(), iso: d.toISOString(), relative: rel }
}

const dateInput = ref('')
const dateResult = ref<{ ms: number; s: number } | null>(null)

function convertDate() {
  if (!dateInput.value.trim()) { dateResult.value = null; return }
  const d = new Date(dateInput.value)
  if (isNaN(d.getTime())) { dateResult.value = null; return }
  dateResult.value = { ms: d.getTime(), s: Math.floor(d.getTime() / 1000) }
}

/* ════════ 6. 正则测试 ════════ */
const regexPattern = ref('')
const regexFlags = ref('g')
const regexInput = ref('')
const regexReplace = ref('')

const regexError = computed(() => {
  if (!regexPattern.value) return ''
  try { new RegExp(regexPattern.value, regexFlags.value); return '' } catch (e) { return (e as Error).message }
})

const regexMatches = computed(() => {
  if (!regexPattern.value || !regexInput.value || regexError.value) return null
  try {
    const flags = regexFlags.value.includes('g') ? regexFlags.value : regexFlags.value + 'g'
    const re = new RegExp(regexPattern.value, flags)
    const ms: { full: string; index: number; groups: string[] }[] = []
    let m: RegExpExecArray | null
    let count = 0
    while ((m = re.exec(regexInput.value)) !== null && count < 500) {
      ms.push({ full: m[0], index: m.index, groups: m.slice(1) })
      if (m.index === re.lastIndex) re.lastIndex++
      count++
    }
    return ms
  } catch { return null }
})

const regexResult = computed(() => {
  if (!regexPattern.value || !regexInput.value || !regexReplace.value || regexError.value) return null
  try {
    const flags = regexFlags.value.includes('g') ? regexFlags.value : regexFlags.value + 'g'
    return regexInput.value.replace(new RegExp(regexPattern.value, flags), regexReplace.value)
  } catch { return null }
})

/* ════════ 7. Diff 对比 ════════ */
const diffA = ref('')
const diffB = ref('')
const diffJsonMode = ref(true)
/** 视图模式：inline=上下合并显示，split=左右并排 */
const diffViewMode = ref<'inline' | 'split'>('inline')
/** 字符级高亮：对变化的行进一步标出具体改了哪些字符 */
const diffCharLevel = ref(true)
/** 折叠连续未变化行（只保留首尾各 2 行上下文） */
const diffCollapseSame = ref(true)

/** 一行 diff 数据（行级） */
interface DiffLine {
  /** 行类型：equal=add=del */
  type: 'equal' | 'add' | 'del'
  /** 行文本（不含换行符） */
  text: string
  /** 旧文件行号（1-based，del/equal 有值，add 为 null） */
  oldNum: number | null
  /** 新文件行号（1-based，add/equal 有值，del 为 null） */
  newNum: number | null
  /** 字符级 inline diff（仅 add/del 行且启用字符级时有值） */
  charDiff?: TextDiffSegment[]
}

/**
 * 计算 diff 结果
 *
 * 算法：先用 diffLines 做行级 LCS（解决行错位问题），
 * 再对相邻的 del+add 行对做字符级 diffText（标出具体改了哪些字符）。
 */
const diffResult = computed<DiffLine[]>(() => {
  let a = diffA.value
  let b = diffB.value
  if (!a && !b) return []
  if (diffJsonMode.value) {
    try { a = JSON.stringify(JSON.parse(a), null, 2) } catch { /* keep raw */ }
    try { b = JSON.stringify(JSON.parse(b), null, 2) } catch { /* keep raw */ }
  }

  /** 行级 LCS diff */
  const lineSegs = diffLines(a, b)

  /** 展开为逐行 DiffLine，分配行号 */
  const lines: DiffLine[] = []
  let oldNum = 0
  let newNum = 0

  for (const seg of lineSegs) {
    /** 按 \n 切分，去掉末尾空串（最后一段可能没有换行符） */
    const segLines = seg.text.split('\n')
    /** split('\n') 在末尾有换行时会产生空串，去掉它 */
    if (seg.text.endsWith('\n')) segLines.pop()

    for (const lineText of segLines) {
      switch (seg.op) {
        case 'equal':
          oldNum++
          newNum++
          lines.push({ type: 'equal', text: lineText, oldNum, newNum })
          break
        case 'removed':
          oldNum++
          lines.push({ type: 'del', text: lineText, oldNum, newNum: null })
          break
        case 'added':
          newNum++
          lines.push({ type: 'add', text: lineText, oldNum: null, newNum })
          break
      }
    }
  }

  /**
   * 字符级 diff：对配对的 del+add 行做 inline char diff。
   *
   * 配对策略：找到所有连续的「del 块 + add 块」（不论顺序），
   * 按位置逐对做 diffText，让用户在同一行内看到具体改了哪些字符。
   * del 和 add 的相对顺序由 LCS 回溯决定，可能 del 在前也可能 add 在前。
   */
  if (diffCharLevel.value) {
    let i = 0
    while (i < lines.length) {
      /** 跳过 equal 行 */
      if (lines[i].type === 'equal') {
        i++
        continue
      }
      /** 收集连续的非 equal 行（del 和 add 混合） */
      const blockStart = i
      while (i < lines.length && lines[i].type !== 'equal') i++
      const block = lines.slice(blockStart, i)

      /** 从块中分离 del 和 add */
      const dels = block.filter((l) => l.type === 'del')
      const adds = block.filter((l) => l.type === 'add')

      /** 按位置配对做字符级 diff */
      const pairs = Math.min(dels.length, adds.length)
      for (let p = 0; p < pairs; p++) {
        const charDiff = diffText(dels[p].text, adds[p].text)
        dels[p].charDiff = charDiff
        adds[p].charDiff = charDiff
      }
    }
  }

  return lines
})

/** diff 统计信息 */
const diffStats = computed(() => {
  const lines = diffResult.value
  let added = 0
  let removed = 0
  let unchanged = 0
  for (const line of lines) {
    if (line.type === 'add') added++
    else if (line.type === 'del') removed++
    else unchanged++
  }
  return { added, removed, unchanged, total: lines.length }
})

/**
 * 折叠后的 diff 行列表（inline 模式）
 *
 * 连续超过 4 行的 equal 段只保留首尾各 2 行。
 * 连续的 del+add 块按位置交叉排列（del[0],add[0],del[1],add[1]...），
 * 让用户能直观对比「同一行的旧→新」。
 */
const diffCollapsedInline = computed(() => {
  const lines = diffResult.value

  type CollapsedItem =
    | { kind: 'line'; line: DiffLine }
    | { kind: 'collapse'; count: number }

  const CONTEXT = 2
  const result: CollapsedItem[] = []
  let hiddenTotal = 0

  let i = 0
  while (i < lines.length) {
    if (lines[i].type === 'equal') {
      let j = i
      while (j < lines.length && lines[j].type === 'equal') j++
      const equalLen = j - i
      if (diffCollapseSame.value && equalLen > CONTEXT * 2 + 1) {
        for (let k = i; k < i + CONTEXT; k++) result.push({ kind: 'line', line: lines[k] })
        const hiddenCount = equalLen - CONTEXT * 2
        result.push({ kind: 'collapse', count: hiddenCount })
        hiddenTotal += hiddenCount
        for (let k = j - CONTEXT; k < j; k++) result.push({ kind: 'line', line: lines[k] })
      } else {
        for (let k = i; k < j; k++) result.push({ kind: 'line', line: lines[k] })
      }
      i = j
    } else {
      /** 收集连续非 equal 块 */
      const blockStart = i
      while (i < lines.length && lines[i].type !== 'equal') i++
      const block = lines.slice(blockStart, i)
      const dels = block.filter((l) => l.type === 'del')
      const adds = block.filter((l) => l.type === 'add')

      /** 交叉排列：del[0],add[0],del[1],add[1]... */
      const pairs = Math.min(dels.length, adds.length)
      for (let p = 0; p < pairs; p++) {
        result.push({ kind: 'line', line: dels[p] })
        result.push({ kind: 'line', line: adds[p] })
      }
      for (let p = pairs; p < dels.length; p++) result.push({ kind: 'line', line: dels[p] })
      for (let p = pairs; p < adds.length; p++) result.push({ kind: 'line', line: adds[p] })
    }
  }

  return { lines: result, hiddenCount: hiddenTotal }
})

/**
 * 折叠后的 diff 行列表（split 模式）
 *
 * 与 inline 相同的折叠逻辑，但不交叉排列 del/add。
 */
const diffCollapsed = computed(() => {
  const lines = diffResult.value

  type CollapsedItem =
    | { kind: 'line'; line: DiffLine }
    | { kind: 'collapse'; count: number }

  const CONTEXT = 2
  const result: CollapsedItem[] = []
  let hiddenTotal = 0

  let i = 0
  while (i < lines.length) {
    if (lines[i].type === 'equal') {
      let j = i
      while (j < lines.length && lines[j].type === 'equal') j++
      const equalLen = j - i
      if (diffCollapseSame.value && equalLen > CONTEXT * 2 + 1) {
        for (let k = i; k < i + CONTEXT; k++) result.push({ kind: 'line', line: lines[k] })
        const hiddenCount = equalLen - CONTEXT * 2
        result.push({ kind: 'collapse', count: hiddenCount })
        hiddenTotal += hiddenCount
        for (let k = j - CONTEXT; k < j; k++) result.push({ kind: 'line', line: lines[k] })
      } else {
        for (let k = i; k < j; k++) result.push({ kind: 'line', line: lines[k] })
      }
      i = j
    } else {
      result.push({ kind: 'line', line: lines[i] })
      i++
    }
  }

  return { lines: result, hiddenCount: hiddenTotal }
})

/**
 * 提取 charDiff 中指定 op 的文本段（用于渲染）
 *
 * del 行只渲染 removed + equal 段（红底），
 * add 行只渲染 added + equal 段（绿底）。
 */
function charDiffParts(line: DiffLine): TextDiffSegment[] {
  if (!line.charDiff) return [{ op: 'equal', text: line.text }]
  const wantRemoved = line.type === 'del'
  return line.charDiff.filter((seg) =>
    seg.op === 'equal' || (wantRemoved ? seg.op === 'removed' : seg.op === 'added')
  )
}
</script>

<template>
  <div class="h-screen flex flex-col overflow-hidden">
    <!-- 顶部栏 -->
    <header class="bg-gray-900 text-white px-4 py-2.5 flex items-center gap-4 flex-shrink-0">
      <h1 class="text-base font-semibold">🔧 SilkPulse Tools</h1>
      <span class="text-xs text-gray-400">Web Debug 工具箱 · 纯前端 · 数据不出域</span>
      <div class="ml-auto flex items-center gap-3">
        <router-link to="/" class="text-xs text-blue-400 hover:text-blue-300">← 控制台</router-link>
      </div>
    </header>

    <!-- 工具切换栏 -->
    <nav class="flex border-b border-base bg-surface overflow-x-auto flex-shrink-0">
      <button
        v-for="t in tools"
        :key="t.id"
        @click="activeTool = t.id"
        class="px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap flex items-center gap-1.5"
        :class="activeTool === t.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-muted hover:text-primary'"
      >{{ t.icon }} {{ t.label }}</button>
    </nav>

    <!-- 工具内容 -->
    <div class="flex-1 overflow-y-auto p-4">

      <!-- ════════ JSON 可视化 ════════ -->
      <div v-if="activeTool === 'json'" class="flex h-full max-h-[calc(100vh-160px)]">
        <div class="flex flex-col gap-2 min-w-0 flex-shrink-0" :style="{ width: toolLeftWidth + 'px' }">
          <div class="flex items-center gap-2">
            <label class="text-xs text-muted">输入</label>
            <div class="ml-auto flex items-center gap-1">
              <button
                v-for="m in [
                  { id: 'json', label: 'JSON' },
                  { id: 'jsonc', label: 'JSONC' },
                  { id: 'json5', label: 'JSON5' },
                ]"
                :key="m.id"
                @click="jsonParseMode = m.id as 'json' | 'jsonc' | 'json5'"
                class="px-2 py-0.5 text-xs rounded border transition-colors"
                :class="jsonParseMode === m.id
                  ? 'border-blue-500 text-blue-500 bg-blue-500/10'
                  : 'border-base text-muted hover:text-primary'"
              >{{ m.label }}</button>
            </div>
          </div>
          <textarea
            v-model="jsonInput"
            rows="20"
            spellcheck="false"
            class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
            :placeholder="jsonPlaceholder"
          ></textarea>
          <div class="flex gap-2 items-center">
            <input
              v-model="jsonJqFilter"
              type="text"
              spellcheck="false"
              class="flex-1 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
              placeholder="JQ 过滤（如 .items[].msg）"
            />
          </div>
          <p class="text-xs text-faint">{{ jsonModeHint }}</p>
        </div>
        <!-- 拖拽手柄 -->
        <div
          class="w-1 cursor-col-resize bg-base hover:bg-blue-400/40 active:bg-blue-500 transition-colors flex-shrink-0 mx-1"
          @mousedown="onToolLeftResize"
        />
        <div class="flex-1 overflow-auto min-w-0">
          <label class="text-xs text-muted block mb-2">可视化结果</label>
          <div v-if="jsonParsed?.ok" class="bg-surface border border-base rounded p-3">
            <ObjectInspector :raw="jsonParsed.data" />
          </div>
          <div v-else-if="jsonParsed && !jsonParsed.ok" class="text-red-500 text-xs p-3 bg-red-500/10 border border-red-500/30 rounded">
            ⚠ {{ jsonParsed.error }}
          </div>
          <div v-else class="text-xs text-faint">输入 JSON 后自动渲染...</div>
        </div>
      </div>

      <!-- ════════ SSE/JSONL 流分析器 ════════ -->
      <div v-else-if="activeTool === 'stream'" class="flex gap-4 h-full max-h-[calc(100vh-160px)]">
        <div class="flex-1 flex flex-col gap-2 min-w-0">
          <label class="text-xs text-muted">输入流</label>
          <textarea
            v-model="streamInput"
            rows="16"
            spellcheck="false"
            class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
            placeholder="event: message&#10;data: {&quot;msg&quot;:&quot;hello&quot;}"
          ></textarea>
          <div class="flex gap-2 items-center">
            <select v-model="streamMode" class="bg-input border border-base rounded px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-blue-500">
              <option value="sse">SSE (data:/event:)</option>
              <option value="jsonl">JSONL (逐行 JSON)</option>
              <option value="raw">Raw (逐行文本)</option>
            </select>
            <input
              v-model="streamFilter"
              type="text"
              spellcheck="false"
              class="flex-1 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
              placeholder="🔍 过滤关键词..."
            />
          </div>
          <div class="flex gap-2 items-center">
            <button
              @click="streamParserOpen = !streamParserOpen"
              class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
              :class="{ 'text-blue-500 border-blue-500': streamParserOpen || streamParserCode }"
            >⚡ Parser</button>
            <button @click="streamInput = sseSample" class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500">📋 SSE 示例</button>
            <button @click="streamInput = jsonlSample" class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500">📋 JSONL 示例</button>
            <span class="text-xs text-faint ml-auto">{{ streamEvents.length }} 条</span>
          </div>
          <div v-if="streamParserOpen">
            <textarea
              v-model="streamParserCode"
              rows="3"
              spellcheck="false"
              class="w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
              placeholder="// 参数 data，返回变换后的值&#10;// 例: return JSON.parse(data).msg"
            ></textarea>
            <p v-if="streamParserError" class="text-xs text-red-500 mt-1">⚠ {{ streamParserError }}</p>
          </div>
        </div>
        <div class="flex-1 overflow-auto min-w-0 bg-surface border border-base rounded p-3 max-h-[calc(100vh-160px)]">
          <div v-for="(e, i) in processedStreamEvents" :key="i" class="text-xs font-mono py-0.5 border-b border-base/30">
            <div class="flex gap-2 items-baseline flex-wrap">
              <span v-if="e.type" class="text-purple-500">event: {{ e.type }}</span>
              <span v-if="e.id" class="text-faint">id: {{ e.id }}</span>
            </div>
            <div class="text-primary pl-4 break-all whitespace-pre-wrap">{{ e.display }}</div>
            <div v-if="e.parseError" class="text-red-500 text-xs pl-4">⚠ {{ e.parseError }}</div>
          </div>
          <div v-if="streamEvents.length === 0" class="text-xs text-faint text-center py-8">输入流数据后自动解析...</div>
          <div v-else-if="processedStreamEvents.length === 0" class="text-xs text-faint text-center py-8">无匹配项</div>
        </div>
      </div>

      <!-- ════════ JWT 解码 ════════ -->
      <div v-else-if="activeTool === 'jwt'" class="flex gap-4 h-full max-h-[calc(100vh-160px)]">
        <div class="flex-1 flex flex-col gap-2 min-w-0">
          <label class="text-xs text-muted">JWT Token</label>
          <textarea
            v-model="jwtInput"
            rows="12"
            spellcheck="false"
            class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
            placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
          ></textarea>
        </div>
        <div class="flex-1 overflow-auto min-w-0 space-y-3">
          <template v-if="jwtDecoded">
            <div>
              <label class="text-xs text-red-500 block mb-1">🔴 Header</label>
              <div class="bg-surface border border-base rounded p-3"><ObjectInspector :raw="jwtDecoded.header" /></div>
            </div>
            <div>
              <label class="text-xs text-purple-500 block mb-1">🟣 Payload</label>
              <div class="bg-surface border border-base rounded p-3"><ObjectInspector :raw="jwtDecoded.payload" /></div>
            </div>
            <div v-if="jwtDecoded.expired" class="text-red-500 text-xs p-2 bg-red-500/10 border border-red-500/30 rounded">⏰ Token 已过期（{{ jwtDecoded.expTime }}）</div>
            <div v-else-if="jwtDecoded.expTime" class="text-green-500 text-xs p-2 bg-green-500/10 border border-green-500/30 rounded">✅ 有效期至：{{ jwtDecoded.expTime }}</div>
          </template>
          <div v-else class="text-xs text-faint">粘贴 JWT token 自动解码...</div>
        </div>
      </div>

      <!-- ════════ 编解码 ════════ -->
      <div v-else-if="activeTool === 'codec'" class="flex gap-4 h-full max-h-[calc(100vh-160px)]">
        <div class="flex-1 flex flex-col gap-2 min-w-0">
          <div class="flex gap-1">
            <button
              v-for="c in codecModes"
              :key="c"
              @click="codecMode = c"
              class="px-3 py-1.5 text-xs rounded border"
              :class="codecMode === c ? 'bg-blue-600 text-white border-blue-600' : 'border-base text-primary hover:border-blue-500'"
            >{{ c }}</button>
          </div>
          <label class="text-xs text-muted mt-2">输入</label>
          <textarea
            v-model="codecInput"
            rows="10"
            spellcheck="false"
            class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          ></textarea>
          <div class="flex gap-2">
            <button @click="doEncode" class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500">↑ 编码</button>
            <button @click="doDecode" class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500">↓ 解码</button>
            <button @click="codecInput = ''; codecResult = ''; codecError = ''" class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500">清空</button>
          </div>
        </div>
        <div class="flex-1 flex flex-col gap-2 min-w-0">
          <label class="text-xs text-muted">结果</label>
          <textarea
            :value="codecResult"
            rows="14"
            readonly
            spellcheck="false"
            class="flex-1 w-full bg-surface border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none"
          ></textarea>
          <p v-if="codecError" class="text-xs text-red-500">⚠ {{ codecError }}</p>
        </div>
      </div>

      <!-- ════════ 时间戳 ════════ -->
      <div v-else-if="activeTool === 'timestamp'" class="max-w-2xl space-y-6">
        <div>
          <label class="text-xs text-muted block mb-2">时间戳 → 人类时间</label>
          <div class="flex gap-2">
            <input
              v-model="tsInput"
              type="text"
              spellcheck="false"
              class="flex-1 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
              placeholder="1691563200000 (ms) 或 1691563200 (s)"
              @input="convertTs"
            />
            <button @click="tsInput = String(Date.now()); convertTs()" class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500">现在</button>
          </div>
          <div v-if="tsResult" class="bg-surface border border-base rounded p-3 mt-2 space-y-1 text-xs">
            <div>📅 <strong class="text-primary">{{ tsResult.local }}</strong></div>
            <div class="text-muted">🌍 UTC: {{ tsResult.utc }}</div>
            <div class="text-muted">🌍 ISO: {{ tsResult.iso }}</div>
            <div class="text-muted">🕐 相对: {{ tsResult.relative }}</div>
          </div>
        </div>
        <div>
          <label class="text-xs text-muted block mb-2">人类时间 → 时间戳</label>
          <input
            v-model="dateInput"
            type="text"
            spellcheck="false"
            class="w-full bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
            placeholder="2026-08-09 14:30:00"
            @input="convertDate"
          />
          <div v-if="dateResult" class="bg-surface border border-base rounded p-3 mt-2 space-y-1 text-xs">
            <div>ms: <strong class="text-green-500">{{ dateResult.ms }}</strong></div>
            <div class="text-muted">s: {{ dateResult.s }}</div>
          </div>
        </div>
      </div>

      <!-- ════════ 正则测试 ════════ -->
      <div v-else-if="activeTool === 'regex'" class="flex gap-4 h-full max-h-[calc(100vh-160px)]">
        <div class="flex-1 flex flex-col gap-2 min-w-0">
          <label class="text-xs text-muted">正则表达式</label>
          <div class="flex items-center gap-1">
            <span class="text-sm text-muted">/</span>
            <input
              v-model="regexPattern"
              type="text"
              spellcheck="false"
              class="flex-1 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
              placeholder="\d{4}-\d{2}-\d{2}"
            />
            <span class="text-sm text-muted">/</span>
            <input
              v-model="regexFlags"
              type="text"
              spellcheck="false"
              class="w-16 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
              placeholder="gim"
            />
          </div>
          <label class="text-xs text-muted mt-2">测试文本</label>
          <textarea
            v-model="regexInput"
            rows="10"
            spellcheck="false"
            class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          ></textarea>
          <label class="text-xs text-muted mt-1">替换为（可选）</label>
          <input
            v-model="regexReplace"
            type="text"
            spellcheck="false"
            class="w-full bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
            placeholder="$1-$2-$3"
          />
        </div>
        <div class="flex-1 overflow-auto min-w-0">
          <label class="text-xs text-muted block mb-2">
            匹配结果
            <span v-if="regexMatches" class="text-green-500">（{{ regexMatches.length }} 个）</span>
          </label>
          <div v-if="regexError" class="text-red-500 text-xs p-3 bg-red-500/10 border border-red-500/30 rounded">⚠ {{ regexError }}</div>
          <div v-else-if="regexReplace && regexResult !== null" class="bg-surface border border-base rounded p-3">
            <div class="text-xs text-muted mb-1">替换结果</div>
            <pre class="text-xs text-green-500 whitespace-pre-wrap break-all">{{ regexResult }}</pre>
          </div>
          <div v-else-if="regexMatches" class="bg-surface border border-base rounded p-3 space-y-2">
            <div v-for="(m, i) in regexMatches" :key="i" class="border-b border-base/30 pb-2 last:border-0">
              <span class="text-xs text-green-500">Match {{ i + 1 }}</span>
              <span class="text-xs text-muted"> @{{ m.index }}</span>
              <code class="block text-xs text-orange-400 py-1 break-all">{{ m.full }}</code>
              <div v-for="(g, gi) in m.groups" :key="gi" class="text-xs text-muted">
                ${{ gi + 1 }}: <span class="text-purple-500">{{ g }}</span>
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-faint">输入正则和文本后自动匹配...</div>
        </div>
      </div>

      <!-- ════════ Diff 对比 ════════ -->
      <div v-else-if="activeTool === 'diff'" class="flex flex-col h-full max-h-[calc(100vh-120px)]">
        <!-- 输入区 -->
        <div class="flex gap-2 flex-shrink-0 mb-2">
          <div class="flex flex-col gap-1 flex-1 min-w-0">
            <label class="text-xs text-muted">文本 A（期望）</label>
            <textarea
              v-model="diffA"
              rows="6"
              spellcheck="false"
              class="w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
            ></textarea>
          </div>
          <div class="flex flex-col gap-1 flex-1 min-w-0">
            <label class="text-xs text-muted">文本 B（实际）</label>
            <textarea
              v-model="diffB"
              rows="6"
              spellcheck="false"
              class="w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
            ></textarea>
          </div>
        </div>
        <!-- 工具栏 -->
        <div class="flex items-center gap-3 px-1 pb-2 border-b border-base flex-shrink-0 flex-wrap">
          <label class="text-xs text-muted flex items-center gap-1 cursor-pointer">
            <input type="checkbox" v-model="diffJsonMode" class="cursor-pointer" /> JSON 格式化
          </label>
          <label class="text-xs text-muted flex items-center gap-1 cursor-pointer">
            <input type="checkbox" v-model="diffCharLevel" class="cursor-pointer" /> 字符级高亮
          </label>
          <label class="text-xs text-muted flex items-center gap-1 cursor-pointer">
            <input type="checkbox" v-model="diffCollapseSame" class="cursor-pointer" /> 折叠相同行
          </label>
          <div class="flex rounded border border-base overflow-hidden">
            <button
              @click="diffViewMode = 'inline'"
              class="px-2 py-0.5 text-xs"
              :class="diffViewMode === 'inline' ? 'bg-blue-500 text-white' : 'bg-surface text-muted hover:text-primary'"
            >合并</button>
            <button
              @click="diffViewMode = 'split'"
              class="px-2 py-0.5 text-xs"
              :class="diffViewMode === 'split' ? 'bg-blue-500 text-white' : 'bg-surface text-muted hover:text-primary'"
            >并排</button>
          </div>
          <div v-if="diffStats.total" class="ml-auto flex items-center gap-3 text-xs">
            <span class="text-green-500">+{{ diffStats.added }}</span>
            <span class="text-red-500">−{{ diffStats.removed }}</span>
            <span v-if="diffCollapsed.hiddenCount" class="text-faint">省略 {{ diffCollapsed.hiddenCount }} 行</span>
          </div>
        </div>
        <!-- 结果区 -->
        <div class="flex-1 overflow-auto min-h-0">
          <div v-if="diffResult.length === 0 && diffA && diffB" class="text-green-500 text-center py-4">✅ 完全一致</div>
          <div v-else-if="diffResult.length === 0" class="text-faint text-center py-4">输入两段文本后自动对比...</div>

          <!-- ════ Inline 视图（配对行合并：同一行内展示旧→新，字符级高亮） ════ -->
          <div v-else-if="diffViewMode === 'inline'" class="font-mono text-xs">
            <template v-for="(item, i) in diffCollapsedInline.lines" :key="i">
              <!-- 折叠指示器 -->
              <div v-if="item.kind === 'collapse'" class="px-4 py-0.5 text-faint text-center bg-base/50 border-y border-base cursor-pointer select-none">
                ⋯ {{ item.count }} 行未变化 ⋯
              </div>
              <!-- diff 行（逐行渲染，VS Code inline 风格） -->
              <div
                v-else
                class="flex items-stretch"
                :class="{
                  'diff-line-add': item.line.type === 'add',
                  'diff-line-del': item.line.type === 'del',
                }"
              >
                <!-- 行号（del 显示旧行号，add 显示新行号，交叉排列后同一位置） -->
                <span
                  class="inline-block w-12 text-right pr-2 select-none flex-shrink-0 text-faint"
                  :class="{
                    'diff-gutter-add': item.line.type === 'add',
                    'diff-gutter-del': item.line.type === 'del',
                  }"
                >{{ item.line.type === 'del' ? item.line.oldNum : item.line.newNum }}</span>
                <!-- 变更符号 -->
                <span
                  class="inline-block w-5 text-center select-none flex-shrink-0 font-bold"
                  :class="{
                    'text-green-500 diff-gutter-add': item.line.type === 'add',
                    'text-red-500 diff-gutter-del': item.line.type === 'del',
                  }"
                >{{ item.line.type === 'add' ? '+' : item.line.type === 'del' ? '−' : ' ' }}</span>
                <!-- 内容区 -->
                <span class="flex-1 whitespace-pre-wrap break-all py-px" :class="{ 'line-through opacity-70': item.line.type === 'del' }">
                  <!-- 有 charDiff：字符级高亮 -->
                  <template v-if="item.line.charDiff">
                    <span
                      v-for="(part, j) in charDiffParts(item.line)"
                      :key="j"
                      :class="{
                        'diff-char-del': part.op === 'removed',
                        'diff-char-add': part.op === 'added',
                      }"
                    >{{ part.text }}</span>
                  </template>
                  <!-- 无 charDiff：纯文本 -->
                  <template v-else>{{ item.line.text }}</template>
                </span>
              </div>
            </template>
          </div>

          <!-- ════ Split 视图（左右独立渲染，字符级高亮，空白行对齐） ════ -->
          <div v-else class="flex font-mono text-xs">
            <!-- 左侧（旧文本） -->
            <div class="flex-1 min-w-0 border-r border-base">
              <template v-for="(item, i) in diffCollapsed.lines" :key="'l' + i">
                <div v-if="item.kind === 'collapse'" class="px-4 py-0.5 text-faint text-center bg-base/50 border-b border-base select-none">
                  ⋯ {{ item.count }} 行 ⋯
                </div>
                <div
                  v-else-if="item.line.type !== 'add'"
                  class="flex items-stretch"
                  :class="{ 'diff-line-del': item.line.type === 'del' }"
                >
                  <span
                    class="inline-block w-12 text-right pr-2 select-none flex-shrink-0 text-faint"
                    :class="{ 'diff-gutter-del': item.line.type === 'del' }"
                  >{{ item.line.oldNum ?? '' }}</span>
                  <span class="flex-1 whitespace-pre-wrap break-all py-px" :class="{ 'line-through opacity-70': item.line.type === 'del' }">
                    <template v-if="item.line.charDiff && item.line.type === 'del'">
                      <span
                        v-for="(part, j) in charDiffParts(item.line)"
                        :key="j"
                        :class="{ 'diff-char-del': part.op === 'removed' }"
                      >{{ part.text }}</span>
                    </template>
                    <template v-else>{{ item.line.text }}</template>
                  </span>
                </div>
                <div v-else class="flex items-stretch diff-empty">
                  <span class="inline-block w-12 pr-2 select-none flex-shrink-0">&nbsp;</span>
                </div>
              </template>
            </div>
            <!-- 右侧（新文本） -->
            <div class="flex-1 min-w-0">
              <template v-for="(item, i) in diffCollapsed.lines" :key="'r' + i">
                <div v-if="item.kind === 'collapse'" class="px-4 py-0.5 text-faint text-center bg-base/50 border-b border-base select-none">
                  ⋯ {{ item.count }} 行 ⋯
                </div>
                <div
                  v-else-if="item.line.type !== 'del'"
                  class="flex items-stretch"
                  :class="{ 'diff-line-add': item.line.type === 'add' }"
                >
                  <span
                    class="inline-block w-12 text-right pr-2 select-none flex-shrink-0 text-faint"
                    :class="{ 'diff-gutter-add': item.line.type === 'add' }"
                  >{{ item.line.newNum ?? '' }}</span>
                  <span class="flex-1 whitespace-pre-wrap break-all py-px">
                    <template v-if="item.line.charDiff && item.line.type === 'add'">
                      <span
                        v-for="(part, j) in charDiffParts(item.line)"
                        :key="j"
                        :class="{ 'diff-char-add': part.op === 'added' }"
                      >{{ part.text }}</span>
                    </template>
                    <template v-else>{{ item.line.text }}</template>
                  </span>
                </div>
                <div v-else class="flex items-stretch diff-empty">
                  <span class="inline-block w-12 pr-2 select-none flex-shrink-0">&nbsp;</span>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>
