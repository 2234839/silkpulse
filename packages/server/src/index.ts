/**
 * silkpulse server 入口 —— 启动 HTTP + WebSocket 服务（uWebSockets.js 原生实现）
 *
 * 服务职责：
 * 1. WebSocket /ws/device   —— 接收设备端 SDK 连接（采集数据上报 + exec 指令下发）
 * 2. WebSocket /ws/console  —— 控制台连接（订阅设备实时数据）
 * 3. HTTP /api/*            —— AI skill 调用入口（devices/snapshot/exec/logs/network/errors）
 * 4. 静态资源               —— 控制台 UI（/）+ SDK 脚本（/sdk.js）
 *
 * uWS 关键约定（与 node:http 的差异）：
 * - 异步 handler 返回前必须 res.onAborted（否则进程 abort）
 * - upgrade 第 5 参数必须是 upgrade 回调的 context（否则 socket hang up）
 * - res 的 status/headers 必须在 end 前一次性写完
 */

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import uWS from 'uWebSockets.js'
import { DeviceRegistry } from './device-registry.js'
import { setupWebSocket, registerSocketUrl } from './ws-relay.js'
import { handleApiRoute } from './api.js'
import { handleAgentApiRoute } from './agent-api.js'
import { AuthManager, ProjectStore, handleProjectApiRoute, type AuthContext } from './auth.js'
import { maybeGzipResponse } from './gzip.js'
import { createCtx, onAborted, readBody, writeResponse, sendNotModified, type Ctx } from './uws/http-helpers.js'
import { SilkWs, type WsUserData } from './uws/ws-socket.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface SilkPulseServerOptions {
  /** HTTP 端口，默认 8080 */
  port?: number
  /** 静态资源根目录（控制台 UI + sdk），默认 dist同级的 public */
  staticRoot?: string
  /** demo 测试页路径（/demo 路由 serve），默认 dist 同级的 ../../../examples/test-page.html */
  demoPagePath?: string
  /** 项目数据文件路径（默认 ~/.silkpulse/projects.json） */
  projectDataPath?: string
}

/**
 * 创建并启动 silkpulse server（uWS 版）
 *
 * 返回 uWS TemplatedApp（listen 已调用并就绪）。
 * uWS 不支持 server.close() 式的编程接口 —— 进程退出即服务终止。
 */
export async function createServer(options: SilkPulseServerOptions = {}): Promise<uWS.TemplatedApp> {
  const port = options.port ?? 8080

  /** 项目数据持久化路径：优先 options，否则用环境变量，最后默认 ~/.silkpulse/projects.json */
  const defaultDataDir = process.env.SILKPULSE_DATA_DIR ?? path.join(process.env.HOME ?? '/tmp', '.silkpulse')
  const projectDataPath = options.projectDataPath ?? path.join(defaultDataDir, 'projects.json')
  const projectStore = new ProjectStore(projectDataPath)
  const registry = new DeviceRegistry()

  /** 静态资源目录：优先用 options.staticRoot，否则用 ../public（console-ui 构建产物 + sdk） */
  const staticRoot = options.staticRoot ?? path.resolve(__dirname, '../public')

  const app = uWS.App()

  /**
   * 鉴权管理器：游客项目过期销毁时，踢掉对应项目的设备并刷新控制台列表
   * （必须先有 registry / ws 层的 notifyDeviceListChanged，所以在其后构造）
   */
  const auth = new AuthManager(projectStore, (expiredIds) => {
    for (const pid of expiredIds) registry.evictDevicesOfProject(pid)
  })

  /** 游客项目过期销毁后的设备踢除 → 通知控制台刷新列表 */
  const { behavior, notifyDeviceListChanged } = setupWebSocket(registry, auth)
  registry.onEvict(() => notifyDeviceListChanged())

  /**
   * WS upgrade 处理器工厂（device/console 各一份）
   *
   * 鉴权失败的连接在 upgrade 前回 401（uWS 语义：非 101 状态直接拒绝握手）。
   * 通过鉴权的连接：UserData 挂 SilkWs 占位 + WeakMap 存 URL，
   * 真正的 SilkWs 实例化延迟到 open 回调（那时才能拿到 WebSocket 对象）。
   */
  /**
   * upgrade→open 的状态传递
   *
   * uWS 的 upgrade 只能带 plain object（UserData），且 open 回调里拿不到
   * 原始 req —— 鉴权上下文和 URL 都在 upgrade 阶段解析后挂进 UserData，
   * open 回调里直接读取（upgrade 传入的对象就是 getUserData() 返回的同一个）。
   * 这是 uWS 官方推荐的 UserData 传递模式，无竞态。
   */
  const wsUpgrade = (wsPath: string) => (res: uWS.HttpResponse, req: uWS.HttpRequest, context: uWS.us_socket_context_t) => {
    const url = req.getUrl() + (req.getQuery() ? '?' + req.getQuery() : '')
    const wsAuthCtx = auth.authorizeWsConnection(url, wsPath)
    if (wsAuthCtx.role === 'anonymous' && auth.isAuthEnabled()) {
      res.writeStatus('401 Unauthorized').end()
      return
    }
    res.upgrade(
      { silk: undefined as never, authCtx: wsAuthCtx, url },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context,
    )
  }

  /** 包装 behavior：open 时完成 SilkWs 实例化（真正的业务挂载点） */
  const wrappedBehavior: uWS.WebSocketBehavior<WsUserData> = {
    ...behavior,
    open: (ws) => {
      const data = ws.getUserData() as WsUserData & { authCtx?: AuthContext; url?: string }
      const silk = new SilkWs(ws, data.authCtx ?? { role: 'device' })
      data.silk = silk
      registerSocketUrl(silk, data.url ?? '/')
      behavior.open?.(ws)
    },
  }

  app.ws<WsUserData>('/ws/device', { ...wrappedBehavior, upgrade: wsUpgrade('/ws/device') })
  app.ws<WsUserData>('/ws/console', { ...wrappedBehavior, upgrade: wsUpgrade('/ws/console') })

  /** 测试用 echo WS：收到什么回什么，验证 SDK 的 WS 采集（连接/send/recv/close） */
  app.ws('/ws/test-ws', {
    idleTimeout: 32,
    sendPingsAutomatically: true,
    message: (ws, message) => {
      ws.send(message)
    },
  })

  /** 主请求处理（app.any 全方法通配，内部按路径分发） */
  app.any('/*', async (res, req) => {
    const ctx = createCtx(res, req)
    onAborted(ctx)

    /** 安全响应头（所有响应统一带上） */
    const securityHeaders = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    }

    /** 缓存请求体（项目管理 + 鉴权 + 游客自建项目 API 需要） */
    if (ctx.url.startsWith('/api/projects') || ctx.url.startsWith('/api/auth') || ctx.url.startsWith('/api/guest')) {
      await readBody(ctx)
      if (ctx.aborted) return
      /** 项目管理 API + 鉴权状态 API */
      if (handleProjectApiRoute(ctx, auth)) return
    }

    /** 1. 鉴权上下文（路由参数直接传，不再挂 req 上） */
    const authCtx = auth.authorizeHttpRequest(ctx)

    /** 1.5 先交给 agent API 路由（/api/agent/*） */
    if (await handleAgentApiRoute(ctx, registry, authCtx)) return

    /** 1.6 再交给内部 API 路由（/api/devices/* 等） */
    if (await handleApiRoute(ctx, registry, notifyDeviceListChanged, auth, authCtx)) return

    const url = ctx.parsedUrl
    const pathname = url.pathname

    /** 2. 首页 → 控制台 UI */
    if (pathname === '/' || pathname === '/index.html') {
      const indexPath = path.resolve(staticRoot, 'index.html')
      if (fs.existsSync(indexPath)) {
        serveFile(ctx, indexPath, 'text/html; charset=utf-8', securityHeaders)
      } else {
        writeResponse(ctx, 200, { 'Content-Type': 'text/html; charset=utf-8' }, controlUnavailableHtml())
      }
      return
    }

    /** 3. sdk.js —— SDK 注入脚本（供远程页面 <script src>） */
    if (pathname === '/sdk.js') {
      const sdkPath = path.resolve(staticRoot, 'sdk.js')
      if (fs.existsSync(sdkPath)) {
        serveFile(ctx, sdkPath, 'application/javascript; charset=utf-8', securityHeaders)
      } else {
        writeResponse(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, '// sdk.js 未构建，请在 packages/sdk 执行构建')
      }
      return
    }

    /** 3.5 /favicon.ico —— 控制台自身 favicon（SDK demo 页面也能同源 fetch 到） */
    if (pathname === '/favicon.ico') {
      /** 32×32 蓝底白圆 PNG（有视觉内容，验证 Network 面板图片预览效果） */
      const faviconPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAXUlEQVR4nGOwbvpGU8QwasGoBTD0HwNQzQJMo0myBp8F+I0m0hqcFhBvOn47BsgCUk3HY8dAWECe6bjsGLVgZFow9PMBPYoKelhA8+KaSGsIah8EVSaFaNSCEWABAEdJY9GqZCFVAAAAAElFTkSuQmCC', 'base64')
      writeResponse(ctx, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }, faviconPng)
      return
    }

    /** 4. /demo —— 同源测试页（供无头测试真实验证 network 采集，不跨域） */
    if (pathname === '/demo' || pathname === '/demo.html') {
      /** bundle 后 __dirname 不可靠，从多个候选路径查找 demo 页面 */
      const demoPagePath = options.demoPagePath ?? [
        /** 本地 dev：packages/server/dist/bin/ → ../../../../examples/ */
        path.resolve(__dirname, '../../../../examples/test-page.html'),
        /** 容器部署 dist/bin/ → ../../../examples/ */
        path.resolve(__dirname, '../../../examples/test-page.html'),
        /** 容器部署 dist/bin/ → ../../examples/ */
        path.resolve(__dirname, '../../examples/test-page.html'),
        /** Docker /app/dist/bin/ → ../examples/ */
        path.resolve(__dirname, '../examples/test-page.html'),
        /** 1Panel 容器固定路径 */
        '/app/examples/test-page.html',
      ].find(p => fs.existsSync(p))
      if (demoPagePath && fs.existsSync(demoPagePath)) {
        /** 根据请求 Host header 推断 origin，本地用 localhost:port，线上用实际域名 */
        const demoHost = ctx.headers['host'] || `localhost:${port}`
        const demoProto = ctx.headers['x-forwarded-proto'] || 'http'
        const demoOrigin = `${demoProto}://${demoHost}`
        let html = fs.readFileSync(demoPagePath, 'utf8').replace(/https?:\/\/localhost:8080/g, demoOrigin)
        /** 鉴权启用时，demo 页面自动注入超管密钥（本地测试页，非对外暴露） */
        if (auth.isAuthEnabled()) {
          /** 从 URL query 获取可选的 apiKey/projectId（支持测试不同项目） */
          const qApiKey = url.searchParams.get('apiKey')
          const qProjectId = url.searchParams.get('projectId')
          /** 默认用超管密钥（demo 页面是 server 本地测试页，用超管密钥直连） */
          const envAdminKey = process.env.SILKPULSE_ADMIN_KEY
          const injectAttrs = qApiKey && qProjectId
            ? `data-api-key="${qApiKey}" data-project-id="${qProjectId}"`
            : envAdminKey
              ? `data-api-key="${envAdminKey}"`
              : ''
          if (injectAttrs) {
            /** 兼容两种写法：带 data-server 的完整形态 + 相对路径 /sdk.js 简写形态 */
            html = html.replace(
              /(<script\s+src="[^"]*sdk\.js"[^>]*?)(\s*\/?>)/,
              `$1 ${injectAttrs}$2`,
            )
          }
        }
        writeResponse(ctx, 200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          ...securityHeaders,
        }, html)
        return
      }
    }

    /** 5. /inject/* —— 多形态注入（iife / bookmarklet / userscript），让不方便改源码的线上站也能接入 */
    if (pathname === '/inject/iife' || pathname === '/inject/bookmarklet' || pathname === '/inject/userscript') {
      /** 根据请求 Host header 推断 origin，本地用 localhost:port，线上用实际域名 */
      const injHost = ctx.headers['host'] || `localhost:${port}`
      const injProto = ctx.headers['x-forwarded-proto'] || 'http'
      const origin = `${injProto}://${injHost}`
      /** 可选：携带 project_id 查询参数，拼入 inject 代码（设备端不需要密钥） */
      const projectId = url.searchParams.get('project_id') ?? undefined
      if (pathname === '/inject/iife') {
        writeResponse(ctx, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }, injectScriptCode(origin, projectId))
      } else if (pathname === '/inject/bookmarklet') {
        writeResponse(ctx, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, buildBookmarklet(origin, projectId))
      } else {
        writeResponse(ctx, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }, buildUserscript(origin, projectId))
      }
      return
    }

    /** 6. /inject-test —— 不含 SDK 的干净页面（测试 bookmarklet/userscript 注入效果） */
    if (pathname === '/inject-test') {
      writeResponse(ctx, 200, { 'Content-Type': 'text/html; charset=utf-8' }, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>inject 测试页</title></head><body><h1>空白测试页</h1><p>用于验证 bookmarklet/userscript 注入</p></body></html>`)
      return
    }

    /** 7. /test-fixtures/crash.js(+.map) —— source map 解析测试用的压缩脚本 + map */
    /** minified: function n(r){throw new Error(r)}n("source map 测试错误") —— 加载即抛错 */
    /** throw @ 1:14 → crash.ts:2:2，new Error @ 1:20 → crash.ts:2:8 */
    if (pathname === '/test-fixtures/crash.js') {
      writeResponse(ctx, 200, { 'Content-Type': 'application/javascript; charset=utf-8' }, 'function n(r){throw new Error(r)}n("source map 测试错误")\n//# sourceMappingURL=crash.js.map')
      return
    }
    if (pathname === '/test-fixtures/crash.js.map') {
      writeResponse(ctx, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({
        version: 3,
        sources: ['crash.ts'],
        mappings: 'AAAA,SAASA,EAAeC,EAAoB,CAC1C,MAAM,IAAI,MAAMA,CAAG,CACrB,CACAD,EAAe,qCAAiB',
        names: ['crashOnPurpose', 'msg'],
      }))
      return
    }

    /**
     * /sse-test —— SSE 测试端点（text/event-stream）
     *
     * 推送 5 条事件（含 event/id/data 字段），每条间隔 500ms，推完关闭连接。
     * 供 demo 页面的 SSE 测试按钮调用，验证 SDK 的 SSE 流式采集。
     * 注意：路径不能以 /api/ 开头，否则会被 handleApiRoute 的 404 兜底拦截。
     */
    if (pathname === '/sse-test') {
      if (ctx.responded || ctx.aborted) return
      /** SSE 头先写，进入流式模式（writeStatus 后用 write 连续推送） */
      ctx.res.cork(() => {
        ctx.res.writeStatus('200 OK')
        ctx.res.writeHeader('Content-Type', 'text/event-stream')
        ctx.res.writeHeader('Cache-Control', 'no-cache')
        ctx.res.writeHeader('Access-Control-Allow-Origin', '*')
      })
      const events = [
        { event: 'message', data: 'SSE 连接已建立' },
        { event: 'update', id: '1', data: JSON.stringify({ count: 1, msg: '第一条更新' }) },
        { event: 'update', id: '2', data: JSON.stringify({ count: 2, msg: '第二条更新' }) },
        { event: 'ping', data: 'heartbeat' },
        { event: 'done', id: '3', data: 'SSE 流结束' },
      ]
      let idx = 0
      const timer = setInterval(() => {
        if (ctx.aborted) {
          clearInterval(timer)
          return
        }
        if (idx >= events.length) {
          clearInterval(timer)
          ctx.res.end()
          return
        }
        const { event, id, data } = events[idx++]
        let chunk = ''
        if (id) chunk += `id: ${id}\n`
        chunk += `event: ${event}\n`
        chunk += `data: ${data}\n\n`
        ctx.res.write(chunk)
      }, 500)
      /** 客户端断开时清理定时器 */
      ctx.res.onAborted(() => {
        ctx.aborted = true
        clearInterval(timer)
      })
      return
    }

    /** 8. 其他静态资源（控制台 UI 的 JS/CSS/图片） */
    const filePath = path.resolve(staticRoot, pathname.slice(1))
    if (filePath.startsWith(staticRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      /**
       * Vite 构建产物在 /assets/ 下且文件名带 8+ 位 hash，可长缓存；其他保守 no-cache。
       * Vite 的 hash 是 base64url（含 - 和 _），字符集要覆盖，否则含 - 的 hash
       * 会被误判为无 hash → 降级 no-cache，导致长缓存失效。
       */
      const isHashed = pathname.includes('/assets/') && /-[a-zA-Z0-9_-]{8,}\.\w+$/.test(pathname)
      serveFile(ctx, filePath, guessContentType(filePath), securityHeaders, isHashed ? 'longCache' : 'noCache')
      return
    }

    /**
     * 9. SPA 路由回退
     *
     * Vue Router 的 history 模式下，/tools 等前端路由需要返回 index.html，
     * 由前端 JS 解析路径并渲染对应组件。排除 /api/、/ws/ 等已知后端前缀。
     */
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/ws/') && !pathname.startsWith('/inject')) {
      const indexPath = path.resolve(staticRoot, 'index.html')
      if (fs.existsSync(indexPath)) {
        serveFile(ctx, indexPath, 'text/html; charset=utf-8', securityHeaders)
        return
      }
    }

    writeResponse(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found')
  })

  /** 启动监听（uWS listen 异步，包成 promise 等端口就绪） */
  await new Promise<void>((resolve, reject) => {
    app.listen(port, (listenSocket) => {
      if (listenSocket) {
        console.log(`\n  silkpulse 服务已启动 → http://localhost:${port}`)
        console.log(`  控制台：浏览器打开 http://localhost:${port}`)
        console.log(`  接入设备：在目标页面注入 <script src="http://localhost:${port}/sdk.js"></script>`)
        console.log(`  AI 接入：HTTP API → http://localhost:${port}/api/devices`)
        if (auth.isAuthEnabled()) {
          console.log(`  🔒 鉴权已启用（${auth.hasAdminKey() ? '超管密钥 + ' : ''}${projectStore.list().length} 个项目）`)
        } else {
          console.log(`  ⚠️  鉴权未启用（设置 SILKPULSE_ADMIN_KEY 环境变量来开启）`)
        }
        console.log('')
        resolve()
      } else {
        reject(new Error(`端口 ${port} 监听失败`))
      }
    })
  })

  return app
}

/**
 * 缓存策略
 *
 * - noCache：诊断工具的入口资源（sdk.js、index.html）必须每次 revalidate，
 *   否则远程设备用旧 SDK、开发者用旧控制台，行为不一致（诊断工具大忌）
 * - longCache：带内容 hash 的构建产物（index-XXXX.js/css），永不变化可强缓存
 */
type CachePolicy = 'noCache' | 'longCache'

function cacheHeaders(policy: CachePolicy): Record<string, string> {
  if (policy === 'longCache') {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' }
  }
  return { 'Cache-Control': 'no-cache' }
}

function serveFile(
  ctx: Ctx,
  filePath: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
  cache: CachePolicy = 'noCache',
): void {
  try {
    const stat = fs.statSync(filePath)
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
      ...cacheHeaders(cache),
    }
    /** 带 ETag（文件 mtime+size），支持 304（no-cache 策略下省带宽） */
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`
    headers['ETag'] = etag
    if (ctx.headers['if-none-match'] === etag) {
      sendNotModified(ctx, headers)
      return
    }
    /**
     * 读取文件到 Buffer，支持 gzip 压缩。
     * Vite 构建产物通常 <1MB，一次性读入无内存压力；
     * 超过 GZIP_THRESHOLD 且客户端支持 gzip 时压缩传输。
     */
    const fileBuf = fs.readFileSync(filePath)
    const { body, headers: gzipHeaders } = maybeGzipResponse({ headers: ctx.headers }, fileBuf, headers)
    writeResponse(ctx, 200, gzipHeaders, body)
  } catch {
    writeResponse(ctx, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal error')
  }
}

/** 猜测 Content-Type */
function guessContentType(filePath: string): string {
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.png')) return 'image/png'
  if (filePath.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}

/** 控制台未构建时的占位 HTML */
function controlUnavailableHtml(): string {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
<h1>silkpulse server 已启动</h1>
<p>控制台 UI 尚未构建。请执行：<code>pnpm --filter @silkpulse/console-ui build</code></p>
<p>SDK 接入：在目标页面注入 <code>&lt;script src="/sdk.js"&gt;&lt;/script&gt;</code></p>
<p>HTTP API：<code>GET /api/devices</code> 查看在线设备</p>
</body></html>`
}

/**
 * 注入器核心 JS：往当前页面塞一个带 data-server 的 sdk.js script 标签
 * 防重复注入（同页面多次点 bookmarklet 只生效一次）
 * 鉴权模式下携带 projectId 标记设备归属（不需要密钥，密钥不暴露到设备端）
 */
function injectScriptCode(origin: string, projectId?: string): string {
  /** 动态拼 data-* 属性 */
  const dataAttrs = [
    `s.dataset.server='${origin}'`,
    projectId ? `s.dataset.projectId='${projectId}'` : '',
  ].filter(Boolean).join(';')
  return `(function(){var k='__silkpulse_injected__';if(window[k])return;window[k]=1;var s=document.createElement('script');s.src='${origin}/sdk.js';${dataAttrs};document.head.appendChild(s);})();`
}

/**
 * 构建 bookmarklet —— 拖到书签栏，在任意页面点击即注入
 */
function buildBookmarklet(origin: string, projectId?: string): string {
  const code = injectScriptCode(origin, projectId)
  /** bookmarklet 需要 URL 编码特殊字符 */
  return `javascript:${encodeURIComponent(code)}`
}

/**
 * 构建 Tampermonkey/Greasemonkey userscript —— 自动匹配所有页面注入
 */
function buildUserscript(origin: string, projectId?: string): string {
  const code = injectScriptCode(origin, projectId)
  return `// ==UserScript==
// @name         silkpulse 远程调试注入
// @namespace    silkpulse
// @version      0.1.0
// @description  自动注入 silkpulse SDK，将当前页面接入远程调试
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==
(function(){${code}})();
`
}
