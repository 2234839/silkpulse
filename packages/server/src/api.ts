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
    sendJson(res, { ok: true, received: body ? JSON.parse(body) : null, time: Date.now() })
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

    /** /api/devices/:id/errors —— 最近错误 */
    case 'errors': {
      sendJson(res, device.errors.all())
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
