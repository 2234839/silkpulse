/**
 * uWS PoC server —— 复刻 silkpulse 压测路径的真实语义
 *
 * 目的：与 ws 库版本（packages/server）做同负载 A/B 对比。
 * 复刻的语义（对齐 scripts/load-test.mjs 依赖的协议面）：
 *   1. /ws/device   ：register（设备表 + device-list 广播）/ log（环形缓冲 500 + 扇出）/ exec 指令下发 + exec-result 回传
 *   2. /ws/console  ：subscribe/unsubscribe（deviceWatchers 订阅表）、device-list / device-online 推送
 *   3. /api/health  ：RSS / eventLoopUtilization / fanout 四指标（与真 server 同口径）
 *   4. /api/devices/:id/exec：HTTP exec（pendingExecs + 10s 超时）
 *
 * 压测脚本无需改动：SILKPULSE_TEST_URL=http://localhost:8082 即可打本 server。
 */
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)
const uWS = require('uWebSockets.js')
const PORT = Number(process.env.PORT ?? 8082)
/** 压缩模式：shared（uWS SHARED_COMPRESSOR）/ dedicated（DEDICATED_COMPRESSOR 3KB）/ none */
const COMPRESS_MODE = process.env.UWS_COMPRESS ?? 'shared'

/* ─── 状态表（对齐 device-registry / ws-relay） ─── */
const devices = new Map() // deviceId → { info, logs: Ring(500), ws }
const watchers = new Map() // deviceId → Set<consoleWs>
const pendingExecs = new Map() // execId → { deviceWs, timeout, resolve }
const fanoutStats = { sent: 0, skippedClosed: 0, skippedProject: 0, backpressureClosed: 0 }

/* 环形缓冲（对齐 device-registry MAX_LOGS=500） */
class Ring {
  constructor(cap) { this.cap = cap; this.buf = []; this.i = 0 }
  push(x) { if (this.buf.length < this.cap) this.buf.push(x); else { this.buf[this.i] = x; this.i = (this.i + 1) % this.cap } }
  toJSON() { return [...this.buf.slice(this.i), ...this.buf.slice(0, this.i)] }
}

/* ELU 采样（对齐 api.ts health 口径） */
let prevELU = performance.eventLoopUtilization()
function eluPct() {
  const u = performance.eventLoopUtilization(prevELU)
  prevELU = performance.eventLoopUtilization()
  return u.utilization * 100
}
function rssMB() { return +(process.memoryUsage().rss / 1048576).toFixed(1) }

/* ws.send 的背压语义在 uWS 下用 getBufferedAmount 复刻 */
function safeSend(ws, text) {
  if (ws.getBufferedAmount() > 1024 * 1024) {
    fanoutStats.backpressureClosed++
    ws.close()
    return false
  }
  ws.send(text)
  fanoutStats.sent++
  return true
}

/* 扇出（对齐 ws-relay.broadcast：一次 stringify + per-watcher 发送 + 背压关闭） */
function broadcast(deviceId, msg) {
  const set = watchers.get(deviceId)
  if (!set) return
  const text = JSON.stringify(msg)
  for (const ws of set) {
    safeSend(ws, text)
  }
}

/* 设备表变化 → 所有控制台推 device-list（对齐 notifyDeviceListChanged） */
function notifyDeviceListChanged() {
  const list = [...devices.values()].map((d) => d.info)
  const text = JSON.stringify({ type: 'device-list', devices: list })
  for (const ws of consoleSockets) {
    safeSend(ws, text)
  }
}
const consoleSockets = new Set()

/* ─── WS 路由 ─── */
const app = uWS.App()

/* 压缩器选择（uWS 对 permessage-deflate 的两种实现语义） */
const compressor =
  COMPRESS_MODE === 'shared' ? uWS.SHARED_COMPRESSOR
  : COMPRESS_MODE === 'dedicated' ? uWS.DEDICATED_COMPRESSOR(3 * 1024)
  : 0

app.ws('/ws/device', {
  compression: compressor,
  maxPayloadLength: 4 * 1024 * 1024,
  idleTimeout: 60,
  upgrade: (res, req, context) => {
    res.upgrade(
      { deviceId: null },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context
    )
  },
  open: (ws) => { ws.deviceId = null },
  message: (ws, data, isBinary) => {
    if (isBinary) return
    const text = Buffer.from(data).toString()
    /** 高频路径免全量 JSON.parse 优化：先粗判（真实 server 是直接 parse，保持一致） */
    let msg
    try { msg = JSON.parse(text) } catch { return }

    if (msg.type === 'register') {
      const info = msg.device
      const existing = devices.get(info.id)
      ws.deviceId = info.id
      if (existing) {
        existing.ws = ws
        existing.info = info
      } else {
        devices.set(info.id, { info, logs: new Ring(500), ws })
        broadcastAll({ type: 'device-online', device: info })
      }
      notifyDeviceListChanged()
      return
    }

    if (msg.type === 'log') {
      const dev = devices.get(ws.deviceId)
      if (!dev) return
      dev.logs.push(msg.log)
      broadcast(ws.deviceId, { type: 'log', deviceId: ws.deviceId, log: msg.log })
      return
    }

    if (msg.type === 'exec-result') {
      const entry = pendingExecs.get(msg.execId)
      if (entry) {
        clearTimeout(entry.timeout)
        pendingExecs.delete(msg.execId)
        entry.resolve(msg.result)
      }
      return
    }
  },
  close: (ws) => {
    const dev = devices.get(ws.deviceId)
    if (dev && dev.ws === ws) devices.delete(ws.deviceId)
    notifyDeviceListChanged()
  },
})

app.ws('/ws/console', {
  compression: compressor,
  maxPayloadLength: 256 * 1024,
  idleTimeout: 120,
  upgrade: (res, req, context) => {
    /* uWS 要求原样回传握手头；第 5 参必须是 upgrade handler 的 context */
    res.upgrade(
      { subscriptions: new Set() },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context
    )
  },
  open: (ws) => {
    consoleSockets.add(ws)
    /** 控制台连上推当前列表（对齐 ws-relay L416） */
    ws.send(JSON.stringify({ type: 'device-list', devices: [...devices.values()].map((d) => d.info) }))
  },
  message: (ws, data) => {
    let msg
    try { msg = JSON.parse(Buffer.from(data).toString()) } catch { return }
    if (msg.type === 'subscribe') {
      let set = watchers.get(msg.deviceId)
      if (!set) { set = new Set(); watchers.set(msg.deviceId, set) }
      set.add(ws)
      ;(ws.subscriptions ??= new Set()).add(msg.deviceId)
    } else if (msg.type === 'unsubscribe') {
      const set = watchers.get(msg.deviceId)
      if (set) { set.delete(ws); if (!set.size) watchers.delete(msg.deviceId) }
      ws.subscriptions?.delete(msg.deviceId)
    }
  },
  close: (ws) => {
    for (const id of ws.subscriptions ?? []) {
      const set = watchers.get(id)
      if (set) { set.delete(ws); if (!set.size) watchers.delete(id) }
    }
    consoleSockets.delete(ws)
  },
})

/* ─── HTTP API（对齐 api.ts：health + exec + 静态资源） ─── */

/* 静态文件 serve：对齐真 server 的 packages/server/public（console UI + sdk.js） */
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

const PUB_ROOT = '/home/gs/opensource_code/clarosight/packages/server/public'
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
}

function serveFile(res, filePath) {
  /** uWS 硬约束：异步响应前必须挂 abort handler */
  res.onAborted(() => {})
  readFile(filePath)
    .then((data) => {
      res.writeHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream')
      res.end(data)
    })
    .catch(() => {
      res.writeStatus('404').writeHeader('Content-Type', 'text/plain')
      res.end('Not Found')
    })
}

app.get('/*', (res, req) => {
  const url = req.getUrl()
  if (url === '/' || url === '/index.html') return serveFile(res, join(PUB_ROOT, 'index.html'))
  const safe = url.replace(/\.\./g, '')
  serveFile(res, join(PUB_ROOT, safe.slice(1)))
})
app.get('/api/health', (res) => {
  res.writeHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({
    ok: true,
    rssMB: rssMB(),
    heapUsedMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
    eventLoopUtilPct: +eluPct().toFixed(1),
    fanoutSent: fanoutStats.sent,
    fanoutSkippedClosed: fanoutStats.skippedClosed,
    fanoutSkippedProject: fanoutStats.skippedProject,
    fanoutBackpressureClosed: fanoutStats.backpressureClosed,
    uptimeSec: Math.round(process.uptime()),
  }))
})

app.post('/api/devices/:id/exec', (res, req) => {
  const deviceId = req.getParameter(0)
  /** uWS 硬约束：异步响应前必须先挂 abort handler */
  let aborted = false
  res.onAborted(() => { aborted = true })

  readJsonBody(res).then((body) => {
    if (aborted) return
    const dev = devices.get(deviceId)
    if (!dev || !dev.ws) {
      res.writeStatus('404').writeHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: '设备不存在或离线' }))
      return
    }
    const execId = 'e-' + Math.random().toString(16).slice(2)
    dev.ws.send(JSON.stringify({ type: 'exec', execId, code: body?.code ?? '' }))
    new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingExecs.delete(execId)
        resolve({ success: false, error: 'exec 超时' })
      }, 10000)
      pendingExecs.set(execId, { timeout, resolve })
    }).then((result) => {
      if (aborted) {
        return
      }
      res.writeHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(result))
    })
  })
})

/** device-online 广播给所有控制台（场景1 observer 依赖 device-list 就够，这里补全语义） */
function broadcastAll(msg) {
  const text = JSON.stringify(msg)
  for (const ws of consoleSockets) safeSend(ws, text)
}

function readJsonBody(res) {
  return new Promise((resolve) => {
    let buf = ''
    res.onData((chunk, isLast) => {
      buf += Buffer.from(chunk).toString()
      if (isLast) { try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) } }
    })
  })
}

app.listen(PORT, (token) => {
  if (!token) { console.error('listen 失败'); process.exit(1) }
  console.log(`uWS PoC → http://localhost:${PORT}（compress=${COMPRESS_MODE}）`)
  console.log(`复刻语义：register/log(Ring500)/扇出/exec/health`)
})
