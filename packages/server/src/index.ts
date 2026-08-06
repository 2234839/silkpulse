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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ClarosightServerOptions {
  /** HTTP 端口，默认 8080 */
  port?: number
  /** 静态资源根目录（控制台 UI + sdk），默认 dist同级的 public */
  staticRoot?: string
  /** demo 测试页路径（/demo 路由 serve），默认 dist 同级的 ../../../examples/test-page.html */
  demoPagePath?: string
}

/**
 * 创建并启动 clarosight server
 */
export function createServer(options: ClarosightServerOptions = {}): http.Server {
  const port = options.port ?? 8080
  const registry = new DeviceRegistry()

  /** 静态资源目录：优先用 options.staticRoot，否则用 ../public（console-ui 构建产物 + sdk） */
  const staticRoot = options.staticRoot ?? path.resolve(__dirname, '../public')

  const server = http.createServer(async (req, res) => {
    /** 1. 先交给 API 路由 */
    if (await handleApiRoute(req, res, registry, notifyDeviceListChanged)) return

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

    /** 4. /demo —— 同源测试页（供无头测试真实验证 network 采集，不跨域） */
    if (pathname === '/demo' || pathname === '/demo.html') {
      const demoPagePath = options.demoPagePath ?? path.resolve(__dirname, '../../../examples/test-page.html')
      if (fs.existsSync(demoPagePath)) {
        const html = fs.readFileSync(demoPagePath, 'utf8').replace(/localhost:8080/g, `localhost:${port}`)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end(html)
        return
      }
    }

    /** 5. /inject/* —— 多形态注入（bookmarklet / userscript），让不方便改源码的线上站也能接入 */
    if (pathname === '/inject/bookmarklet' || pathname === '/inject/userscript') {
      const origin = `http://localhost:${port}`
      if (pathname === '/inject/bookmarklet') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(buildBookmarklet(origin))
      } else {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
        res.end(buildUserscript(origin))
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

  /** 挂载 WebSocket 服务（noServer 模式，手动处理 upgrade 以区分 device/console） */
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/ws/device' || url.pathname === '/ws/console') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    } else if (url.pathname === '/ws/test-ws') {
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
    console.log(`  AI 接入：HTTP API → http://localhost:${port}/api/devices\n`)
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
 */
function injectScriptCode(origin: string): string {
  return `(function(){var k='__clarosight_injected__';if(window[k])return;window[k]=1;var s=document.createElement('script');s.src='${origin}/sdk.js';s.dataset.server='${origin}';document.head.appendChild(s);})();`
}

/**
 * 构建 bookmarklet —— 拖到书签栏，在任意页面点击即注入
 */
function buildBookmarklet(origin: string): string {
  const code = injectScriptCode(origin)
  /** bookmarklet 需要 URL 编码特殊字符 */
  return `javascript:${encodeURIComponent(code)}`
}

/**
 * 构建 Tampermonkey/Greasemonkey userscript —— 自动匹配所有页面注入
 */
function buildUserscript(origin: string): string {
  const code = injectScriptCode(origin)
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
