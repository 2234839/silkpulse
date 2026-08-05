/**
 * network 采集 —— 劫持 fetch 和 XMLHttpRequest，组装 HAR 风格条目
 *
 * 采集核心字段：url / method / status / reqHeaders / reqBody / resHeaders / resBody / duration / error
 * headers 只采诊断关键头（content-type / authorization / cookie / 自定义 x-* 等），
 * 平衡 AI 复现请求所需信息与隐私/体积。
 */

import type { NetworkEntry } from '@clarosight/shared'

type NetworkSink = (entry: NetworkEntry) => void

/** 内部序号计数器 */
let seq = 0

/** 响应体最大截断长度 */
const MAX_RES_BODY = 1000
/** 请求体最大截断长度 */
const MAX_REQ_BODY = 500
/** 单个 header 值最大截断长度 */
const MAX_HEADER_LEN = 200

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
 * 安装 network 采集（fetch + xhr 双劫持）
 */
export function installNetworkCollector(sink: NetworkSink): void {
  installFetchHook(sink)
  installXhrHook(sink)
}

/** 劫持全局 fetch */
function installFetchHook(sink: NetworkSink): void {
  const originalFetch = globalThis.fetch
  if (!originalFetch) return

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET')).toUpperCase()
    const reqBody = init?.body ? stringifyBody(init.body, MAX_REQ_BODY) : undefined
    /** 请求头：合并 input（若是 Request 对象）与 init 的 headers */
    const reqHeaders = pickKeyHeaders(mergeReqHeaders(input, init), KEY_REQ_HEADERS, { isRequest: true })
    const start = Date.now()

    try {
      const res = await originalFetch(input as RequestInfo, init)
      /** 响应头 */
      const resHeaders = pickKeyHeaders(res.headers, KEY_RES_HEADERS)
      /** 异步读 body（不阻塞响应链路） */
      cloneAndRead(res, (resBody) => {
        sink(makeEntry(url, method, res.status, reqBody, resBody, Date.now() - start, reqHeaders, resHeaders))
      })
      return res
    } catch (err) {
      sink(makeEntry(url, method, 0, reqBody, undefined, Date.now() - start, reqHeaders, undefined, err instanceof Error ? err.message : String(err)))
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
function installXhrHook(sink: NetworkSink): void {
  const Xhr = globalThis.XMLHttpRequest
  if (!Xhr) return
  const originalOpen = Xhr.prototype.open
  const originalSend = Xhr.prototype.send
  const originalSetHeader = Xhr.prototype.setRequestHeader

  /** 在 xhr 实例上挂载采集上下文（用 Symbol 避免冲突） */
  const ctxKey = Symbol('clarosight-ctx')

  interface XhrCtx {
    url: string
    method: string
    reqBody?: string
    start: number
    /** 收集 setRequestHeader 设置的请求头 */
    reqHeaders: Record<string, string>
  }

  Xhr.prototype.open = function (this: XMLHttpRequest, method: string, url: string, async?: boolean, user?: string | null, password?: string | null): void {
    ;(this as unknown as Record<symbol, XhrCtx>)[ctxKey] = {
      method: method.toUpperCase(),
      url,
      start: 0,
      reqHeaders: {},
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
    ctx.reqBody = body != null ? stringifyBody(body, MAX_REQ_BODY) : undefined
    ctx.start = Date.now()

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
      let resBody: string | undefined
      try {
        resBody = stringifyXhrResponse(this, MAX_RES_BODY)
      } catch {
        resBody = undefined
      }
      /** 请求头：过白名单（统一走 pickKeyHeaders 做脱敏） */
      const reqHeaders = pickKeyHeaders(new Headers(ctx.reqHeaders), KEY_REQ_HEADERS, { isRequest: true })
      /** 响应头：getAllResponseHeaders 返回 "k: v\r\n" 多行文本 */
      let resHeaders: Record<string, string> | undefined
      try {
        const raw = this.getAllResponseHeaders()
        if (raw) resHeaders = pickKeyHeaders(parseRawHeaders(raw), KEY_RES_HEADERS)
      } catch {
        /** 读响应头失败忽略 */
      }
      const err = this.status === 0 ? '请求未完成' : undefined
      sink(makeEntry(ctx.url, ctx.method, this.status, ctx.reqBody, resBody, Date.now() - ctx.start, reqHeaders, resHeaders, err))
    })

    originalSend.call(this, body)
  }
}

/** 构造 NetworkEntry */
function makeEntry(
  url: string,
  method: string,
  status: number,
  reqBody?: string,
  resBody?: string,
  duration?: number,
  reqHeaders?: Record<string, string>,
  resHeaders?: Record<string, string>,
  error?: string,
): NetworkEntry {
  return {
    seq: seq++,
    timestamp: new Date().toISOString(),
    url,
    method,
    status,
    reqHeaders,
    reqBody,
    resHeaders,
    resBody,
    duration: duration ?? 0,
    error,
  }
}

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
function stringifyXhrResponse(xhr: XMLHttpRequest, maxLen: number): string | undefined {
  const rt = xhr.responseType
  /** text/默认模式：responseText 直接读（最常见路径，零额外开销） */
  if (rt === '' || rt === 'text') {
    return truncate(String(xhr.responseText ?? ''), maxLen)
  }
  /** json：response 已是解析后的对象/数组/null */
  if (rt === 'json') {
    const body = xhr.response
    if (body == null) return undefined
    return truncate(typeof body === 'string' ? body : JSON.stringify(body), maxLen)
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

/** 安全 stringify 请求体 */
function stringifyBody(body: XMLHttpRequestBodyInit | ReadableStream<unknown> | Document, maxLen: number): string {
  try {
    if (typeof body === 'string') return truncate(body, maxLen)
    if (body instanceof URLSearchParams) return truncate(body.toString(), maxLen)
    if (body instanceof FormData) return '[FormData]'
    if (body instanceof Blob) return `[Blob ${body.type}]`
    if (body instanceof ArrayBuffer) return `[ArrayBuffer ${(body as ArrayBuffer).byteLength}b]`
    return String(body).slice(0, maxLen)
  } catch {
    return '[body 不可读]'
  }
}

/** 克隆响应并异步读取 body（不消费原始 body） */
function cloneAndRead(res: Response, cb: (body: string | undefined) => void): void {
  try {
    res
      .clone()
      .text()
      .then((text) => cb(truncate(text, MAX_RES_BODY)))
      .catch(() => cb(undefined))
  } catch {
    cb(undefined)
  }
}

/** 截断 */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '…'
}
