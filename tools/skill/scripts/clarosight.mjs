#!/usr/bin/env node
/**
 * clarosight skill CLI —— AI agent 通过它操作远程设备
 *
 * 用法：
 *   node clarosight.mjs devices                          列出在线设备
 *   node clarosight.mjs snapshot <deviceId>              取设备页面快照（compact 文本）
 *   node clarosight.mjs exec <deviceId> <code>           在设备页面执行 JS
 *   node clarosight.mjs logs <deviceId> [since]          拉取设备 console 日志
 *   node clarosight.mjs network <deviceId> [since]       拉取设备 network 记录
 *   node clarosight.mjs errors <deviceId>                拉取设备错误
 *
 * 环境变量：
 *   CLAROSIGHT_SERVER  server 地址，默认 http://localhost:8080
 */

const SERVER = process.env.CLAROSIGHT_SERVER ?? 'http://localhost:8080'

const [cmd, ...args] = process.argv.slice(2)

async function get(path) {
  const res = await fetch(`${SERVER}${path}`)
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
    headers: { 'Content-Type': 'application/json' },
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
  const devices = await getJson('/api/devices')
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

async function main() {
  switch (cmd) {
    case 'devices': {
      const devices = await getJson('/api/devices')
      if (devices.length === 0) {
        console.log('（暂无在线设备。接入方式：在目标页面注入 <script src="' + SERVER + '/sdk.js"></script>）')
        return
      }
      console.log(`在线设备 ${devices.length} 个：\n`)
      for (const d of devices) {
        console.log(`  [${d.id}]`)
        console.log(`    标题: ${d.title}`)
        console.log(`    URL:  ${d.url}`)
        console.log(`    视口: ${d.viewportWidth}×${d.viewportHeight}`)
        console.log(`    UA:   ${d.userAgent.slice(0, 80)}`)
        if (d.errorCount > 0) console.log(`    ⚠ 错误数: ${d.errorCount}`)
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
      const code = args.slice(1).join(' ')
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
        console.log('\n=== 执行后页面快照 ===')
        try {
          const snap = JSON.parse(result.snapshotText)
          console.log(`url: ${snap.url} | 标题: ${snap.title} | 元素: ${snap.els.length}`)
        } catch {
          console.log(result.snapshotText.slice(0, 200))
        }
      }
      break
    }

    case 'logs': {
      const id = await resolveDeviceId(args[0])
      const since = args[1] ? Number(args[1]) : 0
      const logs = await getJson(`/api/devices/${id}/logs?since=${since}`)
      if (logs.length === 0) {
        console.log('（暂无日志）')
        return
      }
      for (const l of logs) {
        console.log(`[${fmtTime(l.timestamp)}] ${l.type.toUpperCase().padEnd(5)} ${l.message}`)
      }
      break
    }

    case 'network': {
      const id = await resolveDeviceId(args[0])
      const since = args[1] ? Number(args[1]) : 0
      const entries = await getJson(`/api/devices/${id}/network?since=${since}`)
      if (entries.length === 0) {
        console.log('（暂无网络请求）')
        return
      }
      for (const e of entries) {
        const status = e.status || '—'
        console.log(`[${fmtTime(e.timestamp)}] ${e.method.padEnd(6)} ${String(status).padEnd(4)} ${e.duration}ms  ${e.url}`)
        if (e.error) console.log(`          ⚠ ${e.error}`)
      }
      break
    }

    case 'errors': {
      const id = await resolveDeviceId(args[0])
      const errors = await getJson(`/api/devices/${id}/errors`)
      if (errors.length === 0) {
        console.log('（暂无错误）')
        return
      }
      for (const e of errors) {
        console.log(`[${fmtTime(e.timestamp)}] ${e.message}`)
        if (e.stack) console.log(e.stack)
        console.log('')
      }
      break
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined: {
      console.log(`clarosight skill —— AI 远程设备调试工具

用法：
  clarosight devices                       列出在线设备
  clarosight snapshot <id>                 取设备页面快照（AI 友好的 compact 文本）
  clarosight exec <id> <code>              在设备页面执行 JS（支持 return）
  clarosight logs <id> [since]             拉取设备 console 日志
  clarosight network <id> [since]          拉取设备 network 记录
  clarosight errors <id>                   拉取设备错误

设备 id 支持前缀模糊匹配。code 作为 async 函数体执行，可写多条语句，用 return 返回值。
exec code 中可直接用的辅助函数：
  __clarosight_click(idx)           点击 snapshot 中的元素
  __clarosight_setValue(idx, val)   设置表单值（触发 input 事件）
  __clarosight_wait(ms)             异步等待
  __clarosight_snapshot()           手动取快照

环境变量：
  CLAROSIGHT_SERVER  server 地址，默认 http://localhost:8080`)
      break
    }

    default:
      console.error(`未知命令: ${cmd}（用 --help 查看用法）`)
      process.exit(1)
  }
}

main()
