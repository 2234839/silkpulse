/**
 * source map 解析助手 —— 把压缩代码位置映射回原始源码位置
 *
 * 两种用法：
 * 1. 错误自动解析：error-catcher 捕获到带 source/line/col 的错误，异步解析填充 mapped
 * 2. exec 辅助函数：AI 主动调用 __silkpulse_sourcemap(line, col, sourceUrl)
 *
 * 浏览器端解析的合理性：被调试页面同源可访问自己的 .map 文件（server 端通常无法访问线上 .map）
 * 解析失败静默（map 不公开 / 跨域 / 无 map 时），绝不阻塞错误采集主流程
 */

import type { SourceMapPosition } from '@silkpulse/shared'
import { parseSourceMap, originalPositionFor, type SourceMapData } from './source-map-consumer.js'

/** source map 缓存：mapUrl → 解析结果（避免重复 fetch + 解析同一文件） */
const mapCache = new Map<string, SourceMapData | null>()

/**
 * 带超时的 fetch
 *
 * source map 解析中遇到的 fetch（脚本内容 / .map 文件）可能因目标站点慢、跨域挂起、
 * 服务器无响应而无限期 pending——错误风暴时每个错误都触发一次解析，挂起的 promise 会累积泄漏。
 * 超时后 AbortController 中止请求，fetch 抛 AbortError，由调用方 catch 走静默回退。
 */
const FETCH_TIMEOUT_MS = 8000
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从脚本 URL 或源文件 URL 推断 source map URL
 * 策略：
 * 1. 同 URL 加 .map（最常见：app.js → app.js.map）
 * 2. 若 URL 含 query，保留 query 前加 .map
 */
function guessMapUrl(sourceUrl: string): string {
  return `${sourceUrl}.map`
}

/**
 * 从脚本内容末尾的 //# sourceMappingURL= 注释提取 map URL
 * 返回绝对 URL（相对脚本 URL 解析）
 */
function extractSourceMappingUrl(scriptText: string, scriptUrl: string): string | null {
  const match = scriptText.match(/\/\/[#@]\s*sourceMappingURL=(\S+)/)
  if (!match) return null
  try {
    return new URL(match[1], scriptUrl).href
  } catch {
    return match[1]
  }
}

/**
 * 获取并解析 source map
 * 返回 null 表示无法获取（跨域/404/无 map）
 */
async function loadSourceMap(mapUrl: string): Promise<SourceMapData | null> {
  if (mapCache.has(mapUrl)) return mapCache.get(mapUrl) ?? null
  try {
    const res = await fetchWithTimeout(mapUrl)
    if (!res.ok) {
      mapCache.set(mapUrl, null)
      return null
    }
    const raw = await res.json() as {
      sources?: string[]
      names?: string[]
      mappings?: string
      sourceRoot?: string
    }
    const data = parseSourceMap(raw)
    mapCache.set(mapUrl, data)
    return data
  } catch {
    /** 跨域 / 网络错误 / JSON 解析失败 —— 静默，缓存 null 避免重试 */
    mapCache.set(mapUrl, null)
    return null
  }
}

/**
 * 给定 source URL + 行列，查找 source map URL 并解析原始位置
 * sourceUrl 是错误堆栈里的文件地址（如 http://example.com/app.min.js）
 */
export async function resolveOriginalPosition(
  sourceUrl: string,
  /** 1-based 行号 */
  line: number,
  /** 0-based 列号 */
  column: number
): Promise<SourceMapPosition | null> {
  /** 先尝试从脚本内容读 sourceMappingURL 注释（最准确），失败则用 .map 猜测 */
  let mapUrl: string | null = null
  try {
    const res = await fetchWithTimeout(sourceUrl)
    if (res.ok) {
      const text = await res.text()
      mapUrl = extractSourceMappingUrl(text, sourceUrl)
    }
  } catch {
    /** 跨域无法读脚本内容 / 超时 —— 回退到 .map 猜测 */
  }
  if (!mapUrl) mapUrl = guessMapUrl(sourceUrl)

  const map = await loadSourceMap(mapUrl)
  if (!map) return null

  const pos = originalPositionFor(map, line, column)
  if (!pos) return null
  return {
    source: pos.source,
    line: pos.line,
    column: pos.column,
    name: pos.name,
  }
}

/**
 * exec 辅助函数用：批量解析堆栈里的多个位置
 * 返回紧凑文本（AI 直接读）
 */
export async function resolveStack(
  frames: Array<{ url: string; line: number; col: number }>
): Promise<string[]> {
  const results: string[] = []
  for (const f of frames) {
    const pos = await resolveOriginalPosition(f.url, f.line, f.col)
    if (pos) {
      const name = pos.name ? ` ${pos.name}` : ''
      results.push(`${f.url}:${f.line}:${f.col} → ${pos.source}:${pos.line}:${pos.column}${name}`)
    } else {
      results.push(`${f.url}:${f.line}:${f.col} →（无 source map 或解析失败）`)
    }
  }
  return results
}
