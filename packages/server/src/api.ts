/**
 * HTTP API 路由 —— AI skill 的调用入口
 *
 * 所有 /api/* 端点返回 JSON（snapshot 除外，返回 text/plain 供 AI 直接读）。
 * exec 端点通过设备的 WS 下发指令并等待回传（内存 promise 模式）。
 */

import type { IncomingMessage, ServerResponse } from 'http'
import type { DeviceRegistry } from './device-registry.js'
import { sendSnapshot } from './snapshot-text.js'

/**
 * POST body 最大字节数
 *
 * exec 诊断代码实际几 KB，2MB 上限给 AI 生成脚本留充足余量。
 * 超限直接 413 终止读取，防止超大/恶意 POST 撑爆 server 内存。
 */
const MAX_BODY = 2 * 1024 * 1024

/**
 * 读取 POST body，带大小上限 + 错误/中断保护
 *
 * 返回 { body, oversize }：
 * - oversize=true 表示超 MAX_BODY，调用方应回 413
 * - 客户端中断（aborted/error）时 resolve 空串，不让 promise 泄漏
 */
function readBody(req: IncomingMessage): Promise<{ body: string; oversize: boolean }> {
  return new Promise((resolve) => {
    let body = ''
    let oversized = false
    req.on('data', (chunk) => {
      if (oversized) return
      body += chunk
      if (body.length > MAX_BODY) {
        /** 超限：停止累加，resolve oversize 让调用方回 413。
         * 不用 req.destroy()——它会 RST 连接导致客户端 fetch 报 ECONNRESET，
         * 而是停止读取，让调用方正常 sendJson(413) 结束响应。 */
        oversized = true
        resolve({ body: '', oversize: true })
      }
    })
    req.on('end', () => resolve({ body, oversize: false }))
    /** 客户端中断或连接错误：resolve 空串，避免 promise 永久挂起泄漏 */
    req.on('aborted', () => resolve({ body: '', oversize: false }))
    req.on('error', () => resolve({ body: '', oversize: false }))
  })
}

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(data))
}

/** 发送纯文本响应 */
function sendText(res: ServerResponse, text: string, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(text)
}

/** exec 超时（ms） */
const EXEC_TIMEOUT = 10000

/**
 * 处理 /api/* 路由
 * 返回 true 表示已处理，false 表示非 API 路径
 * onDeviceListChanged：修改 tags/note 后通知控制台刷新设备列表
 */
export async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  registry: DeviceRegistry,
  onDeviceListChanged?: () => void
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  if (!pathname.startsWith('/api/')) return false

  /** CORS 预检 */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return true
  }

  /** /api/echo —— 回显端点（测试 POST body 采集，返回接收到的 body） */
  if (pathname === '/api/echo') {
    const { body, oversize } = await readBody(req)
    if (oversize) { sendJson(res, { error: 'body 超过 2MB 上限' }, 413); return true }
    /** body 可能是任意格式（JSON / FormData multipart / 纯文本），非 JSON 时原样返回文本 */
    let received: unknown = body || null
    if (body) {
      try { received = JSON.parse(body) } catch { /** 非 JSON，保留原始文本 */ }
    }
    sendJson(res, { ok: true, received, time: Date.now() })
    return true
  }

  /** /api/devices —— 列出所有在线设备 + 最近下线设备（供 AI 判断接入状态） */
  if (pathname === '/api/devices' && req.method === 'GET') {
    sendJson(res, {
      devices: registry.list(),
      recentlyOffline: registry.listOffline(),
    })
    return true
  }

  /** 解析 /api/devices/:id/xxx */
  const match = pathname.match(/^\/api\/devices\/([^/]+)(?:\/(.+))?$/)
  if (!match) {
    sendJson(res, { error: 'Not found' }, 404)
    return true
  }
  const [, deviceId, action] = match
  const device = registry.get(deviceId)
  if (!device) {
    sendJson(res, { error: `设备 ${deviceId} 不在线` }, 404)
    return true
  }

  switch (action) {
    /** 设备详情 */
    case undefined: {
      sendJson(res, device.info)
      return true
    }

    /** /api/devices/:id/snapshot —— 页面快照（text/plain，AI 直接读） */
    case 'snapshot': {
      const result = await execOnDevice(registry, deviceId, 'return __clarosight_snapshot()')
      if (!result.success) {
        sendText(res, `[快照失败] ${result.error}`, 500)
        return true
      }
      /** 快照结果序列化为 compact 文本 */
      const text = sendSnapshot(result.result)
      sendText(res, text)
      return true
    }

    /**
     * /api/devices/:id/element/tree?idx=N —— 取某个节点的直接子元素列表
     *
     * 不传 idx 时取 documentElement（<html>）的直接子元素（首屏）。
     * 每个元素通过 __clarosight_ensureIdx 打稳定 idx，供后续 inspect/操作复用。
     * 返回 JSON：[{idx, tag, id, classes, childCount, text?}]
     */
    case 'element/tree': {
      const parentIdx = url.searchParams.get('idx')
      /** shadow=1 时取 shadowRoot 子元素（而非普通 children） */
      const shadow = url.searchParams.get('shadow') === '1'
      /** filter 非空时走递归搜索模式（忽略 idx/shadow） */
      const filter = url.searchParams.get('filter')?.trim()
      const code = filter
        ? buildElementFilterCode(filter)
        : buildElementTreeCode(parentIdx ? Number(parentIdx) : null, shadow)
      const result = await execOnDevice(registry, deviceId, code)
      if (!result.success) {
        sendJson(res, { error: result.error }, 500)
        return true
      }
      /** exec 的 result 是序列化后的 JSON 字符串，直接透传 */
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
      res.end(result.result ?? '[]')
      return true
    }

    /**
     * /api/devices/:id/element/inspect?idx=N —— 取单个元素的诊断信息
     *
     * 返回 JSON：{idx, tag, id, classes, visibility, computedStyle, box, ancestors}
     * 诊断 AI 最关心的"为什么元素看起来不对"。
     */
    case 'element/inspect': {
      const idx = url.searchParams.get('idx')
      if (!idx) {
        sendJson(res, { error: '缺少 idx 参数' }, 400)
        return true
      }
      const code = buildElementInspectCode(Number(idx))
      const result = await execOnDevice(registry, deviceId, code)
      if (!result.success) {
        sendJson(res, { error: result.error }, 500)
        return true
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
      res.end(result.result ?? '{}')
      return true
    }

    /**
     * /api/devices/:id/storage —— 读写远程设备存储
     *
     * GET ?type=local|session|cookie → 返回完整 { key: value }（不截断，console UI 编辑用）
     * POST {action:'set'|'delete', type, key, value?} → 写入/删除
     *
     * 与 SDK 的 __clarosight_storage 区分：
     * - 那个给 AI 用（截断到 200 字符防撑爆上下文）
     * - 这个给 console UI 用（完整值，编辑需要）
     *
     * cookie 的 set 支持 path/expires（可选），delete 通过设 expires 为过去时间实现。
     * HttpOnly cookie 读不到也写不了（浏览器限制），前端需提示。
     */
    case 'storage': {
      const type = url.searchParams.get('type') ?? 'local'
      if (type !== 'local' && type !== 'session' && type !== 'cookie' && type !== 'indexeddb') {
        sendJson(res, { error: 'type 必须是 local/session/cookie/indexeddb' }, 400)
        return true
      }

      if (req.method === 'GET') {
        const code = buildStorageReadCode(type)
        const result = await execOnDevice(registry, deviceId, code)
        if (!result.success) {
          sendJson(res, { error: result.error }, 500)
          return true
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end(result.result ?? '{}')
        return true
      }

      if (req.method === 'POST') {
        const { body, oversize } = await readBody(req)
        if (oversize) { sendJson(res, { error: 'storage body 超过 2MB 上限' }, 413); return true }
        let parsed: { action?: string; type?: string; key?: string; value?: string; path?: string; expires?: string }
        try {
          parsed = JSON.parse(body)
        } catch {
          sendJson(res, { error: 'body 必须是 JSON' }, 400)
          return true
        }
        if (!parsed.action || !parsed.key || !parsed.type) {
          sendJson(res, { error: '缺少 action/key/type 字段' }, 400)
          return true
        }
        if (parsed.action !== 'set' && parsed.action !== 'delete') {
          sendJson(res, { error: 'action 必须是 set/delete' }, 400)
          return true
        }
        if (parsed.action === 'set' && parsed.value === undefined) {
          sendJson(res, { error: 'set 缺少 value 字段' }, 400)
          return true
        }
        const code = parsed.type === 'indexeddb'
          ? buildIndexedDBWriteCode(parsed.action, parsed.key, parsed.value, parsed.store)
          : buildStorageWriteCode(
            parsed.type as 'local' | 'session' | 'cookie',
            parsed.action,
            parsed.key,
            parsed.value,
            parsed.path,
            parsed.expires,
          )
        const result = await execOnDevice(registry, deviceId, code)
        if (!result.success) {
          sendJson(res, { error: result.error }, 500)
          return true
        }
        sendJson(res, { ok: true })
        return true
      }

      sendJson(res, { error: '需要 GET 或 POST' }, 405)
      return true
    }

    /** /api/devices/:id/exec —— 执行 JS */
    case 'exec': {
      if (req.method !== 'POST') {
        sendJson(res, { error: '需要 POST' }, 405)
        return true
      }
      const { body, oversize } = await readBody(req)
      if (oversize) { sendJson(res, { error: 'exec body 超过 2MB 上限' }, 413); return true }
      let parsed: { code?: string }
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(res, { error: 'body 必须是 JSON' }, 400)
        return true
      }
      if (!parsed.code) {
        sendJson(res, { error: '缺少 code 字段' }, 400)
        return true
      }
      const result = await execOnDevice(registry, deviceId, parsed.code)
      /** exec 后的快照统一转成 compact 文本（与 snapshot API 格式一致，AI 直接读） */
      if (result.success && result.snapshotText) {
        result.snapshotText = sendSnapshot(result.snapshotText)
      }
      sendJson(res, result)
      return true
    }

    /** /api/devices/:id/logs —— console 日志（支持 since 游标） */
    case 'logs': {
      const since = Number(url.searchParams.get('since') ?? 0)
      sendJson(res, device.logs.since(since))
      return true
    }

    /** /api/devices/:id/network —— network 记录（支持 since 游标） */
    case 'network': {
      const since = Number(url.searchParams.get('since') ?? 0)
      sendJson(res, device.network.since(since))
      return true
    }

    /** /api/devices/:id/errors —— 错误记录（支持 since 游标，对齐 logs/network） */
    case 'errors': {
      const since = Number(url.searchParams.get('since') ?? 0)
      sendJson(res, device.errors.since(since))
      return true
    }

    /** /api/devices/:id/tags —— 修改标签/备注（控制台 & AI 都可调用） */
    case 'tags': {
      if (req.method !== 'POST') {
        sendJson(res, { error: '需要 POST' }, 405)
        return true
      }
      const { body, oversize } = await readBody(req)
      if (oversize) { sendJson(res, { error: 'tags body 超过 2MB 上限' }, 413); return true }
      let parsed: { tags?: string[]; note?: string }
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(res, { error: 'body 必须是 JSON' }, 400)
        return true
      }
      /** tags 去重 + 去空白；note 允许清空（传空串或 undefined） */
      const tags = Array.isArray(parsed.tags)
        ? Array.from(new Set(parsed.tags.map((t) => String(t).trim()).filter(Boolean)))
        : device.info.tags
      const note = parsed.note !== undefined ? String(parsed.note).trim() || undefined : device.info.note
      registry.updateInfo(deviceId, { tags, note })
      onDeviceListChanged?.()
      sendJson(res, { ok: true, device: registry.get(deviceId)?.info })
      return true
    }
  }

  sendJson(res, { error: 'Not found' }, 404)
  return true
}

/**
 * 在远程设备上执行 JS（exec-bridge 核心）
 * 通过设备的 WS 下发 exec 指令，等待设备回传 exec-result
 */
export async function execOnDevice(
  registry: DeviceRegistry,
  deviceId: string,
  code: string
): Promise<import('@clarosight/shared').ExecResult> {
  const device = registry.get(deviceId)
  if (!device) {
    return { success: false, error: `设备 ${deviceId} 不在线` }
  }
  if (device.ws.readyState !== device.ws.OPEN) {
    return { success: false, error: `设备 ${deviceId} 连接已关闭` }
  }

  const execId = Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      device.pendingExecs.delete(execId)
      resolve({ success: false, error: '执行超时（10s）' })
    }, EXEC_TIMEOUT)

    device.pendingExecs.set(execId, { resolve, timer })

    /** ws.send 可能因竞态（readyState 检查后断开）抛异常，保护之 */
    try {
      device.ws.send(JSON.stringify({ type: 'exec', execId, code }))
    } catch {
      device.pendingExecs.delete(execId)
      clearTimeout(timer)
      resolve({ success: false, error: '发送执行指令失败（连接已断开）' })
    }
  })
}

/**
 * 生成"取元素树"的 exec 代码
 *
 * 取 parentIdx 节点的直接子元素列表（不递归，前端点展开时再拉下一层）。
 * parentIdx 为 null 时取 body 的直接子元素（首屏）。
 * shadow=true 时取 shadowRoot 的子元素（parentIdx 必须指向 shadow host）。
 *
 * 每个元素返回 {idx, tag, id, classes, childCount, text?, hasShadow?}：
 * - idx：__clarosight_ensureIdx 打稳定 idx，供后续 inspect/操作复用
 * - text：叶子元素（无子元素 + 无 shadow）的可见文本，截断到 30 字符
 * - childCount：子元素数（前端用来决定是否显示"展开"箭头）
 * - hasShadow：该元素是 shadow host（前端展开时需请求 shadow 子树）
 */
function buildElementTreeCode(parentIdx: number | null, shadow = false): string {
  if (shadow) {
    return `
const host = __clarosight_getElement(${parentIdx})
if (!host || !host.shadowRoot) return []
const result = []
for (const el of host.shadowRoot.children) {
  const tag = el.tagName.toLowerCase()
  const idx = __clarosight_ensureIdx(el)
  if (idx < 0) continue
  const item = {
    idx, tag,
    id: el.id || undefined,
    classes: el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean).slice(0, 3).join(' ') : undefined,
    childCount: el.children.length,
  }
  if (el.shadowRoot) {
    item.hasShadow = true
    item.shadowChildCount = el.shadowRoot.children.length
  }
  if (el.children.length === 0 && !el.shadowRoot) {
    const text = (el.textContent || '').trim()
    if (text) item.text = text.length > 30 ? text.slice(0, 30) + '…' : text
  }
  result.push(item)
}
return result
`
  }
  return `
const parent = ${parentIdx === null ? 'document.documentElement' : `__clarosight_getElement(${parentIdx})`}
if (!parent) return []
const result = []
for (const el of parent.children) {
  const tag = el.tagName.toLowerCase()
  const idx = __clarosight_ensureIdx(el)
  if (idx < 0) continue
  const item = {
    idx, tag,
    id: el.id || undefined,
    classes: el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean).slice(0, 3).join(' ') : undefined,
    childCount: el.children.length,
  }
  /** shadow host：标记 hasShadow + shadowChildCount，childCount 只统计普通子元素 */
  if (el.shadowRoot) {
    item.hasShadow = true
    item.shadowChildCount = el.shadowRoot.children.length
  }
  /** 叶子元素（无普通子元素 + 无 shadow）给可见文本预览（前端自行截断） */
  if (el.children.length === 0 && !el.shadowRoot) {
    const text = (el.textContent || '').trim()
    if (text) item.text = text.slice(0, 80)
  }
  result.push(item)
}
return result
`
}

/**
 * 生成"递归搜索元素"的 exec 代码（filter 模式）
 *
 * BFS 遍历完整 DOM（含 shadow DOM），返回匹配 query 的元素列表（上限 50）。
 * 匹配规则：tag / id / class / textContent 包含 query（大小写不敏感）。
 *
 * 每个结果带 ancestors 路径（idx 数组），前端可据此展开树到匹配位置。
 */
function buildElementFilterCode(query: string): string {
  const q = JSON.stringify(query.toLowerCase())
  return `
const query = ${q}
if (!query) return []
const results = []
const seen = new Set()
const MAX = 50

/** 收集元素信息（tag/id/classes/text/hasShadow） */
function info(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '#text'
  const item = {
    idx: __clarosight_ensureIdx(el),
    tag,
    id: el.id || undefined,
    classes: el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean).slice(0, 3).join(' ') : undefined,
    childCount: el.children ? el.children.length : 0,
  }
  if (el.shadowRoot) {
    item.hasShadow = true
    item.shadowChildCount = el.shadowRoot.children.length
  }
  if (el.children && el.children.length === 0 && !el.shadowRoot) {
    const text = (el.textContent || '').trim()
    if (text) item.text = text.length > 30 ? text.slice(0, 30) + '…' : text
  }
  return item
}

/** 检查元素是否匹配 query */
function matches(el) {
  const tag = (el.tagName || '').toLowerCase()
  const id = el.id || ''
  const cls = typeof el.className === 'string' ? el.className : ''
  const text = (el.textContent || '').trim().slice(0, 100)
  return tag.includes(query) || id.includes(query) || cls.toLowerCase().includes(query) || text.toLowerCase().includes(query)
}

/** BFS 遍历（含 shadow DOM），收集匹配元素 */
const queue = [{ node: document.body, path: [] }]
while (queue.length > 0 && results.length < MAX) {
  const { node, path } = queue.shift()
  if (!node || seen.has(node)) continue
  seen.add(node)

  if (matches(node)) {
    const item = info(node)
    item.path = path
    results.push(item)
    if (results.length >= MAX) break
  }

  /** 构建子元素列表（含 shadow children） */
  const children = []
  if (node.children) {
    for (const child of node.children) {
      children.push({ node: child, path: [...path, { idx: __clarosight_ensureIdx(child), shadow: false }] })
    }
  }
  if (node.shadowRoot) {
    for (const child of node.shadowRoot.children) {
      children.push({ node: child, path: [...path, { idx: __clarosight_ensureIdx(child), shadow: true }] })
    }
  }
  /** 倒序入队（BFS shift 从头部取，倒序入队让 DOM 顺序在前） */
  for (let i = children.length - 1; i >= 0; i--) {
    queue.unshift(children[i])
  }
}
return results
`
}

/**
 * 生成"诊断元素"的 exec 代码
 *
 * 返回 AI 诊断"元素为什么看起来不对"的关键信息：
 * - visibility：可见性诊断（display/visibility/opacity/inViewport/被谁挡住）
 * - computedStyle：关键计算样式（font-size/color/background/position/z-index 等 15 个）
 * - box：盒模型（content/padding/border/margin 尺寸）
 * - ancestors：祖先链（往上 3 层，每层带 idx + tag + 关键 class）
 */
function buildElementInspectCode(idx: number): string {
  return `
const el = __clarosight_getElement(${idx})
if (!el) return { error: '元素不存在或已脱离文档' }
const cs = getComputedStyle(el)
const rect = el.getBoundingClientRect()

  /** 可见性诊断 */
  const inViewport = rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0
  const visibility = {
    display: cs.display,
    visibility: cs.visibility,
    opacity: cs.opacity,
    width: rect.width,
    height: rect.height,
    inViewport,
    /** 元素中心点被谁挡住（elementFromPoint 命中的不是自己就返回那个元素） */
    coveredBy: null,
  }
  if (rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
      const hit = document.elementFromPoint(cx, cy)
      if (hit && hit !== el && !el.contains(hit)) {
        visibility.coveredBy = {
          tag: hit.tagName.toLowerCase(),
          id: hit.id || undefined,
          classes: hit.className && typeof hit.className === 'string' ? hit.className.split(/\\s+/).filter(Boolean).slice(0, 2).join(' ') : undefined,
        }
      }
    }
  }

  /** 关键计算样式（诊断"为什么看起来不对"最常用） */
  const computedStyle = {
    display: cs.display,
    position: cs.position,
    zIndex: cs.zIndex,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    color: cs.color,
    background: cs.backgroundColor,
    padding: cs.padding,
    margin: cs.margin,
    border: cs.border,
    boxSizing: cs.boxSizing,
    overflow: cs.overflow,
    textAlign: cs.textAlign,
    lineHeight: cs.lineHeight,
    cursor: cs.cursor,
  }

  /** 盒模型 */
  const box = {
    content: { width: rect.width, height: rect.height },
    padding: {
      top: parseFloat(cs.paddingTop),
      right: parseFloat(cs.paddingRight),
      bottom: parseFloat(cs.paddingBottom),
      left: parseFloat(cs.paddingLeft),
    },
    border: {
      top: parseFloat(cs.borderTopWidth),
      right: parseFloat(cs.borderRightWidth),
      bottom: parseFloat(cs.borderBottomWidth),
      left: parseFloat(cs.borderLeftWidth),
    },
    margin: {
      top: parseFloat(cs.marginTop),
      right: parseFloat(cs.marginRight),
      bottom: parseFloat(cs.marginBottom),
      left: parseFloat(cs.marginLeft),
    },
  }

  /** 祖先链（往上 3 层） */
  const ancestors = []
  let cur = el.parentElement
  for (let i = 0; i < 3 && cur; i++) {
    const aidx = __clarosight_ensureIdx(cur)
    ancestors.push({
      idx: aidx,
      tag: cur.tagName.toLowerCase(),
      id: cur.id || undefined,
      classes: cur.className && typeof cur.className === 'string' ? cur.className.split(/\\s+/).filter(Boolean).slice(0, 2).join(' ') : undefined,
    })
    cur = cur.parentElement
  }

  return {
    idx: ${idx},
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: el.className && typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).join(' ') : undefined,
    visibility,
    computedStyle,
    box,
    ancestors,
  }
`
}

/**
 * 生成"读 storage"的 exec 代码
 *
 * 直接 return 对象（serializeResult 会 JSON.stringify，不要再 stringify 一次）。
 * 不截断 value（console UI 编辑需要完整值；AI 走 __clarosight_storage 截断版）。
 */
function buildStorageReadCode(type: 'local' | 'session' | 'cookie'): string {
  if (type === 'cookie') {
    return `
const result = {}
for (const part of document.cookie.split(';')) {
  const eq = part.indexOf('=')
  if (eq > 0) {
    const k = part.slice(0, eq).trim()
    result[k] = part.slice(eq + 1).trim()
  }
}
return result
`
  }
  const store = type === 'session' ? 'sessionStorage' : 'localStorage'
  return `
const result = {}
for (let i = 0; i < ${store}.length; i++) {
  const k = ${store}.key(i)
  if (k) result[k] = ${store}.getItem(k) || ''
}
return result
`
}

/**
 * 生成"写/删 storage"的 exec 代码
 *
 * key/value 用 JSON.stringify 转义（防引号破坏 exec 代码）。
 * cookie 的 delete 通过设 expires 为过去时间实现（浏览器无 removeItem 等价物）。
 */
function buildStorageWriteCode(
  type: 'local' | 'session' | 'cookie',
  action: 'set' | 'delete',
  key: string,
  value?: string,
  path?: string,
  expires?: string,
): string {
  const k = JSON.stringify(key)
  if (type === 'cookie') {
    if (action === 'set') {
      const v = JSON.stringify(value ?? '')
      const p = path ? `; path=${path}` : '; path=/'
      const exp = expires ? `; expires=${expires}` : ''
      return `document.cookie = ${k} + '=' + encodeURIComponent(${v}) + '${p}${exp}'; return true`
    }
    /** delete：expires 设为过去时间，浏览器自动清除 */
    const p = path ? `; path=${path}` : '; path=/'
    return `document.cookie = ${k} + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT${p}'; return true`
  }
  const store = type === 'session' ? 'sessionStorage' : 'localStorage'
  if (action === 'set') {
    const v = JSON.stringify(value ?? '')
    return `${store}.setItem(${k}, ${v}); return true`
  }
  return `${store}.removeItem(${k}); return true`
}

/**
 * 生成"读 IndexedDB"的 exec 代码
 *
 * IndexedDB 是异步 API，有三层结构：database → objectStore → records。
 * 这里一次性读全部：遍历所有 database → 打开每个 database → 列出 objectStore → 遍历 records。
 *
 * 返回结构：{ databases: [{ name, version, stores: [{ name, records: [{ key, value }] }] }] }
 *
 * 注意：
 * - indexedDB.databases() 是较新 API（Chrome 71+），不支持时返回空数组（不能枚举）
 * - value 尝试 JSON.stringify（可能存了对象/数组），非 JSON 序列化值用 String() 兜底
 * - key 可能是数字/字符串/Date，统一转字符串表示
 */
function buildIndexedDBReadCode(): string {
  return `
if (!indexedDB) return { databases: [], error: 'IndexedDB 不可用' }
const dbList = (indexedDB.databases ? await indexedDB.databases() : [])
const databases = []
for (const dbInfo of dbList) {
  const dbName = dbInfo.name
  const dbVersion = dbInfo.version
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, dbVersion)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('open blocked'))
    })
    const storeNames = db.objectStoreNames
    const stores = []
    for (const storeName of storeNames) {
      const records = await new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const items = []
        const cursorReq = store.openCursor()
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result
          if (cursor) {
            const key = typeof cursor.key === 'object' ? JSON.stringify(cursor.key) : String(cursor.key)
            let value
            try {
              value = typeof cursor.value === 'object' ? JSON.stringify(cursor.value) : String(cursor.value)
            } catch {
              value = String(cursor.value)
            }
            items.push({ key, value })
            cursor.continue()
          }
        }
        cursorReq.onerror = () => resolve(items)
        tx.oncomplete = () => resolve(items)
        tx.onerror = () => resolve(items)
      })
      stores.push({ name: storeName, keyPath: db.transaction(storeName, 'readonly').objectStore(storeName).keyPath, recordCount: records.length, records })
    }
    db.close()
    databases.push({ name: dbName, version: dbVersion, stores })
  } catch (e) {
    databases.push({ name: dbName, version: dbVersion, error: String(e) })
  }
}
return { databases }
`
}

/**
 * 生成"写/删 IndexedDB"的 exec 代码
 *
 * 需要 store 名（IndexedDB 有多个 objectStore，不像 localStorage 只有一个键值空间）。
 * set：打开 database → 事务写入 store → key 自动由 keyPath 决定或手动指定
 * delete：打开 database → 事务删除 store 中指定 key
 *
 * value 尝试 JSON.parse（前端传的是 JSON 字符串），失败则原样存
 */
function buildIndexedDBWriteCode(action: 'set' | 'delete', key: string, value?: string, store?: string): string {
  const storeName = JSON.stringify(store ?? '')
  const k = JSON.stringify(key)
  if (action === 'set') {
    return `
const dbName = ''
const dbList = (indexedDB.databases ? await indexedDB.databases() : [])
const dbInfo = dbList.find(d => true)
if (!dbInfo) throw new Error('没有可用的 IndexedDB database')
const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open(dbInfo.name, dbInfo.version)
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})
const sn = ${storeName}
if (!db.objectStoreNames.contains(sn)) throw new Error('objectStore 不存在: ' + sn)
let parsedValue
try { parsedValue = JSON.parse(${JSON.stringify(value ?? '')}) } catch { parsedValue = ${JSON.stringify(value ?? '')} }
await new Promise((resolve, reject) => {
  const tx = db.transaction(sn, 'readwrite')
  tx.objectStore(sn).put(parsedValue)
  tx.oncomplete = () => resolve(true)
  tx.onerror = () => reject(tx.error)
})
db.close()
return true
`
  }
  return `
const dbList = (indexedDB.databases ? await indexedDB.databases() : [])
const dbInfo = dbList.find(d => true)
if (!dbInfo) throw new Error('没有可用的 IndexedDB database')
const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open(dbInfo.name, dbInfo.version)
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})
const sn = ${storeName}
if (!db.objectStoreNames.contains(sn)) throw new Error('objectStore 不存在: ' + sn)
await new Promise((resolve, reject) => {
  const tx = db.transaction(sn, 'readwrite')
  tx.objectStore(sn).delete(${k})
  tx.oncomplete = () => resolve(true)
  tx.onerror = () => reject(tx.error)
})
db.close()
return true
`
}
