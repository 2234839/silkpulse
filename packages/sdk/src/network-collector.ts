/**
 * network 采集 —— 劫持 fetch 和 XMLHttpRequest，组装 HAR 风格条目
 *
 * 采集核心字段：url / method / status / reqHeaders / reqBody / resHeaders / resBody / duration / error
 * headers 只采诊断关键头（content-type / authorization / cookie / 自定义 x-* 等），
 * 平衡 AI 复现请求所需信息与隐私/体积。
 */

import type { NetworkEntry, WsFrame, SseEvent } from '@silkpulse/shared'

type NetworkSink = (entry: NetworkEntry) => void
/** 已有 entry 的增量更新回调（按 seq 找到并合并 patch 字段） */
type NetworkUpdateSink = (seq: number, patch: Partial<NetworkEntry>) => void
/** WebSocket 帧追加回调（seq 关联连接条目，frame 新帧） */
type WsFrameSink = (seq: number, frame: WsFrame) => void
/** WebSocket 状态变更回调（readyState 变化） */
type WsStateSink = (seq: number, wsState: number) => void
/** SSE 事件追加回调（seq 关联 fetch 条目，event 新 SSE 事件） */
type SseEventSink = (seq: number, event: SseEvent) => void

/** 内部序号计数器 */
let seq = 0

/**
 * 完整 body 内存缓存（懒加载核心）
 *
 * key = network entry seq，value = 完整文本 body。
 * 超过 BODY_INLINE_MAX 的 body 才存这里，推送只带摘要；
 * 小于阈值的直接完整推送，无需懒加载。
 *
 * 上限 200 条，超出 FIFO 淘汰最旧的（避免内存泄漏）。
 */
const bodyStore = new Map<number, string>()
const BODY_STORE_MAX = 200

/** 内联推送阈值：小于此值直接完整推送，大于此值走懒加载 */
const BODY_INLINE_MAX = 512 * 1024
/**
 * 单条 body 硬上限：超过此值的懒加载存储也只存前段
 *
 * 没有它时任意大的响应体会完整驻留设备内存（bodyStore 无字节限制，
 * 只限条数），一个几十 MB 的下载/上传就能撑爆嵌入式页面或触发 OOM。
 */
const BODY_HARD_MAX = 2 * 1024 * 1024
/** 懒加载摘要长度（大 body 推送时只带这么多字符预览） */
const BODY_SUMMARY_LEN = 500
/** 单个 header 值最大截断长度 */
const MAX_HEADER_LEN = 200

/**
 * 处理 body：决定是完整推送还是懒加载摘要
 *
 * 返回推送用的 body 文本 + truncated 标记。
 * - body.length <= BODY_INLINE_MAX：直接返回完整 body，truncated=false
 * - body.length > BODY_INLINE_MAX：存入 bodyStore，返回摘要，truncated=true
 */
function processBody(seqNum: number, fullBody: string): { body: string; truncated: boolean } {
  if (fullBody.length <= BODY_INLINE_MAX) {
    return { body: fullBody, truncated: false }
  }
  /**
   * 大 body：只把硬上限内的前段存入懒加载缓存，推摘要。
   * 超硬上限的部分永久丢弃——调试器不需要完整镜像一个 50MB 的响应体。
   */
  const storable = fullBody.length > BODY_HARD_MAX ? fullBody.slice(0, BODY_HARD_MAX) : fullBody
  bodyStore.set(seqNum, storable)
  if (bodyStore.size > BODY_STORE_MAX) {
    const oldest = bodyStore.keys().next().value
    if (oldest !== undefined) bodyStore.delete(oldest)
  }
  return {
    body: fullBody.slice(0, BODY_SUMMARY_LEN) + '…',
    truncated: true,
  }
}

/** 读取缓存的完整 body（供 get-network-body 消息调用） */
export function getStoredBody(seqNum: number): string | null {
  return bodyStore.get(seqNum) ?? null
}

/**
 * 诊断关键请求头白名单（小写匹配）
 *
 * AI/开发者本地复现请求时，这些头缺一不可（尤其鉴权头）。
 * 额外保留自定义 x-* / x- 前缀头，业务诊断常靠它们传递标记。
 */
const KEY_REQ_HEADERS = new Set([
  'content-type', 'authorization', 'cookie', 'accept', 'accept-language',
  'origin', 'referer', 'user-agent',
])

/** 诊断关键响应头白名单 */
const KEY_RES_HEADERS = new Set([
  'content-type', 'content-length', 'cache-control', 'set-cookie',
  'location', 'access-control-allow-origin', 'www-authenticate',
])

/** 判断是否为业务自定义头（x- 前缀），这类头常携带诊断线索 */
function isCustomHeader(name: string): boolean {
  return name.startsWith('x-')
}

/**
 * 从 Headers 对象中提取诊断关键头（白名单 + 自定义 x-* 头）
 * 每个值截断到 MAX_HEADER_LEN，鉴权头脱敏保留前缀（AI 需知道鉴权类型）。
 */
function pickKeyHeaders(
  headers: Headers,
  whitelist: Set<string>,
  opts?: { isRequest?: boolean },
): Record<string, string> | undefined {
  const result: Record<string, string> = {}
  let hasAny = false
  headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    const isKey = whitelist.has(lower) || isCustomHeader(lower)
    if (!isKey) return
    hasAny = true
    /** 鉴权头脱敏：保留类型前缀（如 "Bearer "），隐藏凭证，AI 仍能判断鉴权方式 */
    if (lower === 'authorization' && opts?.isRequest) {
      const spaceIdx = value.indexOf(' ')
      result[lower] = spaceIdx > 0
        ? truncate(value.slice(0, spaceIdx + 4) + '…', MAX_HEADER_LEN)
        : '…'
      return
    }
    if (lower === 'cookie' && opts?.isRequest) {
      /** cookie 只记个数和键名，不记值（隐私） */
      const keys = value.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean)
      result[lower] = truncate(`${keys.length} 个: ${keys.join(', ')}`, MAX_HEADER_LEN)
      return
    }
    result[lower] = truncate(value, MAX_HEADER_LEN)
  })
  return hasAny ? result : undefined
}

/** 把 fetch init.headers（支持 Headers / 对象 / 数组）统一转为 Headers 对象 */
function toHeaders(init?: HeadersInit): Headers {
  if (!init) return new Headers()
  if (init instanceof Headers) return init
  return new Headers(init)
}

/** 解析 getAllResponseHeaders 的 "k: v\r\n" 多行文本为 Headers */
function parseRawHeaders(raw: string): Headers {
  const h = new Headers()
  for (const line of raw.trim().split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (name) h.set(name, value)
  }
  return h
}

/**
 * 安装 network 采集（fetch + xhr + websocket 三重劫持）
 *
 * @param sink HTTP 请求/WS 连接条目 sink（新连接/新请求时触发）
 * @param wsFrameSink WS 帧追加（send/recv/event，seq 关联连接）
 * @param wsStateSink WS readyState 变化（OPEN/CLOSING/CLOSED）
 * @param sseEventSink SSE 事件追加（text/event-stream 流式响应的逐事件）
 * @param updateSink 已有条目的增量更新（loading→done 状态切换、流式 body 追加）
 */
export function installNetworkCollector(
  sink: NetworkSink,
  wsFrameSink: WsFrameSink,
  wsStateSink: WsStateSink,
  sseEventSink?: SseEventSink,
  updateSink?: NetworkUpdateSink,
): void {
  installFetchHook(sink, sseEventSink, updateSink)
  installXhrHook(sink, updateSink)
  installWsHook(sink, wsFrameSink, wsStateSink)
  installEventSourceHook(sink, sseEventSink)
  installResourceObserver(sink)
}

/**
 * 用 PerformanceObserver 采集静态资源加载（<script>/<link>/<img> 等）
 *
 * fetch/XHR 劫持只能拿到 API 请求，拿不到浏览器自动发起的资源加载。
 * PerformanceObserver 的 'resource' 条目包含 URL/initiatorType/duration/transferSize 等，
 * 填补这个盲区——诊断"页面白屏/样式没加载"时需要看这些。
 *
 * 已采集的 fetch/XHR URL 不会重复采集（用 Set 去重）。
 */
function installResourceObserver(sink: NetworkSink): void {
  /** 已采集的 URL 去重（避免 fetch/XHR 劫持的请求被 PerformanceObserver 重复上报） */
  const seen = new Set<string>()

  const reportEntry = (e: PerformanceResourceTiming) => {
    /** 只排除 SDK 的 WebSocket 长连接（不是资源加载） */
    if (e.name.includes('/ws/device')) return
    /** EventSource 被 installEventSourceHook 采集，排除其 URL（不重复上报为 resource） */
    if (sseUrls.has(e.name)) return
    if (seen.has(e.name)) return
    seen.add(e.name)
    /** Set 上限避免内存泄漏（大量请求的 SPA） */
    if (seen.size > 500) {
      const first = seen.values().next().value
      if (first) seen.delete(first)
    }

    /** initiatorType: 'link'/'script'/'img'/'css'/'fetch'/'xmlhttprequest'/'navigation' 等 */
    const initType = e.initiatorType
    /** fetch/xmlhttprequest 已经被 hook 采集了，不重复 */
    if (initType === 'fetch' || initType === 'xmlhttprequest' || initType === 'navigation') return

    sink({
      seq: seq++,
      timestamp: new Date(e.startTime + performance.timeOrigin).toISOString(),
      url: e.name,
      method: 'GET',
      /** PerformanceResourceTiming 提供真实 HTTP 状态码（0 = 不可用/缓存命中） */
      status: (e as PerformanceResourceTiming & { responseStatus?: number }).responseStatus || 0,
      duration: Math.round(e.duration),
      kind: 'resource',
      /** 用 initiatorType 作为 mimeType 前缀（前端据此分类显示资源图标） */
      mimeType: initType,
      size: e.transferSize || e.encodedBodySize || undefined,
    })
  }

  try {
    /** 采集后续新加载的资源 */
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        reportEntry(e as PerformanceResourceTiming)
      }
    })
    observer.observe({ type: 'resource', buffered: true })
  } catch {
    /** PerformanceObserver 不支持（老浏览器）——静默降级 */
  }
}

/** 判断 content-type 是否为 SSE 流（text/event-stream） */
function isSseContentType(contentType: string): boolean {
  return contentType.toLowerCase().split(';')[0].trim() === 'text/event-stream'
}

/**
 * 劫持全局 fetch
 *
 * @param sink HTTP 请求条目 sink
 * @param sseEventSink SSE 事件增量 sink（可选，不传则 SSE 响应不采集事件）
 */
function installFetchHook(sink: NetworkSink, sseEventSink?: SseEventSink, updateSink?: NetworkUpdateSink): void {
  const originalFetch = globalThis.fetch
  if (!originalFetch) return

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET')).toUpperCase()
    /**
     * 请求体读取：优先 init.body；init 为空但 input 是 Request 对象时，
     * 从 Request 上读（clone 副本读取，不消费原始 body）。
     * fetch(new Request(url, {body})) 场景若不处理，body 会丢失。
     */
    /** 预分配 seq（需在 bodyStore 存储时使用同一个 seq） */
    const loadingSeq = seq++
    let reqBody: string | undefined
    let reqBodyTruncated = false
    if (init?.body) {
      const full = stringifyBody(init.body)
      if (full !== undefined) {
        const { body, truncated } = processBody(loadingSeq, full)
        reqBody = body
        reqBodyTruncated = truncated
      }
    } else if (typeof input !== 'string' && !(input instanceof URL) && input.method !== 'GET' && input.method !== 'HEAD') {
      /** Request 对象带 body（非 GET/HEAD）：clone 后读文本，不消费原始 stream */
      try {
        const full = await readRequestBodyClone(input)
        if (full !== undefined) {
          const { body, truncated } = processBody(loadingSeq, full)
          reqBody = body
          reqBodyTruncated = truncated
        }
      } catch {
        /** clone 或读取失败（stream 已消费/locked）忽略，不影响请求 */
      }
    }
    /** 请求头：合并 input（若是 Request 对象）与 init 的 headers */
    const reqHeaders = pickKeyHeaders(mergeReqHeaders(input, init), KEY_REQ_HEADERS, { isRequest: true })
    const start = Date.now()

    /** 立即上报 loading entry（status=0），让控制台即时看到请求发出 */
    sink({
      seq: loadingSeq,
      timestamp: new Date().toISOString(),
      url,
      method,
      status: 0,
      reqHeaders,
      reqBody,
      bodyTruncated: reqBodyTruncated || undefined,
      duration: 0,
      kind: 'fetch',
    })

    try {
      const res = await originalFetch(input as RequestInfo, init)
      /** 响应头 */
      const resHeaders = pickKeyHeaders(res.headers, KEY_RES_HEADERS)

      /**
       * SSE 流式响应：检测到 text/event-stream 时走流式 reader 路径。
       *
       * SSE 是长连接流式推送，不能等 body 结束才读（永远不结束）。
       * 用 res.body.tee() 拆出两条流：一条给业务代码用（return tee[0]），
       * 一条给采集器逐块解析 SSE 事件。
       *
       * 如果 body.tee() 不可用（老浏览器/已 locked），降级为 clone +
       * 一次性读取（只拿到响应头信息，采不到事件流）。
       */
      const contentType = res.headers.get('content-type') ?? ''
      if (sseEventSink && res.body && isSseContentType(contentType)) {
        /** 更新 loading entry 为 SSE 连接条目 */
        updateSink?.(loadingSeq, {
          status: res.status,
          duration: Date.now() - start,
          resHeaders,
          sseState: 'open',
          events: [],
        })

        const sseEntrySeq = loadingSeq

        /** tee 拆流：[0] 给业务代码，[1] 给采集器解析 */
        const [bodyForCaller, bodyForCollect] = res.body.tee()

        /**
         * 后台逐块采集 SSE 事件
         *
         * 每个 reader.read() 拿到的 chunk 按 \n 拆分为多条独立事件，
         * 去掉空行后逐条上报。不做 SSE 协议解析（最简单、最可靠）。
         */
        ;(async () => {
          const reader = bodyForCollect.getReader()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              const text = new TextDecoder().decode(value, { stream: true })
              /** chunk 按 \n 拆分，去掉空行，解析 SSE 字段前缀 */
              for (const line of text.split('\n')) {
                if (!line.trim()) continue
                /** 去掉 SSE 协议字段前缀（data: / event: / id: 等） */
                const colonIdx = line.indexOf(':')
                const field = colonIdx > 0 ? line.slice(0, colonIdx) : ''
                const value = colonIdx > 0 ? line.slice(colonIdx + 1).replace(/^ /, '') : line
                if (field === 'data' || field === 'event' || field === 'id' || field === 'retry') {
                  /** 只上报 data 行的内容，其他字段跳过 */
                  if (field === 'data' && value.trim()) {
                    sseEventSink(sseEntrySeq, {
                      timestamp: new Date().toISOString(),
                      event: 'message',
                      data: value,
                    })
                  }
                } else {
                  /** 无 SSE 前缀的裸数据，整行上报 */
                  sseEventSink(sseEntrySeq, {
                    timestamp: new Date().toISOString(),
                    event: 'message',
                    data: line,
                  })
                }
              }
            }
          } catch {
            /** reader 读取失败（连接中断等）：静默，关闭事件会通过 sink 通知 */
          }
          /** 流结束：上报 closed 状态（用 ws-state 复用关闭信号路径不行，这里用特殊事件） */
          sseEventSink(sseEntrySeq, { timestamp: new Date().toISOString(), event: '__closed__', data: '' })
        })()

        /** 返回拆流后的 Response（业务代码正常消费，不受采集影响） */
        return new Response(bodyForCaller, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        })
      }

      /** 非 SSE：异步读 body（不阻塞响应链路），二进制响应智能处理 */
      cloneAndRead(res, (fullBody, encoding, mime) => {
        /** 完整 body 存内存，推送只带摘要（懒加载） */
        let summary: string | undefined = fullBody
        let truncated = false
        if (fullBody !== undefined) {
          const processed = processBody(loadingSeq, fullBody)
          summary = processed.body
          truncated = processed.truncated
        }
        updateSink?.(loadingSeq, {
          status: res.status,
          duration: Date.now() - start,
          resHeaders,
          resBody: summary,
          resBodyEncoding: encoding,
          resBodyMime: mime,
          resBodySize: fullBody?.length,
          bodyTruncated: truncated || undefined,
        })
      })
      return res
    } catch (err) {
      updateSink?.(loadingSeq, {
        status: 0,
        duration: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}

/** 合并 fetch input（Request 对象自带 headers）与 init.headers */
function mergeReqHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const h = toHeaders(init?.headers)
  /** Request 对象的 headers 追加（init 优先，不覆盖） */
  if (typeof input !== 'string' && !(input instanceof URL)) {
    input.headers?.forEach((value, name) => {
      if (!h.has(name)) h.set(name, value)
    })
  }
  return h
}

/** 劫持 XMLHttpRequest */
function installXhrHook(sink: NetworkSink, updateSink?: NetworkUpdateSink): void {
  const Xhr = globalThis.XMLHttpRequest
  if (!Xhr) return
  const originalOpen = Xhr.prototype.open
  const originalSend = Xhr.prototype.send
  const originalSetHeader = Xhr.prototype.setRequestHeader

  /** 在 xhr 实例上挂载采集上下文（用 Symbol 避免冲突） */
  const ctxKey = Symbol('silkpulse-ctx')

  interface XhrCtx {
    url: string
    method: string
    reqBody?: string
    start: number
    /** 收集 setRequestHeader 设置的请求头 */
    reqHeaders: Record<string, string>
    /** loading entry 的 seq，用于 loadend 时更新 */
    loadingSeq: number
  }

  Xhr.prototype.open = function (this: XMLHttpRequest, method: string, url: string, async?: boolean, user?: string | null, password?: string | null): void {
    ;(this as unknown as Record<symbol, XhrCtx>)[ctxKey] = {
      method: method.toUpperCase(),
      url,
      start: 0,
      reqHeaders: {},
      loadingSeq: -1,
    }
    originalOpen.call(this, method, url, async ?? true, user, password)
  }

  /** 劫持 setRequestHeader 收集请求头（交给白名单筛选） */
  Xhr.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
    const ctx = (this as unknown as Record<symbol, XhrCtx>)[ctxKey]
    if (ctx) ctx.reqHeaders[name] = value
    originalSetHeader.call(this, name, value)
  }

  Xhr.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    const ctx = (this as unknown as Record<symbol, XhrCtx>)[ctxKey]
    if (!ctx) {
      originalSend.call(this, body)
      return
    }
    /** 预分配 seq */
    ctx.loadingSeq = seq++
    /** 请求体完整存储 + 摘要推送 */
    let reqBodySummary: string | undefined
    let reqBodyTruncated = false
    if (body != null) {
      const full = stringifyBody(body)
      if (full !== undefined) {
        const { body: processedBody, truncated } = processBody(ctx.loadingSeq, full)
        reqBodySummary = processedBody
        reqBodyTruncated = truncated
      }
    }
    ctx.start = Date.now()

    /** 请求头：过白名单（统一走 pickKeyHeaders 做脱敏） */
    const reqHeaders = pickKeyHeaders(new Headers(ctx.reqHeaders), KEY_REQ_HEADERS, { isRequest: true })

    /** 立即上报 loading entry */
    sink({
      seq: ctx.loadingSeq,
      timestamp: new Date().toISOString(),
      url: ctx.url,
      method: ctx.method,
      status: 0,
      reqHeaders,
      reqBody: reqBodySummary,
      bodyTruncated: reqBodyTruncated || undefined,
      duration: 0,
      kind: 'xhr',
    })

    this.addEventListener('loadend', () => {
      /**
       * 读响应体：responseText 仅在 responseType=''/'text' 时可用，设了
       * 'json'/'arraybuffer'/'blob'/'document' 时读 responseText 会抛
       * InvalidStateError。用 stringifyXhrResponse 统一处理所有 responseType：
       * - text/默认：直接 responseText
       * - json：response（已解析对象，JSON.stringify）
       * - arraybuffer/blob：标记类型+大小
       * - document：标记 XML/HTML
       */
      let fullResBody: string | undefined
      try {
        fullResBody = stringifyXhrResponse(this)
      } catch {
        fullResBody = undefined
      }
      /** 完整响应体存内存，推送摘要 */
      let resBodySummary: string | undefined = fullResBody
      let resTruncated = false
      if (fullResBody !== undefined) {
        const processed = processBody(ctx.loadingSeq, fullResBody)
        resBodySummary = processed.body
        resTruncated = processed.truncated
      }
      /** 响应头：getAllResponseHeaders 返回 "k: v\r\n" 多行文本 */
      let resHeaders: Record<string, string> | undefined
      try {
        const raw = this.getAllResponseHeaders()
        if (raw) resHeaders = pickKeyHeaders(parseRawHeaders(raw), KEY_RES_HEADERS)
      } catch {
        /** 读响应头失败忽略 */
      }
      const err = this.status === 0 ? '请求未完成' : undefined
      updateSink?.(ctx.loadingSeq, {
        status: this.status,
        duration: Date.now() - ctx.start,
        resHeaders,
        resBody: resBodySummary,
        resBodySize: fullResBody?.length,
        bodyTruncated: resTruncated || undefined,
        error: err,
      })
    })

    originalSend.call(this, body)
  }
}

/** WS 帧数据最大截断长度 */
const MAX_WS_FRAME = 500

/** EventSource 连接的完整 URL 集合（供 resource observer 去重） */
const sseUrls = new Set<string>()

/**
 * 劫持全局 WebSocket，采集连接生命周期 + send/recv 帧
 *
 * 用 class extends 保持原型链，readyState/bufferedAmount 等原生 getter 正常工作，
 * instanceof WebSocket 仍成立。静态常量 CONNECTING/OPEN/CLOSING/CLOSED 透传。
 *
 * 连接建立时 sink 一个 WS NetworkEntry（protocol:'ws'），获得稳定 seq，
 * 后续 send/recv/close 通过 wsFrameSink/wsStateSink 增量更新（seq 关联），
 * 与 log-repeat 同模式，避免重发整个 entry。
 */
function installWsHook(sink: NetworkSink, wsFrameSink: WsFrameSink, wsStateSink: WsStateSink): void {
  const OriginalWS = globalThis.WebSocket
  if (!OriginalWS) return

  /** 连接 → 条目 seq 关联（WeakMap 不阻止 GC，连接释放后自动清理） */
  const wsSeqMap = new WeakMap<WebSocket, number>()

  /** 序列化帧 data：文本截断，二进制标记类型+大小 */
  const stringifyWsData = (data: unknown): string => {
    if (typeof data === 'string') {
      return data.length > MAX_WS_FRAME ? data.slice(0, MAX_WS_FRAME) + `…(${data.length})` : data
    }
    if (data instanceof ArrayBuffer) {
      return `[binary ${data.byteLength}B]`
    }
    if (ArrayBuffer.isView(data)) {
      return `[binary ${data.byteLength}B]`
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return `[blob ${data.size}B]`
    }
    return String(data).slice(0, MAX_WS_FRAME)
  }

  class HookedWebSocket extends OriginalWS {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url as string, protocols)
      const urlStr = typeof url === 'string' ? url : url.href
      /**
       * 排除 SDK 自身的 device 连接（/ws/device）——它是调试通道不是业务请求，
       * hook 它会采集到大量 exec/result 噪声，且可能干扰 SDK 的 WS 生命周期。
       */
      if (urlStr.includes('/ws/device')) return
      const entry: NetworkEntry = {
        seq: seq++,
        timestamp: new Date().toISOString(),
        url: urlStr,
        method: urlStr.startsWith('wss') ? 'WSS' : 'WS',
        status: 0,
        duration: 0,
        protocol: 'ws',
        kind: 'ws',
        wsState: OriginalWS.CONNECTING,
        frames: [],
      }
      wsSeqMap.set(this, entry.seq)
      sink(entry)

      /** recv 帧：收到服务端消息 */
      this.addEventListener('message', (ev: MessageEvent) => {
        /**
         * Blob 消息（binaryType='blob' 时的文本/二进制）异步读取再上报，
         * 否则只能标记大小看不到内容（诊断 WS 通信最需要看的就是收到的消息）。
         * ArrayBuffer/Blob 的二进制仍只标记大小（真正的二进制数据文本展示无意义）。
         */
        if (typeof Blob !== 'undefined' && ev.data instanceof Blob) {
          ev.data.text().then(
            (text) => wsFrameSink(entry.seq, {
              timestamp: new Date().toISOString(),
              dir: 'recv',
              data: stringifyWsData(text),
            }),
          )
          return
        }
        wsFrameSink(entry.seq, {
          timestamp: new Date().toISOString(),
          dir: 'recv',
          data: stringifyWsData(ev.data),
        })
      })
      /** close 事件：更新 readyState + 记录事件帧 */
      this.addEventListener('close', () => {
        wsStateSink(entry.seq, OriginalWS.CLOSED)
        wsFrameSink(entry.seq, {
          timestamp: new Date().toISOString(),
          dir: 'event',
          data: 'close',
        })
      })
      /** error 事件：记录（不暴露 error 详情，浏览器安全限制） */
      this.addEventListener('error', () => {
        wsFrameSink(entry.seq, {
          timestamp: new Date().toISOString(),
          dir: 'event',
          data: 'error',
        })
      })
      /** open 事件：CONNECTING → OPEN */
      this.addEventListener('open', () => {
        wsStateSink(entry.seq, OriginalWS.OPEN)
      })
    }

    /** 劫持 send：先调原始 send，成功后追加 send 帧 */
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      super.send(data as string)
      const s = wsSeqMap.get(this)
      if (s !== undefined) {
        wsFrameSink(s, {
          timestamp: new Date().toISOString(),
          dir: 'send',
          data: stringifyWsData(data),
        })
      }
    }
  }

  /** 透传静态常量（CONNECTING/OPEN/CLOSING/CLOSED 是 readonly，用 defineProperty 绕过） */
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
    Object.defineProperty(HookedWebSocket, k, {
      value: OriginalWS[k],
      writable: false,
      configurable: true,
      enumerable: true,
    })
  }
  HookedWebSocket.prototype.constructor = HookedWebSocket

  globalThis.WebSocket = HookedWebSocket as unknown as typeof WebSocket
}

/**
 * 劫持全局 EventSource，采集 SSE 连接生命周期 + message 事件
 *
 * EventSource 是浏览器原生 SSE 客户端，不走 fetch/XHR，必须单独 hook。
 * 与 WS hook 同模式：extends 原生类保持原型链，连接建立时 sink 一个 SSE 条目，
 * 后续 message 事件通过 sseEventSink 增量上报。
 */
function installEventSourceHook(sink: NetworkSink, sseEventSink?: SseEventSink): void {
  const OriginalES = globalThis.EventSource
  if (!OriginalES || !sseEventSink) return

  /** 非 optional 局部引用，避免 TS 在 class constructor 内不能推断 narrowed type */
  const emitSseEvent: SseEventSink = sseEventSink

  /**
   * 每个 HookedEventSource 实例与其 seq 的映射
   * WeakMap 不阻止 GC，连接释放后自动清理
   */
  const esSeqMap = new WeakMap<EventSource, number>()
  /** 记录每个 EventSource 实例已注册采集代理的事件类型（避免重复注册） */
  const hookedTypes = new WeakMap<EventSource, Set<string>>()

  /** 记录 EventSource 连接的完整 URL，供 resource observer 去重 */
  const trackUrl = (url: string) => {
    try { sseUrls.add(new URL(url, location.href).href) } catch { sseUrls.add(url) }
  }

  /**
   * 在原型上一次性包装 addEventListener，拦截所有事件类型
   *
   * EventSource 遇到 `event: update` 触发 type='update' 的事件，不走 message。
   * 重写 prototype.addEventListener 对业务注册的每种事件类型额外注册采集代理。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origAdd: any = OriginalES.prototype.addEventListener
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  OriginalES.prototype.addEventListener = function (this: any, type: string, listener: any, options?: any) {
    const s = esSeqMap.get(this)
    /** 对每种事件类型只注册一次采集代理（避免重复） */
    if (s !== undefined && type !== 'open' && type !== 'error') {
      let types = hookedTypes.get(this)
      if (!types) {
        types = new Set<string>()
        hookedTypes.set(this, types)
      }
      if (!types.has(type)) {
        types.add(type)
        origAdd.call(this, type, (ev: Event) => {
          const msgEv = ev as MessageEvent
          emitSseEvent(s, {
            timestamp: new Date().toISOString(),
            event: type,
            id: msgEv.lastEventId || undefined,
            data: typeof msgEv.data === 'string' ? msgEv.data : String(msgEv.data ?? ''),
          })
        })
      }
    }
    return origAdd.call(this, type, listener, options)
  }

  class HookedEventSource extends OriginalES {
    constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
      super(url, eventSourceInitDict)
      const urlStr = typeof url === 'string' ? url : url.href

      /** 创建 SSE 连接条目（与 fetch SSE 同结构） */
      const sseEntrySeq = seq++
      esSeqMap.set(this, sseEntrySeq)
      sink({
        seq: sseEntrySeq,
        timestamp: new Date().toISOString(),
        url: urlStr,
        method: 'GET',
        status: 200,
        duration: 0,
        kind: 'fetch',
        sseState: 'open',
        events: [],
      })
      trackUrl(urlStr)

      /**
       * 默认注册 message 采集（覆盖 onmessage / 默认事件）。
       * 用 origAdd 直接注册并在 hookedTypes 标记，避免走拦截逻辑导致双重注册。
       */
      const initTypes = new Set<string>(['message'])
      hookedTypes.set(this, initTypes)
      origAdd.call(this, 'message', (ev: MessageEvent) => {
        emitSseEvent(sseEntrySeq, {
          timestamp: new Date().toISOString(),
          event: 'message',
          id: ev.lastEventId || undefined,
          data: typeof ev.data === 'string' ? ev.data : String(ev.data ?? ''),
        })
      })

      /** error/close：readyState=CLOSED 时标记 SSE 流结束 */
      const checkClosed = () => {
        if (this.readyState === OriginalES.CLOSED) {
          emitSseEvent(sseEntrySeq, { timestamp: new Date().toISOString(), event: '__closed__', data: '' })
        }
      }
      origAdd.call(this, 'error', checkClosed)

      /**
       * hook close()：业务代码主动关闭时发 __closed__（close 不触发 error 事件）。
       * close 后 readyState=CLOSED，之后不会有事件产生。
       */
      const origClose = this.close.bind(this)
      this.close = () => {
        emitSseEvent(sseEntrySeq, { timestamp: new Date().toISOString(), event: '__closed__', data: '' })
        return origClose()
      }
    }
  }

  /** 透传静态常量（CONNECTING/OPEN/CLOSED） */
  for (const k of ['CONNECTING', 'OPEN', 'CLOSED'] as const) {
    Object.defineProperty(HookedEventSource, k, {
      value: OriginalES[k],
      writable: false,
      configurable: true,
      enumerable: true,
    })
  }
  HookedEventSource.prototype.constructor = HookedEventSource

  globalThis.EventSource = HookedEventSource as unknown as typeof EventSource
}

/** 构造 NetworkEntry */

/**
 * 读取 XHR 响应体（统一处理所有 responseType）
 *
 * responseType='text' 或 ''（默认）：responseText 直接可用
 * responseType='json'：response 是已解析对象，JSON.stringify 序列化
 * responseType='arraybuffer'：response 是 ArrayBuffer，标记大小
 * responseType='blob'：response 是 Blob，标记类型+大小
 * responseType='document'：response 是 XML/HTML Document，标记类型
 *
 * 不处理 responseType 时 responseText 在非 text 模式下抛 InvalidStateError，
 * 导致 AI 丢失响应体——诊断最关键的信息之一。
 */
function stringifyXhrResponse(xhr: XMLHttpRequest): string | undefined {
  const rt = xhr.responseType
  /** text/默认模式：responseText 直接读（最常见路径，零额外开销） */
  if (rt === '' || rt === 'text') {
    return String(xhr.responseText ?? '')
  }
  /** json：response 已是解析后的对象/数组/null */
  if (rt === 'json') {
    const body = xhr.response
    if (body == null) return undefined
    return typeof body === 'string' ? body : JSON.stringify(body)
  }
  /** arraybuffer：标记字节数（二进制体无文本诊断价值，但有大小线索） */
  if (rt === 'arraybuffer') {
    const buf = xhr.response as ArrayBuffer | null
    return buf ? `[ArrayBuffer ${buf.byteLength}b]` : undefined
  }
  /** blob：标记类型+大小 */
  if (rt === 'blob') {
    const blob = xhr.response as Blob | null
    return blob ? `[Blob ${blob.type} ${blob.size}b]` : undefined
  }
  /** document：XML/HTML 解析结果 */
  if (rt === 'document') {
    const doc = xhr.response as Document | null
    return doc ? `[Document ${doc.documentElement?.tagName ?? '?'}]` : undefined
  }
  return undefined
}

/**
 * 敏感字段名匹配正则：password / passwd / pwd / secret / token / access_token /
 * refresh_token / api_key / apikey / credit / card / cvv / ssn / idcard
 */
const SENSITIVE_KEY_RE = /(?:pass(?:word|wd)?|pwd|secret|token|access_?token|refresh_?token|api_?key|apikey|credit(?:card)?|card(?:number)?|cvv|ssn|idcard)/i

/**
 * 对 JSON 字符串中的敏感字段值做脱敏
 *
 * 尝试 JSON.parse → 遍历字段 → 对匹配 SENSITIVE_KEY_RE 的 key 的值替换为 ***。
 * parse 失败则用正则兜底（覆盖 `{"password":"xxx"}` 这类常见模式）。
 */
function redactSensitiveJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return raw
    const redacted = redactObject(parsed)
    return JSON.stringify(redacted)
  } catch {
    /** 非 JSON 或超大字符串，用正则兜底替换敏感字段 */
    return raw.replace(
      /("(?:pass(?:word|wd)?|pwd|secret|token|access_?token|refresh_?token|api_?key|apikey)"\s*:\s*")[^"]*(")/gi,
      '$1***$2',
    )
  }
}

/** 递归脱敏对象中的敏感字段值 */
function redactObject<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map(redactObject) as unknown as T
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_RE.test(key) && typeof value === 'string') {
        result[key] = '***'
      } else {
        result[key] = redactObject(value)
      }
    }
    return result as unknown as T
  }
  return obj
}

/** 对 URLSearchParams 字符串中的敏感参数值做脱敏 */
function redactUrlSearchParams(qs: string): string {
  try {
    const params = new URLSearchParams(qs)
    let changed = false
    for (const key of params.keys()) {
      if (SENSITIVE_KEY_RE.test(key)) {
        params.set(key, '***')
        changed = true
      }
    }
    return changed ? params.toString() : qs
  } catch {
    return qs
  }
}

/** 安全 stringify 请求体（不截断，完整存储） */
function stringifyBody(body: XMLHttpRequestBodyInit | ReadableStream<unknown> | Document): string {
  try {
    if (typeof body === 'string') {
      /** 对 JSON body 中的敏感字段做脱敏（密码、token 等） */
      return redactSensitiveJson(body)
    }
    if (body instanceof URLSearchParams) return redactUrlSearchParams(body.toString())
    if (body instanceof FormData) return stringifyFormData(body)
    if (body instanceof Blob) return `[Blob ${body.type}]`
    if (body instanceof ArrayBuffer) return `[ArrayBuffer ${(body as ArrayBuffer).byteLength}b]`
    return String(body)
  } catch {
    return '[body 不可读]'
  }
}

/**
 * 序列化 FormData —— 列出字段名 + 文件字段的文件名
 *
 * 只列 key 和文件名，不读值（隐私 + 体积控制）。诊断表单提交时，知道
 * "提交了哪些字段"和"文件字段传了什么文件"比知道具体值更有价值
 * （能定位"漏传字段""文件名编码错误"等问题）。
 * 格式：[FormData: username, avatar=<photo.jpg>, token]
 */
function stringifyFormData(form: FormData): string {
  const parts: string[] = []
  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      /** 文件字段：key=<文件名>，文件名有诊断价值（编码错误/缺失一目了然） */
      parts.push(`${key}=<${value.name}>`)
    } else {
      parts.push(key)
    }
  }
  return `[FormData: ${parts.join(', ')}]`
}

/**
 * 克隆 Request 并读取 body 文本（不消费原始 body stream）
 *
 * Request 的 body 是 ReadableStream，直接读会消费它，导致后续 fetch 拿不到 body。
 * clone() 创建副本，读副本不影响原始请求。
 */
async function readRequestBodyClone(req: Request): Promise<string | undefined> {
  const cloned = req.clone()
  return await cloned.text()
}

/**
 * 二进制响应体大小上限（base64 编码后）。
 * 图片等 base64 体积膨胀约 4/3 倍，适当放大上限保证常见图标/小图可预览。
 */
const MAX_BINARY_BODY = 32_000

/** 文本类 MIME 前缀（这些类型用 .text() 读取有诊断价值） */
const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/x-www-form-urlencoded', 'application/ld+json']

/** 可预览的图片 MIME（读为 base64 data URL 在控制台 <img> 预览） */
const IMAGE_MIME_PREFIX = 'image/'

/** 判断 content-type 是否为文本类 */
function isTextContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(';')[0].trim()
  return TEXT_MIME_PREFIXES.some((p) => ct.startsWith(p))
}

/** 判断 content-type 是否为图片类 */
function isImageContentType(contentType: string): boolean {
  return contentType.toLowerCase().split(';')[0].trim().startsWith(IMAGE_MIME_PREFIX)
}

/** 克隆响应并异步读取 body（不消费原始 body），二进制响应智能处理 */
function cloneAndRead(
  res: Response,
  cb: (body: string | undefined, encoding?: 'base64' | 'info', mime?: string) => void,
): void {
  try {
    const contentType = res.headers.get('content-type') ?? ''

    /** 图片类：读为 base64 data URL，控制台可直接 <img> 预览 */
    if (isImageContentType(contentType)) {
      const mime = contentType.toLowerCase().split(';')[0].trim()
      res
        .clone()
        .blob()
        .then((blob) => {
          /** 超大图片不读内容，只报信息（避免 WS 消息过大） */
          if (blob.size > MAX_BINARY_BODY) {
            cb(`[图片 ${mime} ${blob.size}b]`, 'info', mime)
            return
          }
          const reader = new FileReader()
          reader.onload = () => cb(reader.result as string, 'base64', mime)
          reader.onerror = () => cb(`[图片 ${mime} ${blob.size}b]`, 'info', mime)
          reader.readAsDataURL(blob)
        })
        .catch(() => cb(undefined))
      return
    }

    /** 非文本二进制（字体/wasm/zip 等）：只报类型+大小信息 */
    if (contentType && !isTextContentType(contentType)) {
      const mime = contentType.toLowerCase().split(';')[0].trim()
      res
        .clone()
        .blob()
        .then((blob) => cb(`[二进制 ${mime} ${blob.size}b]`, 'info', mime))
        .catch(() => cb(undefined))
      return
    }

    /** 文本类：正常 .text() 读取（不截断，完整存储） */
    res
      .clone()
      .text()
      .then((text) => cb(text))
      .catch(() => cb(undefined))
  } catch {
    cb(undefined)
  }
}

/** 截断（仅用于 header 值，body 不截断走懒加载） */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '…'
}
