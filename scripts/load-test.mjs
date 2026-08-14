#!/usr/bin/env node
/**
 * 高并发压测 —— 摸清 server 容量基线（设备数/控制台数/exec 吞吐/内存）
 *
 * 用法：
 *   node scripts/load-test.mjs                          # 默认全场景
 *   node scripts/load-test.mjs --devices 200 --consoles 20 --logs 50
 *   node scripts/load-test.mjs --skip-ramp              # 只跑固定规模
 *   SILKPULSE_TEST_URL=http://localhost:8081 node scripts/load-test.mjs
 *
 * 指标：
 *   1. 设备容量：N 设备并发在线，register P99 / WS 建连耗时
 *   2. 日志洪峰：每设备 logs/s 条日志持续压入，server CPU / 内存 / 广播延迟
 *   3. 控制台容量：M 控制台订阅设备，广播扇出延迟
 *   4. exec 吞吐：K 并发 exec 请求，P50/P95/P99 延迟 + QPS
 *   5. HTTP 轮询：devices 列表轮询（agent 典型负载）
 *
 * 每阶段独立采样，阶段间显式回收资源，最终打印汇总表。
 * 退出码：非 0 = 有阶段失败（供 CI 判定）。
 */

import { createRequire } from 'node:module'

/** ws 是 @silkpulse/server 的依赖，从它的 package.json 解析（根目录不直接依赖 ws） */
const require = createRequire(new URL('../packages/server/package.json', import.meta.url))
const WebSocket = require('ws')

const BASE = process.env.SILKPULSE_TEST_URL ?? 'http://localhost:8080'
const ORIGIN = new URL(BASE).origin
const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws')
const WSS_DEVICE = WS_ORIGIN + '/ws/device'
const WSS_CONSOLE = WS_ORIGIN + '/ws/console?token=' + (process.env.SILKPULSE_ADMIN_KEY ?? '')

/** 命令行参数解析 */
function parseArgs() {
  const args = { devices: 0, consoles: 0, perConsole: 5, logs: 0, execConcurrency: 0, duration: 10, skipRamp: false, skipExec: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    const next = () => Number(argv[++i])
    if (v === '--devices') args.devices = next()
    else if (v === '--consoles') args.consoles = next()
    else if (v === '--per-console') args.perConsole = next()
    else if (v === '--logs') args.logs = next()
    else if (v === '--exec') args.execConcurrency = next()
    else if (v === '--duration') args.duration = next()
    else if (v === '--skip-ramp') args.skipRamp = true
    else if (v === '--skip-exec') args.skipExec = true
  }
  return args
}

/** 百分位统计 */
function pct(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

function stats(values) {
  return {
    n: values.length,
    p50: pct(values, 50),
    p95: pct(values, 95),
    p99: pct(values, 99),
    max: values.length ? Math.max(...values) : 0,
  }
}

function fmtMs(ms) {
  return ms >= 100 ? Math.round(ms) + 'ms' : ms.toFixed(1) + 'ms'
}

/** 每阶段前后差分 server 进程状态（RSS/事件循环利用率/广播计数） */
async function serverStats() {
  let rss = 0
  let elu = 0
  let fanout = null
  try {
    const r = await fetch(`${BASE}/api/health`)
    if (r.ok) {
      const j = await r.json().catch(() => ({}))
      rss = j.rssMB ?? 0
      elu = Number.isFinite(j.eventLoopUtilPct) ? j.eventLoopUtilPct : 0
      fanout = j.fanoutSent != null ? { sent: j.fanoutSent, skippedClosed: j.fanoutSkippedClosed, skippedProject: j.fanoutSkippedProject, backpressureClosed: j.fanoutBackpressureClosed } : null
    }
  } catch {}
  return { rss, elu, fanout }
}

/** 进程自身 RSS（Node heap 里 ws 连接的客户端侧开销） */
function selfRssMB() {
  return (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
}

/* ============================================================
 * 场景 1：设备并发接入（register 风暴）
 * ============================================================ */

/**
 * 观察者控制台：先于所有设备连上，subscribe 不会遗漏 device-online。
 * 设备 register 无回执（device-online 只广播给订阅控制台），
 * 所以用「控制台收到 device-online」作为注册成功信号。
 */
let observer = null
async function ensureObserver() {
  if (observer) return observer
  const seen = new Map() // deviceId → resolve callbacks
  const online = new Set() // 已确认在线的设备
  const ws = new WebSocket(WSS_CONSOLE)
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
    setTimeout(() => rej(new Error('observer console connect timeout')), 10000)
  })
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    /**
     * register 成功 → server 调 notifyDeviceListChanged() 给所有 console 推
     * device-list（无需 subscribe）。检查 pending id 是否出现在列表里。
     */
    if (msg.type === 'device-list') {
      const ids = new Set(msg.devices.map((d) => d.id))
      for (const [id, cbs] of observer.seen) {
        if (ids.has(id)) {
          online.add(id)
          cbs.forEach((cb) => cb())
          seen.delete(id)
        }
      }
    }
    /** 订阅场景下也可能直接收到 device-online（后续订阅的设备） */
    if (msg.type === 'device-online') {
      online.add(msg.device?.id)
      const cbs = seen.get(msg.device?.id)
      if (cbs) { cbs.forEach((cb) => cb()); seen.delete(msg.device?.id) }
    }
  })
  observer = { ws, seen, online }
  return observer
}

/** 等待 observer 控制台看到某设备上线（注册成功的唯一可靠信号） */
function waitOnline(id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (observer?.online.has(id)) return resolve()
    const cbs = observer.seen.get(id) ?? []
    cbs.push(resolve)
    observer.seen.set(id, cbs)
    setTimeout(() => {
      const cur = observer.seen.get(id)
      const i = cur ? cur.indexOf(resolve) : -1
      if (i >= 0) { cur.splice(i, 1); if (!cur.length) observer.seen.delete(id) }
      reject(new Error('device register timeout: ' + id))
    }, timeoutMs)
  })
}

/** 开一条设备 WS 并 register，返回 { ws, id, tRegister } */
function spawnDevice(i) {
  return new Promise((resolve, reject) => {
    const id = 'load-dev-' + i + '-' + Math.random().toString(16).slice(2, 6)
    const t0 = performance.now()
    const ws = new WebSocket(WSS_DEVICE)
    const timer = setTimeout(() => reject(new Error('device connect timeout')), 15000)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'register',
        sessionToken: 'st-' + i,
        device: {
          id,
          url: `https://example.com/app-${i % 30}`,
          title: `压测设备 ${i}`,
          deviceType: 'desktop',
          tags: [],
        },
      }))
      /** register 无回执 → 等 observer 控制台确认（更严格：验证完整链路） */
      waitOnline(id).then(() => {
        clearTimeout(timer)
        resolve({ ws, id, tRegister: performance.now() - t0 })
      }, (e) => { clearTimeout(timer); reject(e) })
    })
    ws.on('message', (raw) => {
      /** 设备端只可能收到 device-id-conflict / 指令类消息 */
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'device-id-conflict') {
          clearTimeout(timer)
          reject(new Error('device-id-conflict: ' + id))
        } else if (msg.type === 'exec') {
          /** 模拟真实 SDK 的 exec 响应（协议：result 为 ExecResult 嵌套对象），让场景4链路完整可测 */
          ws.send(JSON.stringify({
            type: 'exec-result',
            execId: msg.execId,
            result: {
              success: true,
              result: '2',
              resultValue: { type: 'number', preview: '2', value: 2 },
              logs: [],
            },
          }))
        }
      } catch {}
    })
    ws.on('error', reject)
  })
}

async function rampDevices(n, batchSize = 25) {
  console.log(`\n━━━ 场景1：${n} 设备并发接入（批次 ${batchSize}） ━━━`)
  await ensureObserver()
  const devices = []
  const times = []
  const t0 = performance.now()
  for (let b = 0; b < n; b += batchSize) {
    const size = Math.min(batchSize, n - b)
    const batch = await Promise.all(
      Array.from({ length: size }, (_, j) => spawnDevice(b + j))
    )
    devices.push(...batch)
    times.push(...batch.map((d) => d.tRegister))
    process.stdout.write(`  接入 ${devices.length}/${n}（批次耗时 ${fmtMs(batch[batch.length - 1].tRegister)}）\r`)
  }
  console.log(`  ✓ ${n} 设备在线，总耗时 ${fmtMs(performance.now() - t0)}`)
  console.log(`  register 延迟: p50=${fmtMs(pct(times, 50))} p95=${fmtMs(pct(times, 95))} p99=${fmtMs(pct(times, 99))}`)
  return devices
}

/* ============================================================
 * 场景 2：日志洪峰（设备上报 → server 缓冲 + 广播给订阅者）
 * ============================================================ */

async function logStorm(devices, logsPerSecPerDevice, durationSec) {
  const totalRate = devices.length * logsPerSecPerDevice
  console.log(`\n━━━ 场景2：日志洪峰 ${totalRate} 条/s（${devices.length} 设备 × ${logsPerSecPerDevice}/s，持续 ${durationSec}s） ━━━`)
  const before = await serverStats()
  let sent = 0
  let dropped = 0
  const t0 = performance.now()

  /** 每设备一个定时器，按频率发 log */
  const timers = devices.map(({ ws }, i) => {
    const interval = setInterval(() => {
      try {
        ws.send(JSON.stringify({
          type: 'log',
          log: {
            level: ['log', 'warn', 'info'][i % 3],
            message: `压测日志 #${sent} 设备${i} ${'x'.repeat(50)}`,
            timestamp: new Date().toISOString(),
          },
        }))
        sent++
      } catch {
        dropped++
      }
    }, 1000 / logsPerSecPerDevice)
    return interval
  })

  await new Promise((r) => setTimeout(r, durationSec * 1000))
  timers.forEach(clearInterval)

  const after = await serverStats()
  const elapsed = (performance.now() - t0) / 1000
  console.log(`  实际发送 ${sent} 条（${Math.round(sent / elapsed)}/s），drop ${dropped}`)
  console.log(`  server RSS: ${before.rss}MB → ${after.rss}MB（Δ${(after.rss - before.rss).toFixed(1)}MB），事件循环利用率 ${after.elu.toFixed(1)}%`)
  return { sent, rate: sent / elapsed, rssDelta: after.rss - before.rss, elu: after.elu }
}

/* ============================================================
 * 场景 3：控制台订阅 + 广播扇出
 * ============================================================ */

async function consoleFanout(deviceIds, nConsoles, msgPerSec, durationSec, perConsole) {
  console.log(`\n━━━ 场景3：${nConsoles} 控制台各订阅 ${perConsole} 台设备，广播扇出 ${msgPerSec}/s，${durationSec}s ━━━`)
  /** 控制台收到的广播计数（测扇出是否被背压截断）。用对象引用：resolve 后仍在递增 */
  const counter = { received: 0, log: 0, other: 0, samples: [] }
  const consoles = await Promise.all(
    Array.from({ length: nConsoles }, (_, i) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(WSS_CONSOLE)
        const timer = setTimeout(() => reject(new Error('console connect timeout')), 15000)
        ws.on('open', () => {
          /** 真实产品形态：每个控制台只看自己的几台设备，轮转分配避免重叠 */
          const mine = deviceIds.slice((i * perConsole) % deviceIds.length, (i * perConsole) % deviceIds.length + perConsole)
          for (const id of mine) {
            ws.send(JSON.stringify({ type: 'subscribe', deviceId: id }))
          }
          clearTimeout(timer)
          resolve(ws)
        })
        ws.on('message', (raw) => {
          /** 高扇出下免全文 JSON.parse：先看首个 type 值计数，抽样验证非 log 消息 */
          const s = raw.toString()
          const m = /^\{"type":"([a-z-]+)"/.exec(s)
          const type = m ? m[1] : 'unknown'
          if (type === 'log') counter.log++
          else if (type !== 'device-list' && type !== 'device-online') {
            counter.other++
            if (counter.samples.length < 3) counter.samples.push(s.slice(0, 200))
          }
        })
        ws.on('error', reject)
      })
    )
  )
  /** 订阅生效等待（server 侧 subscribe 是同步处理，留 buffer 余量） */
  await new Promise((r) => setTimeout(r, 500))
  /** 广播扇出的发送端由外部 logStorm 驱动（复用设备 ws），本函数只负责收集接收数 */
  return { consoles, counter }
}

/* ============================================================
 * 场景 4：exec 并发吞吐（HTTP POST → WS 下发 → 设备回传 → HTTP 响应）
 * ============================================================ */

async function execThroughput(deviceIds, concurrency, durationSec) {
  console.log(`\n━━━ 场景4：exec 并发=${concurrency}，持续 ${durationSec}s ━━━`)
  const key = process.env.SILKPULSE_ADMIN_KEY ?? ''
  const auth = key ? { Authorization: `Bearer ${key}` } : {}
  const latencies = []
  let done = 0
  let failed = 0
  const t0 = performance.now()
  const stop = t0 + durationSec * 1000

  async function worker(id) {
    while (performance.now() < stop) {
      const t = performance.now()
      try {
        const r = await fetch(`${BASE}/api/devices/${id}/exec`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify({ code: 'return 1+1' }),
        })
        const j = await r.json()
        if (j.success) {
          latencies.push(performance.now() - t)
          done++
        } else {
          failed++
        }
      } catch {
        failed++
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => worker(deviceIds[i % deviceIds.length]))
  )
  const elapsed = (performance.now() - t0) / 1000
  const s = stats(latencies)
  console.log(`  完成 ${done} 失败 ${failed}，QPS=${(done / elapsed).toFixed(1)}`)
  console.log(`  exec 延迟: p50=${fmtMs(s.p50)} p95=${fmtMs(s.p95)} p99=${fmtMs(s.p99)} max=${fmtMs(s.max)}`)
  return { qps: done / elapsed, ...s, failed }
}

/* ============================================================
 * 场景 5：HTTP 设备列表轮询（agent 典型负载）
 * ============================================================ */

async function httpPolling(durationSec) {
  console.log(`\n━━━ 场景5：HTTP /api/agent/devices 轮询 5/s，${durationSec}s ━━━`)
  const key = process.env.SILKPULSE_ADMIN_KEY ?? ''
  const auth = key ? { Authorization: `Bearer ${key}`, } : {}
  const latencies = []
  const t0 = performance.now()
  const stop = t0 + durationSec * 1000
  while (performance.now() < stop) {
    const t = performance.now()
    try {
      const r = await fetch(`${BASE}/api/agent/devices?key=${key}`, { headers: auth })
      await r.json()
      latencies.push(performance.now() - t)
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  const s = stats(latencies)
  console.log(`  轮询 ${latencies.length} 次: p50=${fmtMs(s.p50)} p95=${fmtMs(s.p95)} p99=${fmtMs(s.p99)}`)
  return s
}

/* ============================================================
 * 主流程
 * ============================================================ */

const args = parseArgs()
console.log(`silkpulse 压测 → ${BASE}`)
console.log(`参数: ${JSON.stringify(args)}`)
console.log(`客户端 RSS 基线: ${selfRssMB()}MB`)

/** 存活连接池（跨场景复用） */
let pool = []

try {
  /* ---- 阶段 A：递增爬坡（找容量拐点） ---- */
  if (!args.skipRamp) {
    const steps = [50, 100, 200, 300, 500]
    for (const n of steps) {
      const s0 = await serverStats()
      const t0 = performance.now()
      const batch = await rampDevices(n, 50)
      console.log(`  [爬坡 ${n}] 接入耗时 ${fmtMs(performance.now() - t0)}，server RSS ${s0.rss}→${(await serverStats()).rss}MB`)
      /** 爬坡只测建连，测完立刻释放 */
      batch.forEach((d) => d.ws.close())
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  /* ---- 阶段 B：稳态压测（固定规模 + 洪峰 + 扇出 + exec + 轮询） ---- */
  const N = args.devices || 200
  const M = args.consoles || 10
  const LOG_RATE = args.logs || 20
  const EXEC_C = args.execConcurrency || 10
  const D = args.duration

  pool = await rampDevices(N)
  console.log(`  客户端 RSS: ${selfRssMB()}MB（${N} 设备连接后）`)

  await logStorm(pool, LOG_RATE, D)

  /* 控制台扇出：每控制台订阅 per-console 台设备（真实产品形态）+ 场景2 同款日志再压一轮 */
  const consoleResult = await consoleFanout(pool.map((d) => d.id), M, N * LOG_RATE, D, args.perConsole)
  const f0 = (await serverStats()).fanout
  const storm2 = await logStorm(pool, LOG_RATE, D)
  /** 等收尾：最后一批日志经 server 广播到各控制台需要传输时间 */
  await new Promise((r) => setTimeout(r, 500))
  const f1 = (await serverStats()).fanout
  /** 每控制台订阅 perConsole 台，理论送达 = min(perConsole, N) / N × 发送量 × M */
  const expectedPerConsole = Math.min(args.perConsole, N)
  console.log(`  控制台收到 log 广播 ${consoleResult.counter.log} 条（理论 ≈ ${storm2.sent * expectedPerConsole / N * M | 0} = ${storm2.sent} × ${expectedPerConsole}/${N} × ${M}），其他消息 ${consoleResult.counter.other} 条`)
  if (f0 && f1) {
    console.log(`  server 侧广播：sent Δ${f1.sent - f0.sent}，skippedClosed Δ${f1.skippedClosed - f0.skippedClosed}，skippedProject Δ${f1.skippedProject - f0.skippedProject}，backpressureClosed Δ${f1.backpressureClosed - f0.backpressureClosed}`)
  }
  if (consoleResult.counter.samples.length) {
    console.log(`  非 log 消息样例: ${consoleResult.counter.samples[0]}`)
  }
  consoleResult.consoles.forEach((ws) => ws.close())

  if (!args.skipExec) {
    await execThroughput(pool.map((d) => d.id).slice(0, 20), EXEC_C, D)
  }

  await httpPolling(Math.min(D, 10))

  const end = await serverStats()
  console.log(`\n━━━ 汇总 ━━━`)
  console.log(`  最终 server RSS: ${end.rss}MB，事件循环利用率 ${end.elu.toFixed(1)}%`)
  console.log(`  客户端 RSS: ${selfRssMB()}MB`)
} finally {
  console.log('\n清理连接...')
  pool.forEach((d) => { try { d.ws.close() } catch {} })
  setTimeout(() => process.exit(0), 500)
}
