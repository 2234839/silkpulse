<script setup lang="ts">
/**
 * NetworkPanel —— 网络请求面板
 *
 * 展示远程设备的网络请求（HTTP + WebSocket），支持关键词搜索、状态筛选（全部/成功/失败）、
 * 耗时排序（定位慢请求）。点击单条请求展开详情（URL/方法/状态/耗时/请求头/响应头/请求体/响应体/WS 帧），
 * 支持复制为 cURL 命令在本地复现。
 *
 * 数据由 App.vue 通过 useConsoleSocket() 单源传入。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import type { NetworkEntry } from '@silkpulse/shared'
import { copyText } from '../utils/clipboard'
import ObjectInspector from './ObjectInspector.vue'

/**
 * 每秒刷新的 tick，驱动 SSE open 状态下耗时/大小的动态计算
 *
 * SSE 连接持续时间 = 当前时间 - 建连时间，需要持续刷新。
 * SSE 累积大小 = events 数据总和，随事件到达实时增长。
 */
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tickTimer = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

/**
 * 格式化字节数为人类可读（B/KB/MB）
 *
 * 响应大小从几字节到几 MB 不等，统一格式化。
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 计算单条网络请求的响应大小（字节）
 *
 * - SSE：累积所有 events 的 data + event/id 字段开销
 * - 普通 HTTP：resBody 字节长度（base64 近似）
 * - resource：size 字段
 * - WS：无静态大小（显示 -）
 */
function calcResSize(n: NetworkEntry): number {
  if (n.sseState && n.events) {
    let total = 0
    for (const ev of n.events) {
      if (ev.event && ev.event !== '__closed__') total += ev.event.length + 7 /* "event: \n" */
      if (ev.id) total += String(ev.id).length + 4 /* "id: \n" */
      if (ev.retry != null) total += String(ev.retry).length + 8 /* "retry: \n" */
      total += (ev.data?.length ?? 0) + 6 /* "data: \n\n" */
    }
    return total
  }
  if (n.protocol === 'ws') return 0
  if (n.kind === 'resource' && n.size) return n.size
  if (n.resBody) return n.resBody.length
  return 0
}

/**
 * 计算单条网络请求的动态耗时（ms）
 *
 * - SSE open：当前时间 - 建连时间（持续增长直到关闭）
 * - SSE closed：最后一条事件时间 - 建连时间
 * - 其他：直接用 n.duration
 */
function calcDuration(n: NetworkEntry): number {
  if (n.sseState === 'open' || (n.sseState === 'closed' && n.events?.length)) {
    const start = new Date(n.timestamp).getTime()
    if (n.sseState === 'open') {
      /** 依赖 now tick 驱动每秒刷新 */
      void now.value
      return Math.max(0, Date.now() - start)
    }
    /** closed：最后一条事件时间 - start */
    const lastEv = n.events![n.events!.length - 1]
    if (lastEv) return Math.max(0, new Date(lastEv.timestamp).getTime() - start)
  }
  return n.duration
}

const props = defineProps<{
  /** 远程设备网络请求列表 */
  network: NetworkEntry[]
}>()

/** 选中的请求 seq（点击展开详情，用 seq 追踪避免数组替换后引用丢失） */
const selectedSeq = ref<number | null>(null)

/** 从列表中按 seq 查找当前选中的条目 */
const selectedNetwork = computed(() => {
  if (selectedSeq.value === null) return null
  return props.network.find((n) => n.seq === selectedSeq.value) ?? null
})

/** cURL 复制状态（用于按钮反馈） */
const curlCopyState = ref<'idle' | 'copied'>('idle')

/** 格式化 headers 对象为 "k: v" 多行文本 */
function formatHeaders(h: Record<string, string>): string {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n')
}

/**
 * 格式化请求体/响应体：JSON 则美化缩进，否则原样返回。
 *
 * 调试时点击网络请求看详情，压缩 JSON（如 {"code":0,"data":[...]）可读性极差。
 * 尝试 JSON.parse 成功则 2 空格缩进美化；非 JSON（FormData 文本、纯字符串）原样返回。
 * 这里设计上就需要 try-catch —— 输入"可能不是 JSON"是正常的，不是异常情况。
 */
function formatBody(body: string): string {
  try {
    const parsed = JSON.parse(body)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return body
  }
}

/**
 * 判断响应体是否为 base64 图片（可预览）
 *
 * SDK 对 image/* 响应会用 FileReader.readAsDataURL 编码为 data URL，
 * resBodyEncoding='base64' 标识。
 */
function isImagePreview(n: NetworkEntry): boolean {
  return n.resBodyEncoding === 'base64' && !!n.resBodyMime?.startsWith('image/')
}

/**
 * 判断响应体是否为二进制信息（只读类型+大小，无内容）
 *
 * 字体/wasm/大图片等用 resBodyEncoding='info' 标识。
 */
function isBinaryInfo(n: NetworkEntry): boolean {
  return n.resBodyEncoding === 'info'
}

/**
 * 响应体展示模式：'preview'（智能预览）/ 'raw'（原始文本）
 *
 * 图片默认预览，可切到 raw 看完整 base64 字符串。
 */
const resBodyViewMode = ref<'preview' | 'raw'>('preview')

/** 响应体展示模式重置：切换请求时回到默认 preview */
watch(selectedSeq, () => {
  resBodyViewMode.value = 'preview'
})

/**
 * ─── SSE/WS 流 Filter + Parser ───
 *
 * Filter：对事件/帧的 data 做关键词过滤（大小写不敏感）。
 * Parser：输入 JS 函数体代码，参数为 data 字符串，返回值替换原始 data 展示。
 *   例如 parser = "return JSON.parse(data).msg" 会只展示 JSON 里的 msg 字段。
 *   编译失败或运行时错误会展示在错误提示行，不影响 Filter 功能。
 */
const streamFilter = ref('')
const streamParser = ref('')
const streamParserError = ref('')
/** parser 展示开关（默认折叠，点击展开） */
const streamParserOpen = ref(false)

/** 响应体展示模式重置 + 流状态重置：切换请求时清空 */
watch(selectedSeq, () => {
  streamParserError.value = ''
})

/**
 * 编译 parser 函数，失败时设置 streamParserError
 *
 * parser 代码作为函数体，通过 new Function 创建——比 eval 更安全（独立作用域）。
 * 函数签名：function(data) { ...用户代码... }，data 是事件/帧的原始字符串。
 */
let compiledParser: ((data: string) => unknown) | null = null
watch(streamParser, (code) => {
  const trimmed = code.trim()
  if (!trimmed) {
    compiledParser = null
    streamParserError.value = ''
    return
  }
  try {
    compiledParser = new Function('data', trimmed) as (data: string) => unknown
    streamParserError.value = ''
  } catch (e) {
    compiledParser = null
    streamParserError.value = e instanceof Error ? e.message : String(e)
  }
})

/**
 * 对单条 data 执行 parser，返回展示文本
 *
 * 运行时错误不中断流展示，逐条捕获后在当前条目标注错误。
 */
function applyParser(data: string): { ok: true; result: string } | { ok: false; error: string } {
  if (!compiledParser) return { ok: true, result: data }
  try {
    const result = compiledParser(data)
    return { ok: true, result: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 处理后的 SSE 事件列表（filter + parser）
 *
 * 过滤 __closed__ 事件，然后对 data 做 filter 关键词匹配 + parser 变换。
 */
const processedSseEvents = computed(() => {
  void now.value
  const events = selectedNetwork.value?.events ?? []
  const q = streamFilter.value.trim().toLowerCase()
  const result: Array<{ timestamp: string; event: string; id?: string; retry?: number; display: string; parseError?: string }> = []
  for (const e of events) {
    if (e.event === '__closed__') continue
    if (q && !e.data.toLowerCase().includes(q) && !e.event.toLowerCase().includes(q)) continue
    const parsed = applyParser(e.data)
    result.push({
      timestamp: e.timestamp,
      event: e.event,
      id: e.id,
      retry: e.retry,
      display: parsed.ok ? parsed.result : e.data,
      parseError: parsed.ok ? undefined : parsed.error,
    })
  }
  return result
})

/**
 * 处理后的 WS 帧列表（filter + parser）
 *
 * 连接事件帧（dir=event）不受 filter/parser 影响，始终展示。
 */
const processedWsFrames = computed(() => {
  void now.value
  const frames = selectedNetwork.value?.frames ?? []
  const q = streamFilter.value.trim().toLowerCase()
  const result: Array<{ timestamp: string; dir: string; display: string; isEvent: boolean; parseError?: string }> = []
  for (const f of frames) {
    /** 连接事件帧（close/error）始终展示 */
    if (f.dir === 'event') {
      result.push({ timestamp: f.timestamp, dir: f.dir, display: f.data, isEvent: true })
      continue
    }
    if (q && !f.data.toLowerCase().includes(q)) continue
    const parsed = applyParser(f.data)
    result.push({
      timestamp: f.timestamp,
      dir: f.dir,
      display: parsed.ok ? parsed.result : f.data,
      isEvent: false,
      parseError: parsed.ok ? undefined : parsed.error,
    })
  }
  return result
})

/**
 * 清空阈值：只展示此时间戳之后的网络请求。
 * 与 Console 面板清空语义一致——前端视图层隐藏，不影响 server 缓冲。
 */
const clearedBeforeTs = ref(0)

/** 清空当前网络面板视图 */
function clearNetwork() {
  clearedBeforeTs.value = Date.now()
  selectedSeq.value = null
}

/**
 * 把 NetworkEntry 转成 cURL 命令
 *
 * 让 AI/开发者能直接在本地复现远程设备的请求。
 * 单引号转义：shell 单引号内用 '\'' 闭合再开。
 */
function toCurl(n: NetworkEntry): string {
  const parts: string[] = [`curl -X ${n.method}`]
  if (n.reqHeaders) {
    for (const [k, v] of Object.entries(n.reqHeaders)) {
      const esc = v.replaceAll("'", "'\"'\"'")
      parts.push(`-H '${k}: ${esc}'`)
    }
  }
  if (n.reqBody) {
    const esc = n.reqBody.replaceAll("'", "'\"'\"'")
    parts.push(`--data '${esc}'`)
  }
  const urlEsc = n.url.replaceAll("'", "'\"'\"'")
  parts.push(`'${urlEsc}'`)
  return parts.join(' \\\n  ')
}

/** 复制选中请求的 cURL 命令到剪贴板 */
async function copyCurl() {
  if (!selectedNetwork.value) return
  const cmd = toCurl(selectedNetwork.value)
  await copyText(cmd)
  curlCopyState.value = 'copied'
  setTimeout(() => { curlCopyState.value = 'idle' }, 1500)
}

/** 关键词搜索（按 URL / 方法 / 状态码） */
const networkSearch = ref('')
/**
 * 状态筛选：all 全部 / success 成功（2xx-3xx）/ error 失败（4xx-5xx 或未完成 status=0）
 *
 * 调试网络问题时最常用的维度 —— 失败请求和成功请求混在一起时，
 * 用户需要快速过滤出"哪些请求挂了"。status=0（请求未完成/网络中断）归入失败。
 */
const networkStatusFilter = ref<'all' | 'success' | 'error'>('all')
/**
 * 类型筛选：all 全部 / fetch / xhr / ws / resource
 *
 * 诊断时需要区分"API 请求"和"静态资源加载"——页面白屏查 resource，接口报错查 fetch/xhr。
 */
const networkKindFilter = ref<'all' | 'fetch' | 'xhr' | 'ws' | 'resource'>('all')
/**
 * 耗时排序：time（默认时间正序）/ desc（耗时降序，慢请求在最上）/ asc（耗时升序）
 *
 * 诊断"页面慢/卡"时，失败请求往往不是根因——真正的瓶颈是那些 status 200
 * 但耗时 2-3s 的慢请求。点"耗时"表头切到降序即可一眼定位，与 inspect CLI 的慢请求 Top 对齐。
 */
const networkDurationSort = ref<'time' | 'desc' | 'asc'>('time')
/** 慢请求阈值（ms），与 skill CLI inspect 的 SLOW_THRESHOLD 保持一致 */
const SLOW_THRESHOLD = 500
function toggleDurationSort() {
  if (networkDurationSort.value === 'time') networkDurationSort.value = 'desc'
  else if (networkDurationSort.value === 'desc') networkDurationSort.value = 'asc'
  else networkDurationSort.value = 'time'
}
const filteredNetwork = computed(() => {
  let result = props.network
  /** 清空阈值：隐藏"清空"之前的请求 */
  if (clearedBeforeTs.value > 0) {
    result = result.filter((n) => new Date(n.timestamp).getTime() >= clearedBeforeTs.value)
  }
  /** 类型筛选 */
  if (networkKindFilter.value !== 'all') {
    result = result.filter((n) => n.kind === networkKindFilter.value)
  }
  if (networkStatusFilter.value === 'success') {
    result = result.filter((n) => n.status >= 200 && n.status < 400)
  } else if (networkStatusFilter.value === 'error') {
    /** status=0 表示请求未完成（网络中断/CORS 失败），诊断时视为失败 */
    result = result.filter((n) => n.status === 0 || n.status >= 400)
  }
  const q = networkSearch.value.trim().toLowerCase()
  if (q) {
    result = result.filter((n) =>
      n.url.toLowerCase().includes(q) ||
      n.method.toLowerCase().includes(q) ||
      String(n.status).includes(q),
    )
  }
  /** 耗时排序：默认 time 不排（保持时间正序），desc/asc 按 duration 排 */
  if (networkDurationSort.value === 'desc') {
    result = [...result].sort((a, b) => b.duration - a.duration)
  } else if (networkDurationSort.value === 'asc') {
    result = [...result].sort((a, b) => a.duration - b.duration)
  }
  return result
})
</script>

<template>
  <div class="flex-1 flex overflow-hidden bg-base">
    <!-- 请求列表 -->
    <div class="w-2/5 min-w-[180px] md:min-w-[240px] flex flex-col border-r border-base">
      <!-- 搜索 + 状态筛选栏 -->
      <div class="p-2 border-b border-light bg-surface space-y-2">
        <input
          v-model="networkSearch"
          placeholder="搜索请求（URL / 方法 / 状态码）"
          class="w-full text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
        />
        <!-- 类型筛选：全部 / Fetch / XHR / WS / 资源 -->
        <div class="flex items-center gap-1">
          <button
            v-for="kf in (['all', 'fetch', 'xhr', 'ws', 'resource'] as const)"
            :key="kf"
            @click="networkKindFilter = kf"
            class="px-2 py-0.5 text-xs rounded font-medium"
            :class="networkKindFilter === kf
              ? 'bg-blue-500 text-white'
              : 'bg-elevated text-secondary bg-elevated-hover'"
          >{{ kf === 'all' ? '全部' : kf === 'resource' ? '资源' : kf === 'ws' ? 'WS' : kf.toUpperCase() }}</button>
        </div>
        <!-- 状态筛选：全部 / 成功 / 失败 -->
        <div class="flex items-center gap-1">
          <button
            v-for="sf in (['all', 'success', 'error'] as const)"
            :key="sf"
            @click="networkStatusFilter = sf"
            class="px-2 py-0.5 text-xs rounded font-medium"
            :class="networkStatusFilter === sf
              ? sf === 'error' ? 'bg-red-600 text-white' : 'bg-gray-800 text-white'
              : 'bg-elevated text-secondary bg-elevated-hover'"
          >{{ sf === 'all' ? '全部' : sf === 'success' ? '成功' : '失败' }}</button>
          <button
            @click="clearNetwork"
            class="ml-auto px-2 py-0.5 text-xs rounded bg-elevated text-secondary bg-elevated-hover"
            title="清空当前视图（不影响服务端缓冲）"
          >🚫 清空</button>
          <span class="text-xs text-faint">{{ filteredNetwork.length }}/{{ props.network.length }}</span>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto">
        <table class="w-full text-sm">
          <thead class="bg-elevated text-secondary text-xs uppercase sticky top-0">
            <tr>
              <th class="text-left px-3 py-2">时间</th>
              <th class="text-left px-3 py-2">方法</th>
              <th class="text-left px-3 py-2">状态</th>
              <th class="text-left px-3 py-2">URL</th>
              <th class="text-right px-3 py-2">大小</th>
              <th class="text-right px-3 py-2">
                <button
                  @click="toggleDurationSort"
                  class="inline-flex items-center gap-0.5 hover:text-primary transition-colors"
                  :class="networkDurationSort !== 'time' ? 'text-primary' : ''"
                  :title="networkDurationSort === 'time' ? '点击按耗时降序' : networkDurationSort === 'desc' ? '当前：耗时降序（慢请求在上）' : '当前：耗时升序'"
                >耗时<span class="text-[10px]">{{ networkDurationSort === 'desc' ? '▼' : networkDurationSort === 'asc' ? '▲' : '↕' }}</span></button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(n, i) in filteredNetwork"
              :key="i"
              @click="selectedSeq = n.seq"
              class="border-b border-light cursor-pointer hover:bg-blue-soft"
              :class="selectedSeq === n.seq ? 'bg-blue-soft' : ''"
            >
              <td class="px-3 py-2 text-faint text-xs font-mono whitespace-nowrap">{{ new Date(n.timestamp).toLocaleTimeString() }}</td>
              <td class="px-3 py-2 text-secondary font-mono text-xs">{{ n.method }}</td>
              <td class="px-3 py-2 font-mono text-xs" :class="n.status >= 400 ? 'text-red-500' : n.status >= 200 ? 'text-green-600' : 'text-faint'">
                {{ n.status || '…' }}
              </td>
              <td class="px-3 py-2 text-primary truncate max-w-[160px] text-xs">
                <span v-if="n.sseState" class="inline-block px-1 mr-1 text-[10px] rounded bg-purple-key/20 text-purple-key align-middle">SSE</span>
                <span v-if="n.protocol === 'ws'" class="inline-block px-1 mr-1 text-[10px] rounded bg-blue-key/20 text-blue-key align-middle">WS</span>
                {{ n.url.split('/').pop() || n.url }}
              </td>
              <td class="px-3 py-2 text-right text-xs font-mono text-muted whitespace-nowrap">
                {{ n.protocol === 'ws' ? '—' : formatSize(calcResSize(n)) }}
              </td>
              <td
                class="px-3 py-2 text-right text-xs font-mono"
                :class="calcDuration(n) > SLOW_THRESHOLD ? 'text-amber-500 font-semibold' : 'text-muted'"
                :title="calcDuration(n) > SLOW_THRESHOLD ? `慢请求（> ${SLOW_THRESHOLD}ms）` : ''"
              >{{ calcDuration(n) }}ms</td>
            </tr>
          </tbody>
        </table>
        <div v-if="filteredNetwork.length === 0" class="text-faint text-center py-8 text-sm">{{ props.network.length === 0 ? '暂无网络请求' : '无匹配请求' }}</div>
      </div>
    </div>

    <!-- 详情面板 -->
    <div class="flex-1 overflow-y-auto p-4">
      <template v-if="selectedNetwork">
        <div class="space-y-4">
          <!-- 工具栏：复制为 cURL -->
          <div class="flex justify-end">
            <button
              @click="copyCurl"
              class="px-3 py-1.5 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary transition-colors"
            >{{ curlCopyState === 'copied' ? '✓ 已复制' : '复制为 cURL' }}</button>
          </div>
          <!-- 基本信息 -->
          <div>
            <div class="text-xs text-faint mb-1">URL</div>
            <div class="text-sm font-mono text-primary break-all bg-surface p-2 rounded border border-base">{{ selectedNetwork.url }}</div>
          </div>
          <div class="flex gap-6 text-sm">
            <div><span class="text-faint">时间：</span><span class="font-mono text-primary">{{ new Date(selectedNetwork.timestamp).toLocaleString() }}</span></div>
            <div><span class="text-faint">方法：</span><span class="font-mono text-primary">{{ selectedNetwork.method }}</span></div>
            <div>
              <span class="text-faint">状态：</span>
              <span class="font-mono" :class="selectedNetwork.status >= 400 ? 'text-red-500' : 'text-green-600'">{{ selectedNetwork.status || '—' }}</span>
            </div>
            <div>
              <span class="text-faint">大小：</span>
              <span class="font-mono text-primary">{{ selectedNetwork.protocol === 'ws' ? '—' : formatSize(calcResSize(selectedNetwork)) }}</span>
            </div>
            <div><span class="text-faint">耗时：</span><span class="font-mono text-primary">{{ calcDuration(selectedNetwork) }}ms</span></div>
          </div>

          <!-- 错误 -->
          <div v-if="selectedNetwork.error" class="bg-red-soft border border-red-soft rounded p-3">
            <div class="text-xs text-red-400 mb-1">错误</div>
            <div class="text-sm text-red-key font-mono">{{ selectedNetwork.error }}</div>
          </div>

          <!-- WebSocket 帧时间线（仅 WS 连接条目，对齐 DevTools 的 Messages 面板） -->
          <div v-if="selectedNetwork.protocol === 'ws'">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs text-faint">帧时间线</span>
              <span class="text-xs text-faint">({{ processedWsFrames.length }} / {{ selectedNetwork.frames?.length ?? 0 }} 帧)</span>
            </div>
            <!-- Filter + Parser 工具栏 -->
            <div class="flex items-center gap-1 mb-2 flex-wrap">
              <input
                v-model="streamFilter"
                placeholder="🔍 过滤帧内容..."
                class="flex-1 min-w-[120px] text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
              />
              <button
                @click="streamParserOpen = !streamParserOpen"
                class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
                :class="streamParserOpen || streamParser ? 'text-blue-key border-blue-400' : ''"
              >⚡ Parser</button>
            </div>
            <!-- Parser 代码编辑区 -->
            <div v-if="streamParserOpen" class="mb-2">
              <div class="flex gap-1">
                <textarea
                  v-model="streamParser"
                  rows="2"
                  placeholder="// 输入 JS 函数体，参数 data 是帧内容字符串&#10;// 例: return JSON.parse(data).msg"
                  class="flex-1 text-xs font-mono px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400 resize-y"
                  spellcheck="false"
                ></textarea>
                <button
                  @click="streamParser = 'try { return JSON.parse(data).msg } catch { return data }'"
                  class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
                >📋 模板</button>
              </div>
              <div v-if="streamParserError" class="text-xs text-red-500 mt-0.5">⚠ {{ streamParserError }}</div>
            </div>
            <div class="bg-surface border border-base rounded p-2 space-y-0.5 max-h-80 overflow-y-auto">
              <div v-for="(f, fi) in processedWsFrames" :key="fi" class="text-xs font-mono flex gap-2">
                <span class="text-faint shrink-0">{{ new Date(f.timestamp).toLocaleTimeString() }}</span>
                <span class="shrink-0" :class="f.dir === 'send' ? 'text-blue-key' : f.dir === 'recv' ? 'text-green-600' : 'text-red-500'">{{ f.dir === 'send' ? '↑ send' : f.dir === 'recv' ? '↓ recv' : '⚠ ' + f.display }}</span>
                <span v-if="!f.isEvent" class="text-primary break-all whitespace-pre-wrap">{{ f.display }}</span>
                <span v-if="f.parseError" class="text-red-500 text-[10px]">⚠ {{ f.parseError }}</span>
              </div>
              <div v-if="!selectedNetwork.frames?.length" class="text-faint text-center py-4 text-xs">暂无帧（连接已建立，等待收发消息）</div>
              <div v-else-if="!processedWsFrames.length" class="text-faint text-center py-4 text-xs">无匹配帧</div>
            </div>
          </div>

          <!-- SSE 事件时间线（仅 SSE 连接条目，对齐 DevTools 的 EventStream 面板） -->
          <div v-if="selectedNetwork.sseState">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs text-faint">SSE 事件流</span>
              <span class="text-xs" :class="selectedNetwork.sseState === 'open' ? 'text-green-600' : 'text-faint'">
                {{ selectedNetwork.sseState === 'open' ? '● 连接中' : '○ 已关闭' }}
              </span>
              <span class="text-xs text-faint">({{ processedSseEvents.length }} / {{ selectedNetwork.events?.filter(e => e.event !== '__closed__').length ?? 0 }} 事件)</span>
            </div>
            <!-- Filter + Parser 工具栏 -->
            <div class="flex items-center gap-1 mb-2 flex-wrap">
              <input
                v-model="streamFilter"
                placeholder="🔍 过滤事件内容/类型..."
                class="flex-1 min-w-[120px] text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
              />
              <button
                @click="streamParserOpen = !streamParserOpen"
                class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
                :class="streamParserOpen || streamParser ? 'text-blue-key border-blue-400' : ''"
              >⚡ Parser</button>
            </div>
            <!-- Parser 代码编辑区 -->
            <div v-if="streamParserOpen" class="mb-2">
              <div class="flex gap-1">
                <textarea
                  v-model="streamParser"
                  rows="2"
                  placeholder="// 输入 JS 函数体，参数 data 是事件 data 字符串&#10;// 例: return JSON.parse(data).msg"
                  class="flex-1 text-xs font-mono px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400 resize-y"
                  spellcheck="false"
                ></textarea>
                <button
                  @click="streamParser = 'try { return JSON.parse(data).msg } catch { return data }'"
                  class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
                >📋 模板</button>
              </div>
              <div v-if="streamParserError" class="text-xs text-red-500 mt-0.5">⚠ {{ streamParserError }}</div>
            </div>
            <div class="bg-surface border border-base rounded p-2 space-y-1">
              <div v-for="(e, ei) in processedSseEvents" :key="ei" class="text-xs font-mono">
                <div class="flex gap-2 items-baseline flex-wrap">
                  <span class="text-faint shrink-0">{{ new Date(e.timestamp).toLocaleTimeString() }}</span>
                  <span class="shrink-0 text-purple-key">event: {{ e.event }}</span>
                  <span v-if="e.id" class="shrink-0 text-faint">id: {{ e.id }}</span>
                  <span v-if="e.retry != null" class="shrink-0 text-amber-500">retry: {{ e.retry }}</span>
                </div>
                <div class="pl-2 mt-0.5">
                  <span class="text-blue-key">data:</span>
                  <span v-if="e.parseError" class="text-red-500 ml-1">⚠ {{ e.parseError }}</span>
                  <span class="text-primary whitespace-pre-wrap break-all ml-1">{{ e.display }}</span>
                </div>
              </div>
              <div v-if="!selectedNetwork.events?.filter(e => e.event !== '__closed__').length" class="text-faint text-center py-4 text-xs">暂无事件（连接已建立，等待服务端推送）</div>
              <div v-else-if="!processedSseEvents.length" class="text-faint text-center py-4 text-xs">无匹配事件</div>
            </div>
          </div>

          <!-- 请求头 -->
          <div v-if="selectedNetwork.reqHeaders">
            <div class="text-xs text-faint mb-1">请求头</div>
            <pre class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all">{{ formatHeaders(selectedNetwork.reqHeaders) }}</pre>
          </div>

          <!-- 响应头 -->
          <div v-if="selectedNetwork.resHeaders">
            <div class="text-xs text-faint mb-1">响应头</div>
            <pre class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all">{{ formatHeaders(selectedNetwork.resHeaders) }}</pre>
          </div>

          <!-- 请求体 -->
          <div v-if="selectedNetwork.reqBody">
            <div class="text-xs text-faint mb-1">请求体</div>
            <div class="bg-surface p-3 rounded border border-base">
              <ObjectInspector :json="selectedNetwork.reqBody" />
            </div>
          </div>

          <!-- 响应体 -->
          <div v-if="selectedNetwork.resBody">
            <div class="flex items-center justify-between mb-1">
              <div class="text-xs text-faint">响应体</div>
              <!-- 视图切换：只在 base64 图片和文本之间切换 -->
              <div v-if="isImagePreview(selectedNetwork) || isBinaryInfo(selectedNetwork)" class="flex items-center gap-1">
                <button
                  @click="resBodyViewMode = 'preview'"
                  class="px-2 py-0.5 text-xs rounded font-medium transition-colors"
                  :class="resBodyViewMode === 'preview' ? 'bg-blue-500 text-white' : 'bg-elevated text-secondary bg-elevated-hover'"
                >预览</button>
                <button
                  @click="resBodyViewMode = 'raw'"
                  class="px-2 py-0.5 text-xs rounded font-medium transition-colors"
                  :class="resBodyViewMode === 'raw' ? 'bg-blue-500 text-white' : 'bg-elevated text-secondary bg-elevated-hover'"
                >原始</button>
              </div>
            </div>
            <div class="bg-surface p-3 rounded border border-base">
              <!-- 图片预览模式 -->
              <template v-if="isImagePreview(selectedNetwork) && resBodyViewMode === 'preview'">
                <div class="space-y-2">
                  <img :src="selectedNetwork.resBody" alt="响应预览" class="max-w-full rounded border border-light" style="max-height: 300px;" />
                  <div class="text-xs text-faint font-mono">{{ selectedNetwork.resBodyMime }} · {{ selectedNetwork.resBody!.length }} chars (base64)</div>
                </div>
              </template>
              <!-- 二进制信息模式 -->
              <template v-else-if="isBinaryInfo(selectedNetwork) && resBodyViewMode === 'preview'">
                <div class="text-sm text-secondary font-mono">{{ selectedNetwork.resBody }}</div>
              </template>
              <!-- 原始文本 / JSON 文本 -->
              <template v-else-if="!isBinaryInfo(selectedNetwork)">
                <ObjectInspector :json="resBodyViewMode === 'raw' && isImagePreview(selectedNetwork) ? selectedNetwork.resBody!.substring(0, 200) + '...' : selectedNetwork.resBody" />
              </template>
              <!-- info 模式的原始视图（无内容可显示） -->
              <template v-else>
                <div class="text-xs text-faint">无原始内容（二进制未读取）</div>
              </template>
            </div>
          </div>

          <!-- 无 body 提示 -->
          <div v-if="!selectedNetwork.reqBody && !selectedNetwork.resBody && !selectedNetwork.error" class="text-xs text-faint">
            此请求无请求体/响应体（可能是 GET 请求或响应未完成）
          </div>
        </div>
      </template>
      <div v-else class="text-faint text-center py-8 text-sm">点击左侧请求查看详情</div>
    </div>
  </div>
</template>
