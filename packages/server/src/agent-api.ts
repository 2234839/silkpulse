/**
 * Agent 专用 API 路由 —— /api/agent/*
 *
 * 与内部 API (/api/devices/*) 的区别：
 * 1. 返回精简数据：去掉 icon/userAgent/viewport 等元数据，只留 agent 需要的
 * 2. 真正实现 inspect 一键聚合诊断
 * 3. logs/errors/network 支持 ?limit=N 参数
 * 4. exec 支持 ?snapshot=0 禁用快照返回（简单查询不浪费 token）
 * 5. 统一 text/plain 返回（agent 直接读，不解析 JSON）
 *
 * 所有路由复用 handleApiRoute 的鉴权上下文（Authorization 或 ?key=）。
 */

import type { IncomingMessage, ServerResponse } from 'http'
import type { DeviceRegistry } from './device-registry.js'
import type { AuthContext } from './auth.js'
import { execOnDevice, sendJson, sendText, readBody, buildElementTreeCode, buildElementFilterCode } from './api.js'
import { sendSnapshot } from './snapshot-text.js'
import { maybeGzipResponse } from './gzip.js'

/**
 * 处理 /api/agent/* 路由
 * 返回 true 表示已处理，false 表示非 agent 路径
 */
export async function handleAgentApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  registry: DeviceRegistry,
  authCtx: AuthContext,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  if (!pathname.startsWith('/api/agent')) return false

  /** 鉴权：匿名拒绝 */
  if (authCtx.role === 'anonymous') {
    sendJson(res, { error: '未授权' }, 401)
    return true
  }

  /** GET /api/agent/devices —— 精简设备列表（只返回 id/url/title/errorCount） */
  if (pathname === '/api/agent/devices' && req.method === 'GET') {
    const projectId = authCtx.role === 'project' ? authCtx.projectId : undefined
    const devices = registry.listByProject(projectId).map((d) => ({
      id: d.id,
      url: d.url,
      title: d.title,
      errors: d.errorCount,
    }))
    sendJson(res, { devices })
    return true
  }

  /** 解析 /api/agent/devices/:id/xxx */
  const match = pathname.match(/^\/api\/agent\/devices\/([^/]+)(?:\/(.+))?$/)
  if (!match) {
    sendJson(res, { error: 'Not found' }, 404)
    return true
  }
  const [, deviceId, action] = match
  const device = registry.get(deviceId)
  if (!device) {
    sendText(res, `[错误] 设备 ${deviceId} 不在线。先 GET /api/agent/devices 查看在线设备列表。`, 404)
    return true
  }

  /** limit 参数解析（默认按各类型给合理值） */
  const limitParam = (fallback: number) => {
    const n = Number(url.searchParams.get('limit'))
    return n > 0 ? n : fallback
  }

  switch (action) {
    /**
     * GET /api/agent/devices/:id/inspect —— 一键诊断聚合
     *
     * 合并 errors + 失败 network + 页面快照为一个 text/plain 文本，
     * agent 一个请求拿到全貌，最高效的诊断入口。
     */
    case 'inspect': {
      const errors = device.errors.all().slice(-limitParam(10))
      const failedNetwork = device.network.all()
        .filter((n) => n.status === 0 || n.status >= 400)
        .slice(-limitParam(10))
      const snapshotResult = await execOnDevice(registry, deviceId, 'return __clarosight_snapshot()')
      const parts: string[] = []
      parts.push(`# 诊断报告 — ${device.info.title}\n# ${device.info.url}\n`)
      /** 错误 */
      if (errors.length > 0) {
        parts.push(`## 错误 (${errors.length})\n`)
        for (const e of errors) {
          const source = e.mapped ? ` → ${e.mapped.source}:${e.mapped.line}` : (e.source ? ` (${e.source}:${e.line})` : '')
          parts.push(`- ${e.message}${source}`)
        }
        parts.push('')
      } else {
        parts.push('## 错误: 无\n')
      }
      /** 失败网络 */
      if (failedNetwork.length > 0) {
        parts.push(`## 失败请求 (${failedNetwork.length})\n`)
        for (const n of failedNetwork) {
          parts.push(`- [${n.method}] ${n.url} → ${n.status}`)
        }
        parts.push('')
      } else {
        parts.push('## 失败请求: 无\n')
      }
      /** 快照 */
      if (snapshotResult.success && snapshotResult.result) {
        parts.push('## 页面快照\n')
        parts.push(sendSnapshot(snapshotResult.result))
      } else {
        parts.push(`## 页面快照: 获取失败 — ${snapshotResult.error}`)
      }
      sendText(res, parts.join('\n'))
      return true
    }

    /**
     * GET /api/agent/devices/:id/snapshot —— 页面快照（text/plain）
     */
    case 'snapshot': {
      const result = await execOnDevice(registry, deviceId, 'return __clarosight_snapshot()')
      if (!result.success) {
        sendText(res, `[快照失败] ${result.error}`, 500)
        return true
      }
      sendText(res, sendSnapshot(result.result))
      return true
    }

    /**
     * GET /api/agent/devices/:id/logs?limit=20 —— console 日志（text/plain）
     *
     * 返回精简文本格式，agent 不需要解析 JSON。
     */
    case 'logs': {
      const logs = device.logs.all().slice(-limitParam(20))
      if (logs.length === 0) {
        sendText(res, '[无日志]')
        return true
      }
      const text = logs.map((l) => `[${l.type}] ${l.message}`).join('\n')
      sendText(res, text)
      return true
    }

    /**
     * GET /api/agent/devices/:id/errors?limit=10 —— 错误（text/plain）
     */
    case 'errors': {
      const errors = device.errors.all().slice(-limitParam(10))
      if (errors.length === 0) {
        sendText(res, '[无错误]')
        return true
      }
      const text = errors.map((e) => {
        const source = e.mapped ? ` → ${e.mapped.source}:${e.mapped.line}` : (e.source ? ` (${e.source}:${e.line})` : '')
        return `${e.message}${source}`
      }).join('\n')
      sendText(res, text)
      return true
    }

    /**
     * GET /api/agent/devices/:id/network?limit=10 —— 网络请求（text/plain）
     */
    case 'network': {
      const entries = device.network.all().slice(-limitParam(10))
      if (entries.length === 0) {
        sendText(res, '[无网络请求]')
        return true
      }
      const text = entries.map((n) => {
        const status = n.status === 0 ? 'FAIL' : String(n.status)
        return `[${n.method}] ${n.url} → ${status} ${n.duration}ms`
      }).join('\n')
      sendText(res, text)
      return true
    }

    /**
     * POST /api/agent/devices/:id/exec —— 执行 JS
     *
     * 支持 ?snapshot=0 禁用快照返回（默认开启），减少不必要输出。
     * 返回 JSON：{ success, result, error, logs, snapshot? }
     */
    case 'exec': {
      if (req.method !== 'POST') {
        sendJson(res, { error: '需要 POST' }, 405)
        return true
      }
      const wantSnapshot = url.searchParams.get('snapshot') !== '0'
      const { body, oversize } = await readBody(req)
      if (oversize) { sendJson(res, { error: 'body 超过 2MB 上限' }, 413); return true }
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
      /** 精简返回：去掉 resultValue（agent 只需 result 字符串），可选去掉 snapshot */
      const agentResult: {
        success: boolean
        result?: string
        error?: string
        logs?: string[]
        snapshot?: string
      } = {
        success: result.success,
        result: result.result,
        error: result.error,
        logs: result.logs,
      }
      if (wantSnapshot && result.success && result.snapshotText) {
        agentResult.snapshot = sendSnapshot(result.snapshotText)
      }
      sendJson(res, agentResult)
      return true
    }

    /**
     * GET /api/agent/devices/:id/element/tree?idx=N —— DOM 树（JSON）
     *
     * 透传 exec 结果（与内部 API 一致，因为 agent 需要结构化数据操作元素）。
     */
    case 'element/tree': {
      const parentIdx = url.searchParams.get('idx')
      const shadow = url.searchParams.get('shadow') === '1'
      const filter = url.searchParams.get('filter')?.trim()
      const code = filter
        ? buildElementFilterCode(filter)
        : buildElementTreeCode(parentIdx ? Number(parentIdx) : null, shadow)
      const result = await execOnDevice(registry, deviceId, code)
      if (!result.success) {
        sendJson(res, { error: result.error }, 500)
        return true
      }
      const { body: respBody, headers } = maybeGzipResponse(req, result.result ?? '[]', {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      })
      res.writeHead(200, headers)
      res.end(respBody)
      return true
    }

    default:
      sendText(res, `[错误] 未知的 agent 操作: ${action}`, 404)
      return true
  }
}
