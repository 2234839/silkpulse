/**
 * HTTP API 路由 —— AI skill 的调用入口
 *
 * 所有 /api/* 端点返回 JSON（snapshot 除外，返回 text/plain 供 AI 直接读）。
 * exec 端点通过设备的 WS 下发指令并等待回传（内存 promise 模式）。
 */

import type { DeviceRegistry } from './device-registry.js'
import type { AuthManager, AuthContext } from './auth.js'
import type { Ctx } from './uws/http-helpers.js'
import { sendSnapshot } from './snapshot-text.js'
import { generateFeatureDetectScript } from '@silkpulse/feature-detect'
import { maybeGzipResponse } from './gzip.js'
import { renderSkillPrompt } from '@silkpulse/shared'
import { performance } from 'node:perf_hooks'
import { fanoutStats } from './ws-relay.js'
import { getBuildInfo } from './build-info.js'

/**
 * 事件循环利用率采样器（增量式单例）
 *
 * eventLoopUtilization 直接测事件循环空闲/活跃时间占比，与 timer 精度无关
 * （monitorEventLoopDelay 在部分容器/内核上 idle 也报 ≥resolution，不可信）。
 * 每次调用返回自上次调用以来的利用率 0~1，天然窗口化、无累计污染。
 */
let _eluPrev: ReturnType<typeof performance.eventLoopUtilization> | null = null
function loopUtilization(): number {
  const cur = performance.eventLoopUtilization()
  if (!_eluPrev) {
    _eluPrev = cur
    return 0
  }
  const u = performance.eventLoopUtilization(cur, _eluPrev)
  _eluPrev = cur
  return u.utilization
}

export { readBody, sendJson, sendText } from './uws/http-helpers.js'
import { readBody, sendJson, sendText, writeResponse } from './uws/http-helpers.js'

/** exec 超时（ms） */
const EXEC_TIMEOUT = 10000

/**
 * 处理 /api/* 路由
 * 返回 true 表示已处理，false 表示非 API 路径
 * onDeviceListChanged：修改 tags/note 后通知控制台刷新设备列表
 */
export async function handleApiRoute(
  ctx: Ctx,
  registry: DeviceRegistry,
  onDeviceListChanged?: () => void,
  /** 鉴权管理器（可选，未传时不做项目过滤） */
  _auth?: AuthManager,
  /** 当前请求的鉴权上下文 */
  authCtx: AuthContext = { role: 'admin' },
): Promise<boolean> {
  /** /api/health —— 压测/监控探针（无需鉴权：只暴露进程级指标，无业务数据） */
  if (ctx.url.split('?')[0] === '/api/health') {
    const mu = process.memoryUsage()
    const bi = getBuildInfo()
    sendJson(ctx, {
      ok: true,
      version: `${(bi.branch || 'detached').slice(0, 20)}@${bi.commit.slice(0, 7)}${bi.dirty ? '+dirty' : ''}`,
      buildAt: bi.buildAt,
      rssMB: +(mu.rss / 1048576).toFixed(1),
      heapUsedMB: +(mu.heapUsed / 1048576).toFixed(1),
      eventLoopUtilPct: +(loopUtilization() * 100).toFixed(1),
      fanoutSent: fanoutStats.sent,
      fanoutSkippedClosed: fanoutStats.skippedClosed,
      fanoutSkippedProject: fanoutStats.skippedProject,
      fanoutBackpressureClosed: fanoutStats.backpressureClosed,
      uptimeSec: Math.round(process.uptime()),
    })
    return true
  }
  const url = ctx.parsedUrl
  const pathname = url.pathname
  if (!pathname.startsWith('/api/')) return false

  /** CORS 预检 */
  if (ctx.method === 'OPTIONS') {
    writeResponse(ctx, 204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }, '')
    return true
  }

  /** /api/echo —— 回显端点（测试 POST body 采集，返回接收到的 body） */
  if (pathname === '/api/echo') {
    const { body, oversize } = await readBody(ctx)
    if (oversize) { sendJson(ctx, { error: 'body 超过 2MB 上限' }, 413); return true }
    /** body 可能是任意格式（JSON / FormData multipart / 纯文本），非 JSON 时原样返回文本 */
    let received: unknown = body || null
    if (body) {
      try { received = JSON.parse(body) } catch { /** 非 JSON，保留原始文本 */ }
    }
    sendJson(ctx, { ok: true, received, time: Date.now() })
    return true
  }

  /**
   * /api/skill/:name —— 渐进式 skill 文档拉取
   *
   * Agent 在系统提示词中只放极短的引导（~50 token），
   * 需要时 curl 这个端点拉取完整 API 文档。
   * 支持 ?key= query 或 Authorization header 鉴权。
   */
  const skillMatch = pathname.match(/^\/api\/skill\/([^/]+)$/)
  if (skillMatch && ctx.method === 'GET') {
    const [, skillName] = skillMatch
    if (skillName !== 'silkpulse') {
      sendJson(ctx, { error: `未知的 skill: ${skillName}` }, 404)
      return true
    }
    /** 鉴权：匿名拒绝 */
    if (authCtx.role === 'anonymous') {
      sendJson(ctx, { error: '未授权' }, 401)
      return true
    }
    /** 从请求 Host 推断服务地址 */
    const host = ctx.headers['host'] || ''
    const proto = ctx.headers['x-forwarded-proto'] || 'http'
    const serverUrl = `${proto}://${host}`
    /** 提取鉴权 token（header 或 query）作为 apiKey */
    const apiKey = ctx.parsedUrl.searchParams.get('key') || ctx.headers['authorization']?.replace('Bearer ', '').trim() || ''
    sendText(ctx, renderSkillPrompt(serverUrl, apiKey))
    return true
  }

  /** /api/devices —— 列出所有在线设备 + 最近下线设备（供 AI 判断接入状态） */
  if (pathname === '/api/devices' && ctx.method === 'GET') {
    /** 鉴权：匿名拒绝，项目级只看自己项目的设备 */
    if (authCtx.role === 'anonymous') {
      sendJson(ctx, { error: '未授权' }, 401)
      return true
    }
    const projectId = authCtx.role === 'project' ? authCtx.projectId : undefined
    sendJson(ctx, {
      devices: registry.listByProject(projectId),
      recentlyOffline: registry.listOfflineByProject(projectId),
    })
    return true
  }

  /** 解析 /api/devices/:id/xxx */
  const match = pathname.match(/^\/api\/devices\/([^/]+)(?:\/(.+))?$/)
  if (!match) {
    sendJson(ctx, { error: 'Not found' }, 404)
    return true
  }
  const [, deviceId, action] = match
  const device = registry.get(deviceId)
  if (!device) {
    sendJson(ctx, { error: `设备 ${deviceId} 不在线` }, 404)
    return true
  }

  /** 鉴权：检查是否有权限访问此设备（项目隔离） */
  if (authCtx.role === 'anonymous') {
    sendJson(ctx, { error: '未授权' }, 401)
    return true
  }
  if (!_auth?.canAccessDevice(authCtx, device.info.projectId)) {
    sendJson(ctx, { error: '无权访问此设备' }, 403)
    return true
  }

  switch (action) {
    /** 设备详情 */
    case undefined: {
      sendJson(ctx, device.info)
      return true
    }

    /** /api/devices/:id/snapshot —— 页面快照（默认 text/plain，?format=json 返回原始 JSON） */
    case 'snapshot': {
      const result = await execOnDevice(registry, deviceId, 'return __silkpulse_snapshot()')
      if (!result.success) {
        sendText(ctx, `[快照失败] ${result.error}`, 500)
        return true
      }
      /** ?format=json 返回原始 JSON（控制台预览模式用，含 rect 布局信息） */
      if (url.searchParams.get('format') === 'json') {
        sendJson(ctx, result.result ? JSON.parse(result.result) : {})
        return true
      }
      /** 默认：序列化为 compact 文本（AI 直接读） */
      const text = sendSnapshot(result.result)
      sendText(ctx, text)
      return true
    }

    /**
     * /api/devices/:id/screenshot —— 截取页面或指定元素的截图
     *
     * GET 参数：
     * - idx:    元素 idx（不传则截取整个 viewport）
     * - format: jpg（默认）| png | webp
     * - quality: JPEG/WebP 质量 0-1（默认 0.8）
     * - scale:  放大倍数（默认 1）
     *
     * 返回二进制图片（Content-Type: image/jpeg 等），Agent 可直接保存/查看。
     * 截图失败时返回 500 + text/plain 错误信息。
     */
    case 'screenshot': {
      if (ctx.method !== 'GET') {
        sendText(ctx, '[错误] 需要 GET', 405)
        return true
      }
      const idx = url.searchParams.get('idx')
      const format = url.searchParams.get('format') ?? 'jpg'
      const quality = url.searchParams.get('quality') ?? '0.8'
      const scale = url.searchParams.get('scale') ?? '1'
      const idxArg = idx ? Number(idx) : 'undefined'
      /** 构造 exec 代码调用 __silkpulse_screenshot */
      const code = `return await __silkpulse_screenshot(${idxArg}, { format: '${format}', quality: ${quality}, scale: ${scale} })`
      const result = await execOnDevice(registry, deviceId, code)
      if (!result.success) {
        sendText(ctx, `[截图失败] ${result.error}`, 500)
        return true
      }
      /** result.result 是 JSON.stringify 后的 dataURL（如 "data:image/jpeg;base64,..."） */
      const dataUrl = result.result ? JSON.parse(result.result) : ''
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        sendText(ctx, `[截图失败] 返回数据格式异常`, 500)
        return true
      }
      /** dataURL → binary：提取 base64 部分，解码后返回原始图片 */
      const meta = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
      if (!meta) {
        sendText(ctx, `[截图失败] dataURL 解析失败`, 500)
        return true
      }
      const mimeType = meta[1] === 'jpg' ? 'jpeg' : meta[1]
      const binary = Buffer.from(meta[2], 'base64')
      writeResponse(ctx, 200, {
        'Content-Type': `image/${mimeType}`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      }, binary)
      return true
    }

    /**
     * /api/devices/:id/feature-detect —— 特性检测（类似 Modernizr）
     *
     * 通过 exec-bridge 在目标设备上执行检测脚本，返回各特性的支持情况。
     * 控制台 Feature 面板和 AI skill 都可调用，排查"目标设备是否不支持某特性"。
     */
    case 'feature-detect': {
      /** 重检测（webgl 首建上下文在软件渲染/低端设备上可达数十秒）→ 独立 60s 超时 */
      const result = await execOnDevice(registry, deviceId, generateFeatureDetectScript(), 60000)
      if (!result.success) {
        sendJson(ctx, { error: result.error }, 500)
        return true
      }
      /** result.result 是 JSON 字符串（检测项数组），解析后透传给前端 */
      if (!result.result) {
        sendJson(ctx, { error: '检测结果为空' }, 500)
        return true
      }
      sendJson(ctx, JSON.parse(result.result))
      return true
    }

    /**
     * /api/devices/:id/element/tree?idx=N —— 取某个节点的直接子元素列表
     *
     * 不传 idx 时取 documentElement（<html>）的直接子元素（首屏）。
     * 每个元素通过 __silkpulse_ensureIdx 打稳定 idx，供后续 inspect/操作复用。
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
        sendJson(ctx, { error: result.error }, 500)
        return true
      }
      /** exec 的 result 是序列化后的 JSON 字符串，直接透传（gzip 压缩） */
      const { body, headers } = maybeGzipResponse({ headers: ctx.headers }, result.result ?? '[]', {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      })
      writeResponse(ctx, 200, headers, body)
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
        sendJson(ctx, { error: '缺少 idx 参数' }, 400)
        return true
      }
      const code = buildElementInspectCode(Number(idx))
      const result = await execOnDevice(registry, deviceId, code)
      if (!result.success) {
        sendJson(ctx, { error: result.error }, 500)
        return true
      }
      const { body, headers } = maybeGzipResponse({ headers: ctx.headers }, result.result ?? '{}', {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      })
      writeResponse(ctx, 200, headers, body)
      return true
    }

    /**
     * /api/devices/:id/element/styles?idx=N —— 获取元素匹配的 CSS 规则（DevTools 风格）
     *
     * 返回 JSON：{matchedRules: [...], inlineStyle: {...}, inherited: [...]}
     * 遍历 document.styleSheets + el.matches() 收集匹配的规则，
     * 标注每条规则的来源（文件名 / <style> 标签序号）。
     */
    case 'element/styles': {
      const idx = url.searchParams.get('idx')
      if (!idx) {
        sendJson(ctx, { error: '缺少 idx 参数' }, 400)
        return true
      }
      const code = buildElementStylesCode(Number(idx))
      const result = await execOnDevice(registry, deviceId, code)
      if (!result.success) {
        sendJson(ctx, { error: result.error }, 500)
        return true
      }
      const { body, headers } = maybeGzipResponse({ headers: ctx.headers }, result.result ?? '{}', {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      })
      writeResponse(ctx, 200, headers, body)
      return true
    }

    /**
     * /api/devices/:id/storage —— 读写远程设备存储
     *
     * GET ?type=local|session|cookie → 返回完整 { key: value }（不截断，console UI 编辑用）
     * POST {action:'set'|'delete', type, key, value?} → 写入/删除
     *
     * 与 SDK 的 __silkpulse_storage 区分：
     * - 那个给 AI 用（截断到 200 字符防撑爆上下文）
     * - 这个给 console UI 用（完整值，编辑需要）
     *
     * cookie 的 set 支持 path/expires（可选），delete 通过设 expires 为过去时间实现。
     * HttpOnly cookie 读不到也写不了（浏览器限制），前端需提示。
     */
    case 'storage': {
      const type = url.searchParams.get('type') ?? 'local'
      if (type !== 'local' && type !== 'session' && type !== 'cookie' && type !== 'indexeddb') {
        sendJson(ctx, { error: 'type 必须是 local/session/cookie/indexeddb' }, 400)
        return true
      }

      if (ctx.method === 'GET') {
        /** indexeddb 走专门的异步读代码，不走 buildStorageReadCode */
        const code = type === 'indexeddb'
          ? buildIndexedDBReadCode()
          : buildStorageReadCode(type as 'local' | 'session' | 'cookie')
        const result = await execOnDevice(registry, deviceId, code)
        if (!result.success) {
          sendJson(ctx, { error: result.error }, 500)
          return true
        }
        /**
         * 验证 result.result 是合法 JSON。
         * exec 通道有 20K 截断，极端情况（海量 key）可能截断为不合法 JSON，
         * 此时返回错误而非让前端 res.json() 崩溃。
         */
        const raw = result.result ?? '{}'
        try {
          JSON.parse(raw)
        } catch {
          sendJson(ctx, { error: 'Storage 数据过大，exec 结果被截断为不合法 JSON' }, 500)
          return true
        }
        const { body, headers } = maybeGzipResponse({ headers: ctx.headers }, raw, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        })
        writeResponse(ctx, 200, headers, body)
        return true
      }

      if (ctx.method === 'POST') {
        const { body, oversize } = await readBody(ctx)
        if (oversize) { sendJson(ctx, { error: 'storage body 超过 2MB 上限' }, 413); return true }
        let parsed: { action?: string; type?: string; key?: string; value?: string; path?: string; expires?: string; store?: string }
        try {
          parsed = JSON.parse(body)
        } catch {
          sendJson(ctx, { error: 'body 必须是 JSON' }, 400)
          return true
        }
        if (!parsed.action || !parsed.key || !parsed.type) {
          sendJson(ctx, { error: '缺少 action/key/type 字段' }, 400)
          return true
        }
        if (parsed.action !== 'set' && parsed.action !== 'delete') {
          sendJson(ctx, { error: 'action 必须是 set/delete' }, 400)
          return true
        }
        if (parsed.action === 'set' && parsed.value === undefined) {
          sendJson(ctx, { error: 'set 缺少 value 字段' }, 400)
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
          sendJson(ctx, { error: result.error }, 500)
          return true
        }
        sendJson(ctx, { ok: true })
        return true
      }

      sendJson(ctx, { error: '需要 GET 或 POST' }, 405)
      return true
    }

    /** /api/devices/:id/exec —— 执行 JS */
    case 'exec': {
      if (ctx.method !== 'POST') {
        sendJson(ctx, { error: '需要 POST' }, 405)
        return true
      }
      const { body, oversize } = await readBody(ctx)
      if (oversize) { sendJson(ctx, { error: 'exec body 超过 2MB 上限' }, 413); return true }
      let parsed: { code?: string }
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(ctx, { error: 'body 必须是 JSON' }, 400)
        return true
      }
      if (!parsed.code) {
        sendJson(ctx, { error: '缺少 code 字段' }, 400)
        return true
      }
      const result = await execOnDevice(registry, deviceId, parsed.code)
      /** exec 后的快照统一转成 compact 文本（与 snapshot API 格式一致，AI 直接读） */
      if (result.success && result.snapshotText) {
        result.snapshotText = sendSnapshot(result.snapshotText)
      }
      sendJson(ctx, result)
      return true
    }

    /** /api/devices/:id/logs —— console 日志（支持 since 游标） */
    case 'logs': {
      const since = Number(url.searchParams.get('since') ?? 0)
      sendJson(ctx, device.logs.since(since))
      return true
    }

    /** /api/devices/:id/network —— network 记录（支持 since 游标） */
    case 'network': {
      const since = Number(url.searchParams.get('since') ?? 0)
      sendJson(ctx, device.network.since(since))
      return true
    }

    /** /api/devices/:id/errors —— 错误记录（支持 since 游标，对齐 logs/network） */
    case 'errors': {
      const since = Number(url.searchParams.get('since') ?? 0)
      sendJson(ctx, device.errors.since(since))
      return true
    }

    /** /api/devices/:id/tags —— 修改标签/备注（控制台 & AI 都可调用） */
    case 'tags': {
      if (ctx.method !== 'POST') {
        sendJson(ctx, { error: '需要 POST' }, 405)
        return true
      }
      const { body, oversize } = await readBody(ctx)
      if (oversize) { sendJson(ctx, { error: 'tags body 超过 2MB 上限' }, 413); return true }
      let parsed: { tags?: string[]; note?: string }
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(ctx, { error: 'body 必须是 JSON' }, 400)
        return true
      }
      /** tags 去重 + 去空白；note 允许清空（传空串或 undefined） */
      const tags = Array.isArray(parsed.tags)
        ? Array.from(new Set(parsed.tags.map((t) => String(t).trim()).filter(Boolean)))
        : device.info.tags
      const note = parsed.note !== undefined ? String(parsed.note).trim() || undefined : device.info.note
      registry.updateInfo(deviceId, { tags, note })
      onDeviceListChanged?.()
      sendJson(ctx, { ok: true, device: registry.get(deviceId)?.info })
      return true
    }
  }

  sendJson(ctx, { error: 'Not found' }, 404)
  return true
}

/**
 * 在远程设备上执行 JS（exec-bridge 核心）
 * 通过设备的 WS 下发 exec 指令，等待设备回传 exec-result
 */
export async function execOnDevice(
  registry: DeviceRegistry,
  deviceId: string,
  code: string,
  /**
   * 本条 exec 的超时毫秒数（默认 EXEC_TIMEOUT）
   *
   * feature-detect 这类重检测（canvas.getContext('webgl') 在软件渲染/低端设备上
   * 首次建上下文可达数十秒）需要独立的长超时，不与通用 exec 共用 10s。
   */
  timeoutMs: number = EXEC_TIMEOUT
): Promise<import('@silkpulse/shared').ExecResult> {
  const device = registry.get(deviceId)
  if (!device) {
    return { success: false, error: `设备 ${deviceId} 不在线` }
  }
  const sock = device.latestSocket
  if (sock.readyState !== sock.OPEN) {
    return { success: false, error: `设备 ${deviceId} 连接已关闭` }
  }

  const execId = Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      device.pendingExecs.delete(execId)
      resolve({ success: false, error: '执行超时（10s）' })
    }, timeoutMs)

    device.pendingExecs.set(execId, { resolve, timer })

    /** ws.send 可能因竞态（readyState 检查后断开）抛异常，保护之 */
    try {
      sock.send(JSON.stringify({ type: 'exec', execId, code }))
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
 * 每个元素返回 {idx, tag, attributes, childCount, text?, hasShadow?}：
 * - idx：__silkpulse_ensureIdx 打稳定 idx，供后续 inspect/操作复用
 * - attributes：完整属性列表 [{name, value}]（前端渲染所有属性）
 * - text：叶子元素（无子元素 + 无 shadow）的可见文本（完整返回，前端换行展示）
 * - childCount：子元素数（前端用来决定是否显示"展开"箭头）
 * - hasShadow：该元素是 shadow host（前端展开时需请求 shadow 子树）
 */
export function buildElementTreeCode(parentIdx: number | null, shadow = false): string {
  if (shadow) {
    return `
const host = __silkpulse_getElement(${parentIdx})
if (!host || !host.shadowRoot) return []
const result = []
for (const el of host.shadowRoot.children) {
  const tag = el.tagName.toLowerCase()
  const idx = __silkpulse_ensureIdx(el)
  if (idx < 0) continue
  const item = {
    idx, tag,
    attributes: Array.from(el.attributes || []).map(a => ({ name: a.name, value: a.value })),
    childCount: el.children.length,
  }
  if (el.shadowRoot) {
    item.hasShadow = true
    item.shadowChildCount = el.shadowRoot.children.length
  }
  if (el.children.length === 0 && !el.shadowRoot) {
    const text = (el.textContent || '').trim()
    if (text) item.text = text
  }
  result.push(item)
}
return result
`
  }
  return `
const parent = ${parentIdx === null ? 'document.documentElement' : `__silkpulse_getElement(${parentIdx})`}
if (!parent) return []
const result = []
for (const el of parent.children) {
  const tag = el.tagName.toLowerCase()
  const idx = __silkpulse_ensureIdx(el)
  if (idx < 0) continue
  const item = {
    idx, tag,
    attributes: Array.from(el.attributes || []).map(a => ({ name: a.name, value: a.value })),
    childCount: el.children.length,
  }
  /** shadow host：标记 hasShadow + shadowChildCount，childCount 只统计普通子元素 */
  if (el.shadowRoot) {
    item.hasShadow = true
    item.shadowChildCount = el.shadowRoot.children.length
  }
  /** 叶子元素（无普通子元素 + 无 shadow）返回完整文本，前端换行展示 */
  if (el.children.length === 0 && !el.shadowRoot) {
    const text = (el.textContent || '').trim()
    if (text) item.text = text
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
export function buildElementFilterCode(query: string): string {
  const q = JSON.stringify(query.toLowerCase())
  return `
const query = ${q}
if (!query) return []
const results = []
const seen = new Set()
const MAX = 50

/** 收集元素信息（tag/attributes/text/hasShadow） */
function info(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '#text'
  const item = {
    idx: __silkpulse_ensureIdx(el),
    tag,
    attributes: el.attributes ? Array.from(el.attributes).map(a => ({ name: a.name, value: a.value })) : [],
    childCount: el.children ? el.children.length : 0,
  }
  if (el.shadowRoot) {
    item.hasShadow = true
    item.shadowChildCount = el.shadowRoot.children.length
  }
  if (el.children && el.children.length === 0 && !el.shadowRoot) {
    const text = (el.textContent || '').trim()
    if (text) item.text = text
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
      children.push({ node: child, path: [...path, { idx: __silkpulse_ensureIdx(child), shadow: false }] })
    }
  }
  if (node.shadowRoot) {
    for (const child of node.shadowRoot.children) {
      children.push({ node: child, path: [...path, { idx: __silkpulse_ensureIdx(child), shadow: true }] })
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
const el = __silkpulse_getElement(${idx})
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
    const aidx = __silkpulse_ensureIdx(cur)
    ancestors.push({
      idx: aidx,
      tag: cur.tagName.toLowerCase(),
      id: cur.id || undefined,
      classes: cur.className && typeof cur.className === 'string' ? cur.className.split(/\\s+/).filter(Boolean).slice(0, 2).join(' ') : undefined,
    })
    cur = cur.parentElement
  }

  /** 表单元素的当前值/状态 */
  const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
  const inputValue = isInput ? (() => {
    const input = el
    if (input.tagName === 'INPUT' && (input.type === 'checkbox' || input.type === 'radio')) {
      return { checked: input.checked, type: input.type }
    }
    if (input.tagName === 'SELECT') {
      return { value: input.value, options: Array.from(input.options).map(o => o.value) }
    }
    return { value: input.value ?? '', placeholder: input.placeholder || '' }
  })() : undefined

  return {
    idx: ${idx},
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: el.className && typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).join(' ') : undefined,
    visibility,
    computedStyle,
    box,
    ancestors,
    inputValue,
  }
`
}

/**
 * 生成"获取元素匹配 CSS 规则"的 exec 代码（DevTools 风格样式检查器）
 *
 * 遍历 document.styleSheets + cssRules，用 el.matches(selector) 筛选匹配的规则。
 * 对每条匹配规则，记录：选择器、属性列表、来源（href / <style> 标签序号）、优先级。
 * 同时收集内联样式 + 继承属性。
 *
 * 限制：
 * - 跨域样式表 cssRules 会抛 SecurityError，try-catch 跳过
 * - CSSOM 不暴露行号，无法像 DevTools 那样显示来源行号
 * - @media / @supports 规则需要递归遍历其嵌套的 cssRules
 */
function buildElementStylesCode(idx: number): string {
  return `
const el = __silkpulse_getElement(${idx})
if (!el) return { error: '元素不存在或已脱离文档' }

/**
 * 计算 CSS 选择器的特异性（specificity），用于规则排序
 * 返回 [a, b, c] 三元组：ID 数 / class+attr+pseudo-class 数 / type+pseudo-element 数
 */
function calcSpecificity(selector) {
  var a = 0, b = 0, c = 0
  // 去掉 :not() / :is() / :where() 的包裹，提取内部选择器
  var s = selector.replace(/:[a-z-]+\\([^)]*\\)/gi, function(m) { return m.slice(m.indexOf('(')+1, -1) })
  a += (s.match(/#[\\w-]+/g) || []).length
  b += (s.match(/\\.[\\w-]+/g) || []).length
  b += (s.match(/\\[[^\\]]+\\]/g) || []).length
  b += (s.match(/:(?!:)[\\w-]+/g) || []).length
  c += (s.match(/(^|[\\s>+~])(?![.#\\[:])([a-z][\\w-]*)/gi) || []).length
  c += (s.match(/::[\\w-]+/g) || []).length
  return [a, b, c]
}

var matchedRules = []

/**
 * 递归遍历 CSSRuleList，收集匹配 el 的 CSSStyleRule
 * @media / @supports 等条件规则需要递归遍历子规则
 */
function walkRules(rules, el, context) {
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i]
    if (rule instanceof CSSStyleRule) {
      // 多选择器拆开逐个检测（如 "a, .b" 需要分别匹配）
      var selectors = rule.selectorText.split(',').map(function(s) { return s.trim() })
      for (var j = 0; j < selectors.length; j++) {
        var sel = selectors[j]
        try {
          if (el.matches(sel)) {
            var props = {}
            for (var k = 0; k < rule.style.length; k++) {
              var prop = rule.style[k]
              props[prop] = {
                value: rule.style.getPropertyValue(prop),
                important: rule.style.getPropertyPriority(prop) === 'important',
              }
            }
            matchedRules.push({
              selector: sel,
              selectors: selectors.length > 1 ? rule.selectorText : undefined,
              props: props,
              specificity: calcSpecificity(sel),
              important: Object.values(props).some(function(p) { return p.important }),
              source: context.source,
              media: context.media || undefined,
            })
            break // 同一规则匹配一次即可
          }
        } catch(e) { continue }
      }
    } else if (rule.cssRules) {
      // @media / @supports / @container 等容器规则 → 递归
      var childContext = Object.assign({}, context)
      if (rule instanceof CSSMediaRule) {
        childContext.media = rule.media.mediaText
      }
      try { walkRules(rule.cssRules, el, childContext) } catch(e) {}
    }
  }
}

// 遍历所有样式表
for (var si = 0; si < document.styleSheets.length; si++) {
  var sheet = document.styleSheets[si]
  var source
  if (sheet.href) {
    // 外部样式表：取文件名
    try { source = sheet.href.split('/').pop().split('?')[0] } catch(e) { source = sheet.href }
  } else {
    // 内联 <style>：尝试找 ownerNode 并给个序号
    var owner = sheet.ownerNode
    if (owner) {
      var allStyles = document.querySelectorAll('style')
      var styleIdx = -1
      for (var st = 0; st < allStyles.length; st++) {
        if (allStyles[st] === owner) { styleIdx = st; break }
      }
      source = styleIdx >= 0 ? '<style>[' + styleIdx + ']' : '<style>'
    } else {
      source = '(unknown)'
    }
  }
  try {
    walkRules(sheet.cssRules, el, { source: source })
  } catch(e) {
    // 跨域样式表无法访问 cssRules
    matchedRules.push({
      selector: '(跨域样式表无法读取)',
      props: {},
      source: source,
      crossOrigin: true,
    })
  }
}

// 按特异性排序（important 优先，然后按 specificity 降序）
matchedRules.sort(function(a, b) {
  if (a.important !== b.important) return a.important ? -1 : 1
  for (var d = 0; d < 3; d++) {
    if (a.specificity[d] !== b.specificity[d]) return b.specificity[d] - a.specificity[d]
  }
  return 0
})

// 内联样式
var inlineStyle = {}
if (el.style && el.style.length > 0) {
  for (var ii = 0; ii < el.style.length; ii++) {
    var iprop = el.style[ii]
    inlineStyle[iprop] = {
      value: el.style.getPropertyValue(iprop),
      important: el.style.getPropertyPriority(iprop) === 'important',
    }
  }
}

// 继承属性（从父元素收集可继承的 computed style）
var inheritedProps = ['font', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'color', 'lineHeight', 'letterSpacing', 'textAlign', 'textDecoration', 'textTransform', 'whiteSpace', 'wordSpacing', 'direction', 'visibility', 'cursor', 'opacity']
var inherited = []
var cur = el.parentElement
for (var depth = 0; depth < 3 && cur; depth++) {
  var pcs = getComputedStyle(cur)
  var inheritedFromCur = {}
  for (var ip = 0; ip < inheritedProps.length; ip++) {
    var pn = inheritedProps[ip]
    var val = pcs[pn]
    if (val && val !== 'normal' && val !== 'none' && val !== 'auto' && val !== '') {
      inheritedFromCur[pn] = val
    }
  }
  if (Object.keys(inheritedFromCur).length > 0) {
    inherited.push({
      from: cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : '') + (cur.className && typeof cur.className === 'string' ? '.' + cur.className.split(/\\s+/).filter(Boolean).join('.') : ''),
      props: inheritedFromCur,
    })
  }
  cur = cur.parentElement
}

return {
  matchedRules: matchedRules,
  inlineStyle: inlineStyle,
  inherited: inherited,
}
`
}

/**
 * 生成"读 storage"的 exec 代码
 *
 * 直接 return 对象（serializeResult 会 JSON.stringify，不要再 stringify 一次）。
 * 单个 value 截断到 1000 字符：防止大量 key 的 SPA（如 DeepSeek）总量超 exec 20K 限制。
 * 截断值加 `…(N chars)` 后缀，前端检测到此标记后点击编辑时走单独 exec 获取完整值。
 */
function buildStorageReadCode(type: 'local' | 'session' | 'cookie'): string {
  /**
   * 单个 value 最大长度：超长截断（JWT/base64 图片等可能很长）
   * 1000 字符够看到 token/配置的关键头部，同时控制总大小在 exec 20K 限制内
   */
  const MAX_VAL = 1000
  const truncateExpr = (s: string): string =>
    `${s}.length > ${MAX_VAL} ? ${s}.slice(0, ${MAX_VAL}) + '…(' + ${s}.length + ' chars)' : ${s}`
  if (type === 'cookie') {
    return `
const result = {}
for (const part of document.cookie.split(';')) {
  const eq = part.indexOf('=')
  if (eq > 0) {
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    result[k] = ${truncateExpr('v')}
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
  if (k) {
    const v = ${store}.getItem(k) || ''
    result[k] = ${truncateExpr('v')}
  }
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
