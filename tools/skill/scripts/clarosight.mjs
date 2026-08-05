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
 *   node clarosight.mjs tag <deviceId> <tags> [note]     设置设备标签/备注
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
          console.error('缺少要执行的 code（可在命令行传入，或通过管道：echo "..." | clarosight exec <id>）')
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
      const errors = await getJson(`/api/devices/${id}/errors`)
      if (errors.length === 0) {
        console.log('（暂无错误）')
        return
      }
      for (const e of errors) {
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
      const [devicesResp, errors, network, snapshotRes] = await Promise.all([
        getJson('/api/devices'),
        getJson(`/api/devices/${id}/errors`),
        getJson(`/api/devices/${id}/network`),
        get(`/api/devices/${id}/snapshot`),
      ])
      const device = devicesResp.devices.find((d) => d.id === id)
      const snapshot = await snapshotRes.text()

      console.log('# clarosight 设备诊断聚合')
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

      const failed = network.filter((n) => n.status >= 400 || n.status === 0)
      console.log(`## 异常网络请求 (${failed.length})`)
      if (failed.length === 0) {
        console.log('（无）')
      } else {
        for (const n of failed.slice(-10)) {
          console.log(`- ${n.method} ${n.status} ${n.url} (${n.duration}ms)`)
          if (n.error) console.log(`  ⚠ ${n.error}`)
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
      const byDuration = [...network].sort((a, b) => b.duration - a.duration)
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

      console.log('## 页面快照')
      console.log('```')
      console.log(snapshot)
      console.log('```')
      console.log('')
      console.log('---')
      console.log(`提示：可在该设备执行诊断代码，例如：`)
      console.log(`  clarosight exec ${id.slice(0, 8)} --code "return __clarosight_snapshot()"`)
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
        console.log('2) bookmarklet：clarosight inject bookmarklet')
        console.log('3) userscript： clarosight inject userscript')
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
  clarosight inspect <id>                  一键诊断聚合（错误+失败网络+快照，AI 最常用）
  clarosight tag <id> <tags> [note]        设置设备标签/备注（多设备区分用）
  clarosight inject [bookmarklet|userscript]  生成接入片段

exec 的 code 也可通过 stdin 传入（适合复杂多行代码）：
  echo "return document.title" | clarosight exec <id>

设备 id 支持前缀模糊匹配。code 作为 async 函数体执行，可写多条语句，用 return 返回值。
exec code 中可直接用的辅助函数：
  __clarosight_click(idx)           点击 snapshot 中的元素
  __clarosight_setValue(idx, val)   设置表单值（触发 input 事件）
  __clarosight_type(idx, text)      模拟键盘逐字输入（触发 keydown/keyup 序列）
  __clarosight_wait(ms)             异步等待
  __clarosight_snapshot()           手动取快照
  __clarosight_sourcemap(line,col,srcUrl?)  解析 source map（压缩位置→原始源码位置）
  __clarosight_sourcemapStack(frames)       批量解析堆栈帧

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
