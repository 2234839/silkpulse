#!/usr/bin/env node
/**
 * silkpulse skill CLI —— AI agent 通过它操作远程设备
 *
 * 用法：
 *   node silkpulse.mjs devices                          列出在线设备
 *   node silkpulse.mjs snapshot <deviceId>              取设备页面快照（compact 文本）
 *   node silkpulse.mjs exec <deviceId> <code>           在设备页面执行 JS
 *   node silkpulse.mjs logs <deviceId> [N|since]        拉取设备 console 日志（N=最近N条）
 *   node silkpulse.mjs network <deviceId> [N|since]     拉取设备 network 记录（N=最近N条）
 *   node silkpulse.mjs errors <deviceId> [N|since]      拉取设备错误（N=最近N条，省 token）
 *   node silkpulse.mjs tag <deviceId> <tags> [note]     设置设备标签/备注
 *
 * 环境变量：
 *   SILKPULSE_SERVER  server 地址，默认 http://localhost:8080
 *   SILKPULSE_API_KEY  鉴权密钥（线上部署必带，作为 Authorization: Bearer 头）
 */

const SERVER = process.env.SILKPULSE_SERVER ?? 'http://localhost:8080'
/** 鉴权密钥：可选，鉴权部署时必带 */
const API_KEY = process.env.SILKPULSE_API_KEY ?? ''
/** 统一请求头（鉴权模式带 Bearer） */
const AUTH_HEADERS = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}

const [cmd, ...args] = process.argv.slice(2)

async function get(path) {
  const res = await fetch(`${SERVER}${path}`, { headers: AUTH_HEADERS })
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  return res
}

async function getJson(path) {
  return (await get(path)).json()
}

async function postJson(path, body) {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  return res.json()
}

/** 设备 id 支持前缀模糊匹配（取第一个匹配的设备） */
async function resolveDeviceId(idOrPrefix) {
  if (!idOrPrefix) {
    console.error('缺少设备 id 参数')
    process.exit(1)
  }
  /** 完整 id 直接返回 */
  const { devices } = await getJson('/api/devices')
  if (devices.some((d) => d.id === idOrPrefix)) return idOrPrefix
  /** 前缀匹配 */
  const matched = devices.filter((d) => d.id.startsWith(idOrPrefix))
  if (matched.length === 0) {
    console.error(`未找到设备: ${idOrPrefix}（在线设备: ${devices.map((d) => d.id).join(', ') || '无'}）`)
    process.exit(1)
  }
  if (matched.length > 1) {
    console.error(`设备 id 前缀 "${idOrPrefix}" 匹配到多个: ${matched.map((d) => d.id).join(', ')}`)
    process.exit(1)
  }
  return matched[0].id
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString()
}

/** 毫秒差 → 人类可读时长（"刚刚" / "3 分钟" / "1 小时" / "2 天"） */
function fmtDuration(ms) {
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

/**
 * 解析 logs/network 命令的范围参数
 *
 * 支持：
 *   <无>         → since=0, tail=undefined（全部）
 *   20           → since=0, tail=20（最近 20 条，AI 最常用）
 *   --tail=20    → 同上
 *   --since=100  → since=100, tail=undefined（游标增量拉取）
 *
 * tail 与 since 互斥：有 tail 时不关心 since（取全量后截断末尾 N 条）。
 */
function parseRangeArgs(rangeArgs) {
  let since = 0
  let tail
  for (const arg of rangeArgs) {
    if (arg.startsWith('--since=')) {
      since = Number(arg.slice(8)) || 0
    } else if (arg.startsWith('--tail=')) {
      tail = Number(arg.slice(7)) || undefined
    } else if (/^\d+$/.test(arg)) {
      /** 纯数字 → tail（最近 N 条，AI 最直觉的用法） */
      tail = Number(arg)
    }
  }
  return { since, tail }
}

/** 读取 stdin 全部内容（用于 exec 传入复杂多行代码） */
function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data.trim()))
  })
}

async function main() {
  switch (cmd) {
    case 'devices': {
      const { devices, recentlyOffline } = await getJson('/api/devices')
      if (devices.length === 0) {
        console.log('（暂无在线设备。接入方式：在目标页面注入 <script src="' + SERVER + '/sdk.js"></script>）')
        /** 无在线设备时，提示最近下线的设备 —— AI 据此区分"从未接入"和"接入过但掉了" */
        if (recentlyOffline.length > 0) {
          console.log('\n最近下线设备（接入过但已掉线，可能需等待重连）：')
          for (const o of recentlyOffline) {
            const mins = Math.round((Date.now() - o.offlineAt) / 60000)
            console.log(`  · [${o.id}] ${o.title}（${mins} 分钟前下线，${o.errorCount} 个错误）`)
            console.log(`        URL: ${o.url}`)
          }
        }
        return
      }
      /** 按错误数降序排序：有错误的设备优先展示，AI 能快速定位问题设备 */
      const sorted = [...devices].sort((a, b) => (b.errorCount ?? 0) - (a.errorCount ?? 0))
      const errorDevices = sorted.filter((d) => d.errorCount > 0)
      if (errorDevices.length > 0) {
        console.log(`⚠ ${errorDevices.length} 个设备有错误（已置顶）：\n`)
      } else {
        console.log(`在线设备 ${devices.length} 个：\n`)
      }
      for (const d of sorted) {
        const mark = d.errorCount > 0 ? '⚠' : ' '
        console.log(`  ${mark} [${d.id}]`)
        console.log(`       标题: ${d.title}`)
        console.log(`       URL:  ${d.url}`)
        /** 在线时长：判断问题性质的关键线索（刚接入就报错 vs 运行许久才报错） */
        const onlineDur = d.onlineAt ? ` · 在线 ${fmtDuration(Date.now() - d.onlineAt)}` : ''
        console.log(`       类型: ${d.deviceType ?? 'unknown'} · ${d.viewportWidth}×${d.viewportHeight}${onlineDur}`)
        console.log(`       UA:   ${d.userAgent.slice(0, 80)}`)
        if (d.tags?.length) console.log(`       标签: ${d.tags.join(', ')}`)
        if (d.note) console.log(`       备注: ${d.note}`)
        if (d.errorCount > 0) console.log(`       错误数: ${d.errorCount}`)
        console.log('')
      }
      break
    }

    case 'snapshot': {
      const id = await resolveDeviceId(args[0])
      const res = await get(`/api/devices/${id}/snapshot`)
      console.log(await res.text())
      break
    }

    case 'exec': {
      const id = await resolveDeviceId(args[0])
      /** code 优先来自命令行剩余参数；为空时读 stdin（支持复杂多行代码，避免 shell 转义） */
      let code = args.slice(1).join(' ')
      if (!code) {
        if (process.stdin.isTTY) {
          console.error('缺少要执行的 code（可在命令行传入，或通过管道：echo "..." | silkpulse exec <id>）')
          process.exit(1)
        }
        code = await readStdin()
      }
      if (!code) {
        console.error('缺少要执行的 code')
        process.exit(1)
      }
      const result = await postJson(`/api/devices/${id}/exec`, { code })
      if (!result.success) {
        console.error(`执行失败: ${result.error}`)
        process.exit(1)
      }
      console.log('=== 返回值 ===')
      console.log(result.result ?? 'undefined')
      if (result.logs?.length) {
        console.log('\n=== 执行期间日志 ===')
        for (const l of result.logs) console.log(l)
      }
      if (result.snapshotText) {
        console.log('\n=== 执行后页面快照（compact 文本）===')
        /** snapshotText 已是 server 转换好的 compact 文本，AI 直接读 */
        console.log(result.snapshotText)
      }
      break
    }

    case 'logs': {
      const id = await resolveDeviceId(args[0])
      /**
       * 第二参数解析：--since=N（游标分页）/ --tail=N 或正整数（只取最近 N 条）
       *
       * AI 诊断时最常用 --tail / 直接传 N："看最近 20 条日志"，因为 AI 不知道当前序号。
       * since 适合轮询场景（持续增量拉取）。
       */
      const { since, tail } = parseRangeArgs(args.slice(1))
      const logs = await getJson(`/api/devices/${id}/logs?since=${since}`)
      if (logs.length === 0) {
        console.log('（暂无日志）')
        return
      }
      /** tail 截断：只展示最近 N 条（已按时间正序，取末尾） */
      const display = tail ? logs.slice(-tail) : logs
      for (const l of display) {
        console.log(`[${fmtTime(l.timestamp)}] ${l.type.toUpperCase().padEnd(5)} ${l.message}`)
      }
      break
    }

    case 'network': {
      const id = await resolveDeviceId(args[0])
      const { since, tail } = parseRangeArgs(args.slice(1))
      const entries = await getJson(`/api/devices/${id}/network?since=${since}`)
      if (entries.length === 0) {
        console.log('（暂无网络请求）')
        return
      }
      const display = tail ? entries.slice(-tail) : entries
      for (const e of display) {
        /** WebSocket 连接条目：status 用 readyState 文字，展示帧摘要 + 最近帧 */
        if (e.protocol === 'ws') {
          const stateName = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][e.wsState] || String(e.status)
          const frames = e.frames || []
          const sendN = frames.filter((f) => f.dir === 'send').length
          const recvN = frames.filter((f) => f.dir === 'recv').length
          console.log(`[${fmtTime(e.timestamp)}] ${e.method.padEnd(6)} ${stateName.padEnd(12)} —          ${e.url}`)
          console.log(`          帧: ↑${sendN} send  ↓${recvN} recv  (${frames.length} 帧)`)
          /** 最近 5 帧（时间线，AI 诊断 WS 通信内容） */
          for (const f of frames.slice(-5)) {
            const arrow = f.dir === 'send' ? '↑ send' : f.dir === 'recv' ? '↓ recv' : `⚠ ${f.data}`
            const body = f.dir === 'event' ? '' : ` ${f.data}`
            console.log(`          ${fmtTime(f.timestamp)} ${arrow}${body}`)
          }
          continue
        }
        const status = e.status || '—'
        console.log(`[${fmtTime(e.timestamp)}] ${e.method.padEnd(6)} ${String(status).padEnd(4)} ${e.duration}ms  ${e.url}`)
        if (e.error) console.log(`          ⚠ ${e.error}`)
        /** 关键请求头（鉴权/cookie/content-type 等，诊断与复现所需） */
        if (e.reqHeaders) {
          const pairs = Object.entries(e.reqHeaders).map(([k, v]) => `${k}: ${v}`)
          console.log(`          请求头: ${pairs.join(' | ')}`)
        }
        /** 关键响应头 */
        if (e.resHeaders) {
          const pairs = Object.entries(e.resHeaders).map(([k, v]) => `${k}: ${v}`)
          console.log(`          响应头: ${pairs.join(' | ')}`)
        }
        if (e.reqBody) console.log(`          请求体: ${e.reqBody}`)
        if (e.resBody) console.log(`          响应体: ${e.resBody}`)
      }
      break
    }

    case 'errors': {
      const id = await resolveDeviceId(args[0])
      /**
       * 第二参数解析：--since=N / --tail=N 或正整数（只取最近 N 条）
       *
       * AI 诊断时最常用 'errors <id> 5' 看最近几个错误（每条带完整 stack 很耗 token，
       * 全量 50 条 stack 会刷爆 AI 上下文）。对齐 logs/network 的范围参数语义。
       */
      const { since, tail } = parseRangeArgs(args.slice(1))
      const errors = await getJson(`/api/devices/${id}/errors?since=${since}`)
      if (errors.length === 0) {
        console.log('（暂无错误）')
        return
      }
      /** tail 截断：只展示最近 N 条（已按时间正序，取末尾） */
      const display = tail ? errors.slice(-tail) : errors
      for (const e of display) {
        console.log(`[${fmtTime(e.timestamp)}] ${e.message}`)
        /** source map 解析成功时优先展示原始位置（AI 诊断的关键信息） */
        if (e.mapped) {
          console.log(`  ↳ 原始源码: ${e.mapped.source}:${e.mapped.line}:${e.mapped.column}${e.mapped.name ? ` (${e.mapped.name})` : ''}`)
        } else if (e.source) {
          console.log(`  ↳ 压缩位置: ${e.source}:${e.line}:${e.col}（无 source map）`)
        }
        if (e.stack) console.log(e.stack)
        console.log('')
      }
      break
    }

    case 'inspect': {
      /**
       * inspect <id> —— 一键诊断聚合：设备信息 + 错误 + 失败网络 + 快照
       *
       * AI 诊断时最常用的组合查询，一次拿到完整现场，省得分 3-4 次调用。
       * 与控制台"AI 诊断上下文"按钮对齐，输出 token 友好的结构化文本。
       */
      const id = await resolveDeviceId(args[0])
      const [devicesResp, errors, network, logs, snapshotRes] = await Promise.all([
        getJson('/api/devices'),
        getJson(`/api/devices/${id}/errors`),
        getJson(`/api/devices/${id}/network`),
        getJson(`/api/devices/${id}/logs`),
        get(`/api/devices/${id}/snapshot`),
      ])
      const device = devicesResp.devices.find((d) => d.id === id)
      const snapshot = await snapshotRes.text()

      console.log('# silkpulse 设备诊断聚合')
      console.log('')
      console.log(`- 页面: ${device?.title ?? id}`)
      console.log(`- URL: ${device?.url ?? '未知'}`)
      console.log(`- 类型: ${device?.deviceType ?? 'unknown'} · ${device?.viewportWidth}×${device?.viewportHeight}`)
      if (device?.tags?.length) console.log(`- 标签: ${device.tags.join(', ')}`)
      console.log('')

      console.log(`## 错误 (${errors.length})`)
      if (errors.length === 0) {
        console.log('（无）')
      } else {
        for (const e of errors.slice(-10)) {
          console.log(`- ${e.message}`)
          if (e.mapped) {
            console.log(`  原始源码: ${e.mapped.source}:${e.mapped.line}:${e.mapped.column}${e.mapped.name ? ` (${e.mapped.name})` : ''}`)
          } else if (e.source) {
            console.log(`  位置: ${e.source}:${e.line}:${e.col}`)
          }
          if (e.stack) console.log('  ```', ...e.stack.split('\n').slice(0, 4).map((l) => `\n  ${l}`), '\n  ```')
        }
      }
      console.log('')

      /**
       * 异常网络请求：排除 WS 条目（WS 的 status 是 readyState 0-3，与 HTTP 状态码语义不同，
       * status=0(CONNECTING) 会被误判为失败）。WS 单独一段展示。
       */
      const httpNet = network.filter((n) => n.protocol !== 'ws')
      const failed = httpNet.filter((n) => n.status >= 400 || n.status === 0)
      console.log(`## 异常网络请求 (${failed.length})`)
      if (failed.length === 0) {
        console.log('（无）')
      } else {
        for (const n of failed.slice(-10)) {
          console.log(`- ${n.method} ${n.status} ${n.url} (${n.duration}ms)`)
          if (n.error) console.log(`  ⚠ ${n.error}`)
          /** 失败请求的响应体通常含错误原因（如 {"error":"permission denied"}），诊断失败请求的关键 */
          if (n.resBody) console.log(`  响应体: ${n.resBody}`)
        }
      }
      console.log('')

      /**
       * 慢请求 Top 5 —— 按耗时降序，>500ms 标记 ⚠
       *
       * 诊断"页面慢/卡"时，失败的请求（上面那段）往往不是根因——
       * 真正的瓶颈是那些 status 200 但耗时 2-3s 的慢请求。
       * duration 数据 SDK 已采集，这里给 AI 排好序直接用，省得 AI 自己算。
       */
      const SLOW_THRESHOLD = 500
      const byDuration = [...httpNet].sort((a, b) => b.duration - a.duration)
      const slowTop = byDuration.slice(0, 5).filter((n) => n.duration > 0)
      console.log(`## 慢请求 Top ${slowTop.length}（> ${SLOW_THRESHOLD}ms 标记 ⚠）`)
      if (slowTop.length === 0) {
        console.log('（无网络请求）')
      } else {
        for (const n of slowTop) {
          const mark = n.duration > SLOW_THRESHOLD ? ' ⚠' : ''
          console.log(`- ${n.duration}ms${mark} ${n.method} ${n.status} ${n.url}`)
        }
      }
      console.log('')

      /**
       * WebSocket 连接 —— 实时推送/IM/游戏类应用的核心通信通道。
       * AI 诊断这类应用时需看到 WS 连接状态 + 帧摘要（收发是否正常）。
       */
      const wsConns = network.filter((n) => n.protocol === 'ws')
      console.log(`## WebSocket 连接 (${wsConns.length})`)
      if (wsConns.length === 0) {
        console.log('（无）')
      } else {
        const stateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']
        for (const w of wsConns.slice(-10)) {
          const state = stateNames[w.wsState] ?? '?'
          const frames = w.frames || []
          const sendN = frames.filter((f) => f.dir === 'send').length
          const recvN = frames.filter((f) => f.dir === 'recv').length
          console.log(`- ${w.method} [${state}] ${w.url}（↑${sendN} ↓${recvN}）`)
          /** error 事件帧（连接异常的关键信号） */
          const errFrame = frames.find((f) => f.dir === 'event' && f.data === 'error')
          if (errFrame) console.log(`  ⚠ 连接 error 事件`)
        }
      }
      console.log('')

      /**
       * 最近日志（最多 20 条，与控制台 AI 诊断上下文对齐）
       *
       * console 日志常含关键诊断线索（业务状态打印、warn 警告、error 细节）。
       * error/warn 优先展示（从末尾取 20 条中按级别排序），info/debug 在后。
       */
      const recentLogs = logs.slice(-20)
      /** warn/error 排前面（诊断价值最高），其余按原序 */
      const sortedLogs = [...recentLogs].sort((a, b) => {
        const rank = (t) => (t === 'error' ? 0 : t === 'warn' ? 1 : 2)
        return rank(a.type) - rank(b.type)
      })
      console.log(`## 最近日志 (${logs.length}${logs.length > 20 ? '，显示最近 20' : ''})`)
      if (sortedLogs.length === 0) {
        console.log('（无）')
      } else {
        for (const l of sortedLogs) {
          console.log(`- [${l.type}] ${l.message}`)
        }
      }
      console.log('')

      console.log('## 页面快照')
      console.log('```')
      console.log(snapshot)
      console.log('```')
      console.log('')
      console.log('---')
      console.log(`提示：可在该设备执行诊断代码，例如：`)
      console.log(`  silkpulse exec ${id.slice(0, 8)} --code "return __silkpulse_snapshot()"`)
      break
    }

    case 'tag':
    case 'tags': {
      /** tag <id> <comma-separated-tags> [note...] —— AI/人工为设备打标签区分身份 */
      const id = await resolveDeviceId(args[0])
      const tagsArg = args[1] ?? ''
      const noteArg = args.slice(2).join(' ') || undefined
      if (!tagsArg && !noteArg) {
        /** 不带值时仅展示当前标签 */
        const device = await getJson(`/api/devices/${id}`)
        console.log(`标签: ${(device.tags ?? []).join(', ') || '（无）'}`)
        if (device.note) console.log(`备注: ${device.note}`)
        return
      }
      const tags = tagsArg.split(',').map((t) => t.trim()).filter(Boolean)
      const result = await postJson(`/api/devices/${id}/tags`, { tags, note: noteArg })
      console.log(`✓ 已更新 [${id}] 标签：${(result.device.tags ?? []).join(', ') || '（无）'}${result.device.note ? '，备注：' + result.device.note : ''}`)
      break
    }

    case 'inject': {
      const form = args[0] ?? 'snippet'
      if (form === 'bookmarklet') {
        const res = await get('/inject/bookmarklet')
        console.log('将下面这一行拖到浏览器书签栏，在任意页面点击即接入：\n')
        console.log(await res.text())
      } else if (form === 'userscript') {
        const res = await get('/inject/userscript')
        console.log('将下面内容保存为 .user.js 文件，或直接安装到 Tampermonkey：\n')
        console.log(await res.text())
      } else {
        console.log('SDK 注入方式：')
        console.log('')
        console.log('1) script 标签（最常用）：')
        console.log(`   <script src="${SERVER}/sdk.js" data-server="${SERVER}"></script>`)
        console.log('')
        console.log('2) bookmarklet：silkpulse inject bookmarklet')
        console.log('3) userscript： silkpulse inject userscript')
      }
      break
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined: {
      console.log(`silkpulse skill —— AI 远程设备调试工具

用法：
  silkpulse devices                       列出在线设备
  silkpulse snapshot <id>                 取设备页面快照（AI 友好的 compact 文本）
  silkpulse exec <id> <code>              在设备页面执行 JS（支持 return）
  silkpulse logs <id> [N|--tail=N|--since=N]   拉取日志（N=最近N条，--since=游标增量）
  silkpulse network <id> [N|--tail=N|--since=N] 拉取网络记录（同上）
  silkpulse errors <id> [N|--tail=N|--since=N] 拉取设备错误（N=最近N条，省 token）
  silkpulse inspect <id>                  一键诊断聚合（错误+失败网络+快照，AI 最常用）
  silkpulse tag <id> <tags> [note]        设置设备标签/备注（多设备区分用）
  silkpulse inject [bookmarklet|userscript]  生成接入片段

exec 的 code 也可通过 stdin 传入（适合复杂多行代码）：
  echo "return document.title" | silkpulse exec <id>

设备 id 支持前缀模糊匹配。code 作为 async 函数体执行，可写多条语句，用 return 返回值。
exec code 中可直接用的辅助函数：
  __silkpulse_click(idx)           点击 snapshot 中的元素
  __silkpulse_setValue(idx, val)   设置表单值（input/textarea/select，触发 input+change）
  __silkpulse_type(idx, text)      模拟键盘逐字输入（触发 keydown/keyup 序列）
  __silkpulse_scroll(idx, x, y)    滚动元素（idx<0 时滚窗口），触发懒加载
  __silkpulse_scrollIntoView(idx)  滚动元素到可视区域
  __silkpulse_hover(idx)           鼠标悬停（触发 mouseover/mouseenter）
  __silkpulse_pressKey(idx,key,mods?) 按键（Enter/Escape/方向键，派发 keydown+keyup）
  __silkpulse_wait(ms)             异步等待
  __silkpulse_snapshot()           手动取快照
  __silkpulse_sourcemap(line,col,srcUrl?)  解析 source map（压缩位置→原始源码位置）
  __silkpulse_sourcemapStack(frames)       批量解析堆栈帧

环境变量：
  SILKPULSE_SERVER  server 地址，默认 http://localhost:8080`)
      break
    }

    default:
      console.error(`未知命令: ${cmd}（用 --help 查看用法）`)
      process.exit(1)
  }
}

main()
