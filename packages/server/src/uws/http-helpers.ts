/**
 * uWS HTTP 请求/响应的统一抽象层
 *
 * 把 uWS 的 HttpResponse/HttpRequest 包装成旧代码熟悉的形态：
 * - 异步 handler 必须先 attach onAborted（uWS 铁律，否则进程 abort）
 * - readBody 收集 POST body（兼容 gzip 请求体 + 2MB 上限）
 * - sendJson/sendText/writeHead+end 语义与 node:http 版一致（含 gzip）
 *
 * 关键差异（相对 node:http）：
 * - res 写完 status/headers 后必须一次性 end（uWS 是线性 buffer）
 * - 客户端中断时 res 不可再用 —— onAborted 里置标记
 */

import type { HttpResponse, HttpRequest } from 'uWebSockets.js'
import { maybeGzipResponse, maybeGunzipRequest } from '../gzip.js'

/** 请求上下文：包装 uWS req/res + 预解析的 url/method/headers */
export interface Ctx {
  res: HttpResponse
  req: HttpRequest
  /** 完整 URL（含 query），如 /api/devices?token=x */
  url: string
  /** URL 对象（懒解析后缓存） */
  parsedUrl: URL
  /** 小写 HTTP 方法 */
  method: string
  /** 预读的请求头（uWS getHeader 每次调用都有 FFI 开销，读一次缓存） */
  headers: Record<string, string>
  /** 响应是否已结束（end 调用后禁止再碰 res） */
  responded: boolean
  /** 连接是否已中断 */
  aborted: boolean
  /** 缓存的请求体（项目管理 API 前置读取用） */
  bodyBuf?: Buffer
}

/**
 * 从 uWS req 构建请求上下文
 *
 * uWS 的 req 只在 handler 同步阶段有效 —— 所有需要的信息（url/method/headers）
 * 必须在这里立刻读出来存到 Ctx，异步阶段只能用 Ctx。
 */
export function createCtx(res: HttpResponse, req: HttpRequest): Ctx {
  const url = req.getUrl() + (req.getQuery() ? '?' + req.getQuery() : '')
  const headers: Record<string, string> = {}
  req.forEach((key, value) => {
    headers[key] = value
  })
  return {
    res,
    req,
    url,
    parsedUrl: new URL(url, 'http://localhost'),
    method: req.getMethod().toUpperCase(),
    headers,
    responded: false,
    aborted: false,
  }
}

/**
 * 挂中断回调 —— 任何异步 handler 返回前必须调用（uWS 铁律）
 *
 * 已挂过则幂等（多个路由层都想挂时只有第一个生效，后续逻辑由 aborted 标记判断）。
 */
export function onAborted(ctx: Ctx, fn?: () => void): void {
  ctx.res.onAborted(() => {
    ctx.aborted = true
    ctx.responded = true
    fn?.()
  })
}

/**
 * 读取 POST body（带 2MB 上限 + gzip 解压 + 中断保护）
 *
 * 返回 { body, oversize }：oversize=true 时调用方应回 413。
 * 中断时 resolve 空串，不让 promise 泄漏。
 */
export function readBody(ctx: Ctx): Promise<{ body: string; oversize: boolean }> {
  const MAX_BODY = 2 * 1024 * 1024
  return new Promise((resolve) => {
    /** uWS 的 chunk 是 ArrayBuffer 且回调返回后被 neuter，必须立刻拷贝 */
    const chunks: Buffer[] = []
    let totalSize = 0
    let settled = false
    const finish = (body: string, oversize: boolean) => {
      if (settled) return
      settled = true
      resolve({ body, oversize })
    }
    onAborted(ctx, () => finish('', false))
    ctx.res.onData((chunk, isLast) => {
      if (totalSize > MAX_BODY) return
      const buf = Buffer.from(chunk)
      totalSize += buf.length
      if (totalSize > MAX_BODY) {
        /** 超限：停止累加，让调用方回 413（不 RST 连接） */
        finish('', true)
        return
      }
      chunks.push(buf)
      if (isLast) {
        const merged = Buffer.concat(chunks)
        /**
         * 解压可能因 zip bomb 触发 maxOutputLength 的 RangeError，
         * 恶意请求在这里就地拒绝（413），不让异常冒泡炸掉 onDrain 之外的回调链
         */
        let decompressed: Buffer
        try {
          decompressed = maybeGunzipRequest({ headers: ctx.headers }, merged)
        } catch {
          finish('', true)
          return
        }
        ctx.bodyBuf = decompressed
        finish(decompressed.toString('utf-8'), false)
      }
    })
  })
}

/**
 * 通用响应发送：gzip 协商 + 写头 + end（一步到位）
 *
 * uWS 的 res 写 status → headers → end 必须在同步段完成，
 * 所以这里 cork 起来（uWS 推荐的批处理方式，减少 syscall）。
 */
export function writeResponse(
  ctx: Ctx,
  status: number,
  headers: Record<string, string>,
  body: string | Buffer,
): void {
  if (ctx.responded || ctx.aborted) return
  ctx.responded = true
  const statusText = STATUS_TEXTS[status] ?? 'Unknown'
  ctx.res.cork(() => {
    ctx.res.writeStatus(`${status} ${statusText}`)
    for (const [k, v] of Object.entries(headers)) {
      ctx.res.writeHeader(k, v)
    }
    ctx.res.end(body)
  })
}

/** 常用状态码文本（uWS writeStatus 需要完整 "200 OK" 形态） */
const STATUS_TEXTS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  500: 'Internal Server Error',
}

/** 发送 JSON 响应（自动 gzip 压缩 + CORS） */
export function sendJson(ctx: Ctx, data: unknown, status = 200): void {
  const json = JSON.stringify(data)
  const { body, headers } = maybeGzipResponse(
    { headers: ctx.headers },
    json,
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  )
  writeResponse(ctx, status, headers, body)
}

/** 发送纯文本响应（自动 gzip 压缩 + CORS） */
export function sendText(ctx: Ctx, text: string, status = 200): void {
  const { body, headers } = maybeGzipResponse(
    { headers: ctx.headers },
    text,
    {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  )
  writeResponse(ctx, status, headers, body)
}

/** 204 空响应（CORS 预检用） */
export function sendNoContent(ctx: Ctx, headers: Record<string, string> = {}): void {
  if (ctx.responded || ctx.aborted) return
  ctx.responded = true
  ctx.res.cork(() => {
    ctx.res.writeStatus('204 No Content')
    for (const [k, v] of Object.entries(headers)) {
      ctx.res.writeHeader(k, v)
    }
    ctx.res.endWithoutBody()
  })
}

/** 304 Not Modified（ETag 命中，无 body） */
export function sendNotModified(ctx: Ctx, headers: Record<string, string>): void {
  if (ctx.responded || ctx.aborted) return
  ctx.responded = true
  ctx.res.cork(() => {
    ctx.res.writeStatus('304 Not Modified')
    for (const [k, v] of Object.entries(headers)) {
      ctx.res.writeHeader(k, v)
    }
    ctx.res.endWithoutBody()
  })
}

/** 二进制响应（截图等） */
export function sendBinary(
  ctx: Ctx,
  status: number,
  contentType: string,
  binary: Buffer,
  extraHeaders: Record<string, string> = {},
): void {
  writeResponse(ctx, status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  }, binary)
}
