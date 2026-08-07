/**
 * clarosight server 入口 —— 启动 HTTP + WebSocket 服务
 *
 * 服务职责：
 * 1. WebSocket /ws/device   —— 接收设备端 SDK 连接（采集数据上报 + exec 指令下发）
 * 2. WebSocket /ws/console  —— 控制台连接（订阅设备实时数据）
 * 3. HTTP /api/*            —— AI skill 调用入口（devices/snapshot/exec/logs/network/errors）
 * 4. 静态资源               —— 控制台 UI（/）+ SDK 脚本（/sdk.js）
 */

import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { DeviceRegistry } from './device-registry.js'
import { setupWebSocket } from './ws-relay.js'
import { handleApiRoute } from './api.js'
import { AuthManager, ProjectStore, handleProjectApiRoute, readAndCacheBody, type AuthContext } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ClarosightServerOptions {
  /** HTTP 端口，默认 8080 */
  port?: number
  /** 静态资源根目录（控制台 UI + sdk），默认 dist同级的 public */
  staticRoot?: string
  /** demo 测试页路径（/demo 路由 serve），默认 dist 同级的 ../../../examples/test-page.html */
  demoPagePath?: string
  /** 项目数据文件路径（默认 ~/.clarosight/projects.json） */
  projectDataPath?: string
}

/**
 * 创建并启动 clarosight server
 */
export function createServer(options: ClarosightServerOptions = {}): http.Server {
  const port = options.port ?? 8080

  /** 项目数据持久化路径：优先 options，否则用环境变量，最后默认 ~/.clarosight/projects.json */
  const defaultDataDir = process.env.CLAROSIGHT_DATA_DIR ?? path.join(process.env.HOME ?? '/tmp', '.clarosight')
  const projectDataPath = options.projectDataPath ?? path.join(defaultDataDir, 'projects.json')
  const projectStore = new ProjectStore(projectDataPath)
  const auth = new AuthManager(projectStore)
  const registry = new DeviceRegistry()

  /** 静态资源目录：优先用 options.staticRoot，否则用 ../public（console-ui 构建产物 + sdk） */
  const staticRoot = options.staticRoot ?? path.resolve(__dirname, '../public')

  const server = http.createServer(async (req, res) => {
    /** 安全响应头 */
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')

    /** 缓存请求体（项目管理 + 鉴权 API 需要） */
    if (req.url?.startsWith('/api/projects') || req.url?.startsWith('/api/auth')) {
      await readAndCacheBody(req)
      /** 项目管理 API + 鉴权状态 API */
      if (handleProjectApiRoute(req, res, auth)) return
    }

    /** 1. 鉴权上下文（附加到 req 上，后续 API 路由使用） */
    const authCtx = auth.authorizeHttpRequest(req)
    ;(req as unknown as { __authCtx?: AuthContext }).__authCtx = authCtx

    /** 1.5 先交给 API 路由 */
    if (await handleApiRoute(req, res, registry, notifyDeviceListChanged, auth, authCtx)) return

    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    /** 2. 首页 → 控制台 UI */
    if (pathname === '/' || pathname === '/index.html') {
      const indexPath = path.resolve(staticRoot, 'index.html')
      if (fs.existsSync(indexPath)) {
        serveFile(res, indexPath, 'text/html; charset=utf-8')
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(controlUnavailableHtml())
      }
      return
    }

    /** 3. sdk.js —— SDK 注入脚本（供远程页面 <script src>） */
    if (pathname === '/sdk.js') {
      const sdkPath = path.resolve(staticRoot, 'sdk.js')
      if (fs.existsSync(sdkPath)) {
        serveFile(res, sdkPath, 'application/javascript; charset=utf-8')
      } else {
        res.writeHead(404)
        res.end('// sdk.js 未构建，请在 packages/sdk 执行构建')
      }
      return
    }

    /** 3.5 /favicon.ico —— 控制台自身 favicon（SDK demo 页面也能同源 fetch 到） */
    if (pathname === '/favicon.ico') {
      /** 32×32 蓝底白圆 PNG（有视觉内容，验证 Network 面板图片预览效果） */
      const faviconPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAXUlEQVR4nGOwbvpGU8QwasGoBTD0HwNQzQJMo0myBp8F+I0m0hqcFhBvOn47BsgCUk3HY8dAWECe6bjsGLVgZFow9PMBPYoKelhA8+KaSGsIah8EVSaFaNSCEWABAEdJY9GqZCFVAAAAAElFTkSuQmCC', 'base64')
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' })
      res.end(faviconPng)
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
        const demoHost = req.headers.host || `localhost:${port}`
        const demoProto = req.headers['x-forwarded-proto'] || 'http'
        const demoOrigin = `${demoProto}://${demoHost}`
        let html = fs.readFileSync(demoPagePath, 'utf8').replace(/https?:\/\/localhost:8080/g, demoOrigin)
        /** 鉴权启用时，demo 页面自动注入超管密钥（本地测试页，非对外暴露） */
        if (auth.isAuthEnabled()) {
          /** 从 URL query 获取可选的 apiKey/projectId（支持测试不同项目） */
          const qApiKey = url.searchParams.get('apiKey')
          const qProjectId = url.searchParams.get('projectId')
          /** 默认用超管密钥（demo 页面是 server 本地测试页，用超管密钥直连） */
          const envAdminKey = process.env.CLAROSIGHT_ADMIN_KEY
          const injectAttrs = qApiKey && qProjectId
            ? `data-api-key="${qApiKey}" data-project-id="${qProjectId}"`
            : envAdminKey
              ? `data-api-key="${envAdminKey}"`
              : ''
          if (injectAttrs) {
            html = html.replace(
              /(<script\s+src="[^"]*sdk\.js"\s+data-server="[^"]*")/,
              `$1 ${injectAttrs}`,
            )
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end(html)
        return
      }
    }

    /** 5. /inject/* —— 多形态注入（iife / bookmarklet / userscript），让不方便改源码的线上站也能接入 */
    if (pathname === '/inject/iife' || pathname === '/inject/bookmarklet' || pathname === '/inject/userscript') {
      /** 根据请求 Host header 推断 origin，本地用 localhost:port，线上用实际域名 */
      const injHost = req.headers.host || `localhost:${port}`
      const injProto = req.headers['x-forwarded-proto'] || 'http'
      const origin = `${injProto}://${injHost}`
      /** 可选：携带 project_id 查询参数，拼入 inject 代码（设备端不需要密钥） */
      const projectId = url.searchParams.get('project_id') ?? undefined
      if (pathname === '/inject/iife') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
        res.end(injectScriptCode(origin, projectId))
      } else if (pathname === '/inject/bookmarklet') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(buildBookmarklet(origin, projectId))
      } else {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
        res.end(buildUserscript(origin, projectId))
      }
      return
    }

    /** 6. /inject-test —— 不含 SDK 的干净页面（测试 bookmarklet/userscript 注入效果） */
    if (pathname === '/inject-test') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>inject 测试页</title></head><body><h1>空白测试页</h1><p>用于验证 bookmarklet/userscript 注入</p></body></html>`)
      return
    }

    /** 7. /test-fixtures/crash.js(+.map) —— source map 解析测试用的压缩脚本 + map */
    /** minified: function n(r){throw new Error(r)}n("source map 测试错误") —— 加载即抛错 */
    /** throw @ 1:14 → crash.ts:2:2，new Error @ 1:20 → crash.ts:2:8 */
    if (pathname === '/test-fixtures/crash.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end('function n(r){throw new Error(r)}n("source map 测试错误")\n//# sourceMappingURL=crash.js.map')
      return
    }
    if (pathname === '/test-fixtures/crash.js.map') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
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
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
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
        if (idx >= events.length) {
          clearInterval(timer)
          res.end()
          return
        }
        const { event, id, data } = events[idx++]
        let chunk = ''
        if (id) chunk += `id: ${id}\n`
        chunk += `event: ${event}\n`
        chunk += `data: ${data}\n\n`
        res.write(chunk)
      }, 500)
      /** 客户端断开时清理定时器 */
      req.on('close', () => clearInterval(timer))
      return
    }

    /** 5. 其他静态资源（控制台 UI 的 JS/CSS/图片） */
    const filePath = path.resolve(staticRoot, pathname.slice(1))
    if (filePath.startsWith(staticRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      /**
       * Vite 构建产物在 /assets/ 下且文件名带 8+ 位 hash，可长缓存；其他保守 no-cache。
       * Vite 的 hash 是 base64url（含 - 和 _），字符集要覆盖，否则含 - 的 hash
       * 会被误判为无 hash → 降级 no-cache，导致长缓存失效。
       */
      const isHashed = pathname.includes('/assets/') && /-[a-zA-Z0-9_-]{8,}\.\w+$/.test(pathname)
      serveFile(res, filePath, guessContentType(filePath), isHashed ? 'longCache' : 'noCache')
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  /**
   * 挂载 WebSocket 服务（noServer 模式，手动处理 upgrade 以区分 device/console）
   *
   * perMessageDeflate：启用 WebSocket 原生 permessage-deflate 扩展。
   * 浏览器（SDK 端）和 `ws` 库都原生支持，握手时自动协商，
   * 应用层完全透明——所有 JSON 消息在传输层自动压缩/解压。
   *
   * 阈值策略：
   * - threshold 256B：小于此长度的消息不压缩（压缩头开销 > 收益）
   * - memLevel / level：默认压缩参数，平衡速度和压缩率
   * - serverMaxWindowBits / clientMaxWindowBits：滑动窗口位数，默认值已够
   * - zlibDeflateReset 间隔：定期复用 deflate 上下文避免内存泄漏
   *
   * 对 DOM 快照、日志批量上报等大 JSON 压缩率通常 70-90%。
   */
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 256,
    },
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (pathname === '/ws/device' || pathname === '/ws/console') {
      /** WebSocket 连接鉴权 */
      const wsAuthCtx = auth.authorizeWsConnection(req, pathname)
      if (wsAuthCtx.role === 'anonymous' && auth.isAuthEnabled()) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        /** 把鉴权上下文附在 ws 上，ws-relay 用来做项目隔离 */
        ;(ws as unknown as { __authCtx?: AuthContext }).__authCtx = wsAuthCtx
        wss.emit('connection', ws, req)
      })
    } else if (pathname === '/ws/test-ws') {
      /** 测试用 echo WS：收到什么回什么，验证 SDK 的 WS 采集（连接/send/recv/close） */
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data) => ws.send(data))
      })
    } else {
      socket.destroy()
    }
  })
  const { notifyDeviceListChanged } = setupWebSocket(wss, registry)

  server.listen(port, () => {
    console.log(`\n  clarosight 服务已启动 → http://localhost:${port}`)
    console.log(`  控制台：浏览器打开 http://localhost:${port}`)
    console.log(`  接入设备：在目标页面注入 <script src="http://localhost:${port}/sdk.js"></script>`)
    console.log(`  AI 接入：HTTP API → http://localhost:${port}/api/devices`)
    if (auth.isAuthEnabled()) {
      console.log(`  🔒 鉴权已启用（${auth.hasAdminKey() ? '超管密钥 + ' : ''}${projectStore.list().length} 个项目）`)
    } else {
      console.log(`  ⚠️  鉴权未启用（设置 CLAROSIGHT_ADMIN_KEY 环境变量来开启）`)
    }
    console.log('')
  })

  return server
}

/** 发送文件响应 */
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
  res: http.ServerResponse,
  filePath: string,
  contentType: string,
  cache: CachePolicy = 'noCache',
): void {
  try {
    const stat = fs.statSync(filePath)
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      ...cacheHeaders(cache),
    }
    /** 带 ETag（文件 mtime+size），支持 304（no-cache 策略下省带宽） */
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`
    headers['ETag'] = etag
    if (res.req?.headers['if-none-match'] === etag) {
      res.writeHead(304)
      res.end()
      return
    }
    const stream = fs.createReadStream(filePath)
    res.writeHead(200, headers)
    stream.pipe(res)
  } catch {
    res.writeHead(500)
    res.end('Internal error')
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
<h1>clarosight server 已启动</h1>
<p>控制台 UI 尚未构建。请执行：<code>pnpm --filter @clarosight/console-ui build</code></p>
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
  return `(function(){var k='__clarosight_injected__';if(window[k])return;window[k]=1;var s=document.createElement('script');s.src='${origin}/sdk.js';${dataAttrs};document.head.appendChild(s);})();`
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
// @name         clarosight 远程调试注入
// @namespace    clarosight
// @version      0.1.0
// @description  自动注入 clarosight SDK，将当前页面接入远程调试
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==
(function(){${code}})();
`
}
