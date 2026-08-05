/**
 * network 采集 —— 劫持 fetch 和 XMLHttpRequest，组装 HAR 风格条目
 *
 * 借鉴 PageSpy 的 network 采集思路，简化为 aira 需要的核心字段：
 * url / method / status / reqBody / resBody(截断) / duration / error
 *
 * 不采集完整 headers（隐私 + 体积），只留 status 和 body 摘要供 AI 诊断。
 */

import type { NetworkEntry } from '@clarosight/shared'

type NetworkSink = (entry: NetworkEntry) => void

/** 内部序号计数器 */
let seq = 0

/** 响应体最大截断长度 */
const MAX_RES_BODY = 1000
/** 请求体最大截断长度 */
const MAX_REQ_BODY = 500

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
    const start = Date.now()

    try {
      const res = await originalFetch(input as RequestInfo, init)
      /** 异步读 body（不阻塞响应链路） */
      cloneAndRead(res, (resBody) => {
        sink(makeEntry(url, method, res.status, reqBody, resBody, Date.now() - start))
      })
      return res
    } catch (err) {
      sink(makeEntry(url, method, 0, reqBody, undefined, Date.now() - start, err instanceof Error ? err.message : String(err)))
      throw err
    }
  }
}

/** 劫持 XMLHttpRequest */
function installXhrHook(sink: NetworkSink): void {
  const Xhr = globalThis.XMLHttpRequest
  if (!Xhr) return
  const originalOpen = Xhr.prototype.open
  const originalSend = Xhr.prototype.send

  /** 在 xhr 实例上挂载采集上下文（用 Symbol 避免冲突） */
  const ctxKey = Symbol('clarosight-ctx')

  interface XhrCtx {
    url: string
    method: string
    reqBody?: string
    start: number
  }

  Xhr.prototype.open = function (this: XMLHttpRequest, method: string, url: string, async?: boolean, user?: string | null, password?: string | null): void {
    ;(this as unknown as Record<symbol, XhrCtx>)[ctxKey] = {
      method: method.toUpperCase(),
      url,
      start: 0,
    }
    originalOpen.call(this, method, url, async ?? true, user, password)
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
      let resBody: string | undefined
      try {
        resBody = truncate(String(this.responseText ?? ''), MAX_RES_BODY)
      } catch {
        resBody = undefined
      }
      const err = this.status === 0 ? '请求未完成' : undefined
      sink(makeEntry(ctx.url, ctx.method, this.status, ctx.reqBody, resBody, Date.now() - ctx.start, err))
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
  error?: string,
): NetworkEntry {
  return {
    seq: seq++,
    timestamp: new Date().toISOString(),
    url,
    method,
    status,
    reqBody,
    resBody,
    duration: duration ?? 0,
    error,
  }
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
