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
import { useResizable } from '../composables/useResizable'
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

const activeTool = ref<typeof tools[number]['id']>('json')

/* ════════ 1. JSON 可视化 + JQ ════════ */
const jsonInput = ref('')
const jsonJqFilter = ref('')

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
    let parsed: unknown = JSON.parse(jsonInput.value)
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

const diffResult = computed(() => {
  let a = diffA.value
  let b = diffB.value
  if (!a && !b) return []
  if (diffJsonMode.value) {
    try { a = JSON.stringify(JSON.parse(a), null, 2) } catch { /* keep raw */ }
    try { b = JSON.stringify(JSON.parse(b), null, 2) } catch { /* keep raw */ }
  }
  const linesA = a.split('\n')
  const linesB = b.split('\n')
  const result: { type: 'same' | 'add' | 'del'; text: string }[] = []
  const minLen = Math.min(linesA.length, linesB.length)
  for (let i = 0; i < minLen; i++) {
    if (linesA[i] !== linesB[i]) {
      result.push({ type: 'del', text: '- ' + linesA[i] })
      result.push({ type: 'add', text: '+ ' + linesB[i] })
    } else {
      result.push({ type: 'same', text: '  ' + linesA[i] })
    }
  }
  for (let i = minLen; i < linesA.length; i++) result.push({ type: 'del', text: '- ' + linesA[i] })
  for (let i = minLen; i < linesB.length; i++) result.push({ type: 'add', text: '+ ' + linesB[i] })
  return result
})
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
          <label class="text-xs text-muted">输入 JSON</label>
          <textarea
            v-model="jsonInput"
            rows="20"
            spellcheck="false"
            class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
            placeholder='{"name":"silkpulse","items":[{"id":1,"msg":"hello"}]}'
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
          <p class="text-xs text-faint">语法：.key 取字段，.arr[] 遍历数组，.a.b 嵌套路径</p>
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
      <div v-else-if="activeTool === 'diff'" class="flex h-full max-h-[calc(100vh-160px)]">
        <div class="flex flex-col gap-2 min-w-0 flex-shrink-0" :style="{ width: toolLeftWidth + 'px' }">
          <label class="text-xs text-muted">文本 A（期望）</label>
          <textarea
            v-model="diffA"
            rows="12"
            spellcheck="false"
            class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          ></textarea>
          <label class="text-xs text-muted mt-1">文本 B（实际）</label>
          <textarea
            v-model="diffB"
            rows="12"
            spellcheck="false"
            class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          ></textarea>
          <div class="flex gap-2 items-center">
            <label class="text-xs text-muted flex items-center gap-1">
              <input type="checkbox" v-model="diffJsonMode" /> JSON 格式化
            </label>
          </div>
        </div>
        <!-- 拖拽手柄 -->
        <div
          class="w-1 cursor-col-resize bg-base hover:bg-blue-400/40 active:bg-blue-500 transition-colors flex-shrink-0 mx-1"
          @mousedown="onToolLeftResize"
        />
        <div class="flex-1 overflow-auto min-w-0">
          <label class="text-xs text-muted block mb-2">
            差异
            <span v-if="diffResult.length" class="text-amber-500">（{{ diffResult.filter(d => d.type !== 'same').length }} 行差异）</span>
          </label>
          <div class="bg-surface border border-base rounded p-3 font-mono text-xs space-y-0">
            <div
              v-for="(line, i) in diffResult"
              :key="i"
              class="px-1 py-0.5"
              :class="{
                'text-green-500 bg-green-500/10': line.type === 'add',
                'text-red-500 bg-red-500/10': line.type === 'del',
              }"
            >{{ line.text }}</div>
            <div v-if="diffResult.length === 0 && diffA && diffB" class="text-green-500 text-center py-4">✅ 完全一致</div>
            <div v-if="diffResult.length === 0 && (!diffA || !diffB)" class="text-faint text-center py-4">输入两段文本后自动对比...</div>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>
