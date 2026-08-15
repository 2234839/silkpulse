/**
 * HTTP gzip 压缩/解压工具
 *
 * 响应压缩：浏览器自动发送 Accept-Encoding: gzip，服务端压缩响应体，
 * 浏览器自动解压。对 JSON/文本压缩率通常 70-90%。
 *
 * 请求压缩：客户端（如 SDK / AI agent）可手动 gzip 请求体并设置
 * Content-Encoding: gzip，服务端在此统一解压。
 *
 * 阈值：小于 GZIP_THRESHOLD 的消息不压缩（gzip 头 18B + 簿记开销，太小反而变大）。
 */

import { gzipSync, gunzipSync } from 'node:zlib'

/** 小于此大小不压缩（gzip 头 18B + 簿记开销，太小反而变大） */
export const GZIP_THRESHOLD = 512

/** 最小化的请求头视图（headers 已预读为 plain object） */
export interface HeaderLike {
  headers: Record<string, string>
}

/**
 * 判断请求是否接受 gzip 响应
 */
export function acceptsGzip(req: HeaderLike): boolean {
  const enc = req.headers['accept-encoding'] ?? ''
  return enc.includes('gzip')
}

/**
 * 判断请求体是否 gzip 编码
 */
export function isGzipped(req: HeaderLike): boolean {
  return req.headers['content-encoding'] === 'gzip'
}

/**
 * 压缩响应体（如果客户端支持且数据足够大）
 *
 * 返回 { body, headers } —— 调用方合并 headers 后一次写入
 */
export function maybeGzipResponse(
  req: HeaderLike,
  body: string | Buffer,
  extraHeaders: Record<string, string> = {},
): { body: string | Buffer; headers: Record<string, string> } {
  const headers = { ...extraHeaders }
  /** 超过阈值且客户端支持 gzip 才压缩 */
  if (typeof body === 'string' && body.length >= GZIP_THRESHOLD && acceptsGzip(req)) {
    const compressed = gzipSync(Buffer.from(body, 'utf-8'))
    headers['Content-Encoding'] = 'gzip'
    headers['Vary'] = 'Accept-Encoding'
    return { body: compressed, headers }
  }
  if (body instanceof Buffer && body.length >= GZIP_THRESHOLD && acceptsGzip(req)) {
    const compressed = gzipSync(body)
    headers['Content-Encoding'] = 'gzip'
    headers['Vary'] = 'Accept-Encoding'
    return { body: compressed, headers }
  }
  return { body, headers }
}

/**
 * 解压 gzip 请求体（如果 Content-Encoding: gzip）
 */
export function maybeGunzipRequest(
  req: HeaderLike,
  body: Buffer,
): Buffer {
  if (isGzipped(req)) {
    return gunzipSync(body)
  }
  return body
}
