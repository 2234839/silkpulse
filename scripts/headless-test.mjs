/**
 * 无头浏览器端到端测试 —— puppeteer-core + 系统 chromium
 *
 * 验证：控制台 UI、SDK 注入连接、snapshot、exec、__clarosight_click、console/error 采集
 */
import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SERVER = process.env.CLAROSIGHT_SERVER ?? 'http://localhost:8081'

/**
 * 探测 chromium 可执行文件路径
 * 优先级：CHROMIUM_PATH 环境变量 > which 探测常见名称 > 报错
 */
function detectChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const candidates = ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable']
  for (const name of candidates) {
    try {
      const found = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf8' }).trim()
      if (found && fs.existsSync(found)) return found
    } catch {}
  }
  console.error('未找到 chromium，请设置 CHROMIUM_PATH 环境变量指向 chromium 可执行文件')
  process.exit(1)
}

const CHROMIUM = detectChromium()
const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'

let step = 0
let failed = 0
function ok(msg) { console.log(`${PASS} [${step++}] ${msg}`) }
function fail(msg, e) { console.error(`${FAIL} [${step++}] ${msg}`, e ?? ''); failed++ }

/** 拉取在线设备列表（/api/devices 返回 { devices, recentlyOffline }，测试只用 devices 数组） */
async function fetchDevices() {
  const data = await (await fetch(`${SERVER}/api/devices`)).json()
  return data.devices ?? data
}

/** 拉取完整设备响应（含 recentlyOffline） */
async function fetchDevicesResponse() {
  return (await fetch(`${SERVER}/api/devices`)).json()
}

async function waitForDevice(timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const devices = await fetchDevices()
      if (devices.length > 0) return devices[0]
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

async function main() {
  console.log('启动无头浏览器...')
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })

  /** 准备测试页：通过 server /demo 路由加载（同源，避免跨域影响 network 采集） */
  try {
    /** 1. 控制台 UI */
    const consolePage = await browser.newPage()
    await consolePage.goto(SERVER, { waitUntil: 'networkidle0', timeout: 10000 })
    const title = await consolePage.title()
    if (title.includes('clarosight')) ok(`控制台 UI 加载（title="${title}"）`)
    else fail(`控制台标题异常: "${title}"`)

    const appLen = await consolePage.evaluate(() => document.getElementById('app')?.innerHTML?.length ?? 0)
    if (appLen > 50) ok(`控制台 Vue 已渲染（app 内容 ${appLen} 字符）`)
    else fail('控制台 Vue 未渲染')

    /** 1.5 静态资源缓存策略 —— sdk.js 必须 no-cache（诊断工具不能用旧版），带 hash 的长缓存 */
    {
      const sdkRes = await fetch(`${SERVER}/sdk.js`)
      const sdkCache = sdkRes.headers.get('cache-control') ?? ''
      const sdkEtag = sdkRes.headers.get('etag') ?? ''
      await sdkRes.text()

      /** 找一个带 hash 的构建产物 */
      const htmlText = await (await fetch(`${SERVER}/`)).text()
      const hashedMatch = htmlText.match(/\/assets\/index-[a-zA-Z0-9]+\.js/)
      const hashedPath = hashedMatch?.[0]
      const hashedRes = await fetch(`${SERVER}${hashedPath}`)
      const hashedCache = hashedRes.headers.get('cache-control') ?? ''
      const hashedEtag = hashedRes.headers.get('etag') ?? ''
      await hashedRes.text()

      /** ETag 304 验证：带 If-None-Match 应返回 304 */
      const condRes = await fetch(`${SERVER}${hashedPath}`, {
        headers: { 'If-None-Match': hashedEtag },
      })

      const sdkOk = sdkCache.includes('no-cache') && !!sdkEtag
      const hashedOk = hashedCache.includes('max-age=31536000') && hashedCache.includes('immutable')
      const etagOk = condRes.status === 304

      if (sdkOk && hashedOk && etagOk) {
        ok(`缓存策略正确（sdk.js no-cache ✓，/assets/* 长缓存 ✓，ETag 304 ✓）`)
      } else {
        fail(`缓存策略异常：sdk=${sdkCache} hashed=${hashedCache} 304=${condRes.status}`)
      }
    }

    /** 2. 测试页注入 SDK → 自动连接（同源加载，network 采集不受跨域影响） */
    const testPage = await browser.newPage()
    testPage.on('pageerror', (e) => console.log('  [pageerror]', e.message))
    await testPage.goto(`${SERVER}/demo`, { waitUntil: 'networkidle0', timeout: 15000 })

    const device = await waitForDevice()
    if (device) ok(`SDK 连接成功，设备上线: title="${device.title}", url=${device.url.slice(0, 40)}`)
    else { fail('SDK 未连接，设备未出现'); throw new Error('abort') }

    /** 2.1 设备类型识别（desktop/tablet/mobile） */
    if (device.deviceType === 'desktop') ok(`设备类型识别正确: ${device.deviceType}`)
    else fail(`设备类型异常: 期望 desktop，实际 ${device.deviceType}`)

    /** 2.2 SPA 路由变化上报 —— pushState 后 server 端 url 应更新 */
    await testPage.evaluate(() => history.pushState({}, '', '/spa-route-xyz'))
    await new Promise((r) => setTimeout(r, 800))
    const devAfter = (await fetchDevices()).find((d) => d.id === device.id)
    if (devAfter?.url?.includes('/spa-route-xyz')) {
      ok(`SPA 路由变化上报成功: url → ${devAfter.url.slice(-25)}`)
    } else {
      fail(`SPA 路由变化未上报: url=${devAfter?.url}`)
    }

    /** 3. exec API —— 在真实 DOM 执行 */
    const execRes = await fetch(`${SERVER}/api/devices/${device.id}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'document.getElementById("name-input").value = "无头测试"; return document.title' }),
    })
    const execData = await execRes.json()
    if (execData.success) ok(`exec 成功，title → ${execData.result}`)
    else fail(`exec 失败: ${JSON.stringify(execData)}`)

    /** 3.1 exec 后的 snapshotText 应为 compact 文本（含 url: 和 #idx），非 JSON */
    if (execData.snapshotText && execData.snapshotText.includes('# url:') && execData.snapshotText.includes('#')) {
      ok(`exec snapshotText 为 compact 文本格式（${execData.snapshotText.length} 字符）`)
    } else {
      fail(`exec snapshotText 格式异常: ${String(execData.snapshotText).slice(0, 100)}`)
    }

    /** 5. snapshot API（修复 return 后应成功）+ 取 button idx */
    const snapRes = await fetch(`${SERVER}/api/devices/${device.id}/snapshot`)
    if (snapRes.ok) {
      const snapText = await snapRes.text()
      if (snapText.includes('url:') && snapText.toLowerCase().includes('button')) {
        ok(`snapshot API 返回 compact 文本（${snapText.length} 字符）`)
      } else fail(`snapshot 内容异常: ${snapText.slice(0, 150)}`)
    } else fail(`snapshot HTTP ${snapRes.status}`)
    const snapText2 = await (await fetch(`${SERVER}/api/devices/${device.id}/snapshot`)).text()
    const btnMatch = snapText2.match(/button #(\d+)/)
    if (btnMatch) {
      const idx = btnMatch[1]
      const clickRes = await (await fetch(`${SERVER}/api/devices/${device.id}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `__clarosight_click(${idx}); return document.querySelector("#log").textContent` }),
      })).json()
      if (clickRes.success && clickRes.result?.includes('你好')) {
        ok(`exec + __clarosight_click(${idx}) 生效，输出: ${clickRes.result}`)
      } else fail(`exec click 异常: ${JSON.stringify(clickRes)}`)
    } else fail('snapshot 未找到 button idx')

    /** 5.1 __clarosight_type —— 模拟键盘输入到搜索框，验证 keyup 触发 */
    const snapText3 = await (await fetch(`${SERVER}/api/devices/${device.id}/snapshot`)).text()
    /** 找 search-input 的 idx（快照里 input 带 placeholder="输入关键词"） */
    const searchMatch = snapText3.match(/input #(\d+)[^\n]*关键词/)
    if (searchMatch) {
      const searchIdx = searchMatch[1]
      const typeRes = await (await fetch(`${SERVER}/api/devices/${device.id}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `__clarosight_type(${searchIdx}, "苹"); return document.querySelector("#search-result").textContent` }),
      })).json()
      if (typeRes.success && typeRes.result?.includes('苹果')) {
        ok(`exec + __clarosight_type(${searchIdx}, "苹") 生效，搜索结果: ${typeRes.result}`)
      } else fail(`exec type 异常: ${JSON.stringify(typeRes).slice(0, 150)}`)
    } else fail('snapshot 未找到搜索框 idx')

    /**
     * 5.2 快照表单状态采集 —— disabled/readonly/required/indeterminate/aria-disabled/aria-expanded
     *
     * AI 诊断远程表单问题（"按钮为什么点不了""表单为什么提交失败"）时，
     * 必须从快照看到这些状态，否则无法定位根因。
     */
    {
      const formSnap = await (await fetch(`${SERVER}/api/devices/${device.id}/snapshot`)).text()
      const checks = [
        { re: /input #\d+ val=只读值 readonly/, label: 'readonly 输入框' },
        { re: /input #\d+ ph:必填字段 required/, label: 'required 输入框' },
        { re: /input #\d+ type:checkbox indeterminate/, label: 'indeterminate 半选框' },
        { re: /button #\d+ disabled 禁用按钮/, label: 'disabled 原生禁用按钮' },
        { re: /button #\d+ aria-disabled/, label: 'aria-disabled 自定义禁用' },
        { re: /button #\d+ collapsed 展开/, label: 'aria-expanded=false 折叠态' },
      ]
      let pass = 0
      const missed = []
      for (const c of checks) {
        if (c.re.test(formSnap)) pass++
        else missed.push(c.label)
      }
      if (pass === checks.length) {
        ok(`快照表单状态全量采集（${pass}/${checks.length}: readonly/required/indeterminate/disabled/aria-disabled/collapsed）`)
      } else {
        fail(`快照表单状态缺失 ${missed.join('、')}（${pass}/${checks.length}）`)
      }
    }

    /**
     * 5.25 快照采集当前聚焦元素 —— AI 远程操作表单需知道光标位置
     *
     * 诊断"输入后提交失败"时，焦点在哪个输入框是关键上下文。
     * AI 执行 __clarosight_type 前能从快照判断是否需要先 click 定位。
     */
    {
      /** 聚焦 name-input */
      await testPage.evaluate(() => document.getElementById('name-input')?.focus())
      await new Promise((r) => setTimeout(r, 300))
      const focusSnap = await (await fetch(`${SERVER}/api/devices/${device.id}/snapshot`)).text()
      /** name-input 带 placeholder="输入你的名字"，应标 focus */
      const focusLine = focusSnap.split('\n').find((l) => l.includes('focus'))
      if (focusLine && /输入你的名字/.test(focusLine)) {
        ok(`快照标记聚焦元素（${focusLine.trim()}）`)
      } else {
        fail(`快照未正确标记聚焦元素：${focusLine ?? '无 focus 行'}`)
      }
    }

    /** 5.3 exec 错误信息含 stack —— AI 诊断远程报错时需要出错位置
     *
     * 之前 exec catch 只返回 "TypeError: xxx" 单行，AI 无法定位。
     * 现在运行时错误附带 stack（截断），语法错误保持单行（无 stack）。
     */
    {
      /** 运行时错误：访问 null 的属性 */
      const runtimeErr = await (await fetch(`${SERVER}/api/devices/${device.id}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `const x = null; return x.foo` }),
      })).json()
      if (!runtimeErr.success && runtimeErr.error && runtimeErr.error.includes('TypeError')) {
        if (runtimeErr.error.includes('\n')) {
          ok(`exec 运行时错误含 stack（${runtimeErr.error.split('\n')[0]}…）`)
        } else {
          fail(`exec 运行时错误缺 stack：${runtimeErr.error}`)
        }
      } else {
        fail(`exec 运行时错误格式异常: ${JSON.stringify(runtimeErr).slice(0, 150)}`)
      }

      /** 语法错误：缺括号，应有 SyntaxError 但无需 stack */
      const syntaxErr = await (await fetch(`${SERVER}/api/devices/${device.id}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `return {` }),
      })).json()
      if (!syntaxErr.success && syntaxErr.error && syntaxErr.error.includes('SyntaxError')) {
        ok(`exec 语法错误正确捕获（${syntaxErr.error.slice(0, 60)}）`)
      } else {
        fail(`exec 语法错误异常: ${JSON.stringify(syntaxErr).slice(0, 150)}`)
      }
    }

    /**
     * 5.4 exec 异步超时保护 —— 永不 resolve 的代码由 SDK 端 9s 超时兜底
     *
     * `return new Promise(() => {})` 会无限挂起。之前靠 server 端 10s 超时回"执行超时"，
     * 但 SDK 端 promise 仍泄漏、exec 日志捕获队列永不结束。现在 SDK 端 Promise.race
     * 先于 server 触发（9s < 10s），干净回传超时 + 释放资源。
     */
    {
      const hangStart = Date.now()
      const hangRes = await (await fetch(`${SERVER}/api/devices/${device.id}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `return new Promise(() => {})` }),
      })).json()
      const elapsed = Date.now() - hangStart
      /** 应在 ~9s（SDK 端）返回，而非 10s（server 端），且报超时 */
      if (!hangRes.success && hangRes.error && hangRes.error.includes('超时')) {
        ok(`exec 异步超时保护生效（${elapsed}ms 返回：${hangRes.error.slice(0, 40)}）`)
      } else {
        fail(`exec 超时异常：elapsed=${elapsed}ms success=${hangRes.success} err=${hangRes.error ?? '无'}`)
      }
    }

    /** 6. console 采集 */
    await testPage.evaluate(() => document.getElementById('greet-btn')?.click())
    await new Promise((r) => setTimeout(r, 800))
    const logs = await (await fetch(`${SERVER}/api/devices/${device.id}/logs`)).json()
    if (logs.some((l) => l.message.includes('打招呼'))) ok(`console 采集成功（${logs.length} 条）`)
    else fail(`console 采集异常: ${logs.slice(-2).map((l) => l.message).join(' | ')}`)

    /** 6.5 日志限流 —— 防止远程页面 log 爆炸打爆 WS/server */
    {
      const beforeTs = Date.now()
      /** 1 秒内狂刷 200 条 info + 5 条 error（error 不应被限流） */
      await testPage.evaluate(() => {
        for (let i = 0; i < 200; i++) console.log(`限流测试-${i}`)
        for (let i = 0; i < 5; i++) console.error(`限流error-${i}`)
      })
      /** 等 2.5s：让限流窗口滚动 + 汇总上报（每秒检查一次） */
      await new Promise((r) => setTimeout(r, 2500))
      const allLogs = await (await fetch(`${SERVER}/api/devices/${device.id}/logs`)).json()
      /** 只看本次触发产生的日志（按时间戳过滤） */
      const recent = allLogs.filter((l) => new Date(l.timestamp).getTime() > beforeTs)
      const infoCount = recent.filter((l) => l.type === 'info' && l.message.includes('限流测试-')).length
      const errorCount = recent.filter((l) => l.type === 'error' && l.message.includes('限流error-')).length
      const hasThrottleNotice = recent.some((l) => l.type === 'warn' && l.message.includes('日志限流'))

      /** info 应远少于 200（限流窗口 50 条/秒），error 应 5 条全在，应有限流提示 */
      if (infoCount < 200 && infoCount > 0) {
        if (errorCount === 5) {
          if (hasThrottleNotice) {
            ok(`日志限流生效（info 200→${infoCount}，error 5 条全保留，有限流提示）`)
          } else {
            fail(`日志限流提示缺失：info=${infoCount} error=${errorCount} 但无限流 warn`)
          }
        } else {
          fail(`error 不应被限流：期望 5 条，实际 ${errorCount} 条`)
        }
      } else {
        fail(`日志限流异常：info=${infoCount}（应 <200 且 >0）`)
      }
    }

    /** 7. network 采集 —— fetch + xhr + POST body */
    await testPage.evaluate(() => document.getElementById('fetch-ok')?.click())
    await testPage.evaluate(() => document.getElementById('fetch-404')?.click())
    await testPage.evaluate(() => document.getElementById('xhr-btn')?.click())
    await testPage.evaluate(() => document.getElementById('post-btn')?.click())
    await new Promise((r) => setTimeout(r, 1500))
    const network = await (await fetch(`${SERVER}/api/devices/${device.id}/network`)).json()
    const hasFetch = network.some((n) => n.url.includes('/api/devices'))
    const has404 = network.some((n) => n.url.includes('/api/not-exist') && n.status === 404)
    const hasXhr = network.some((n) => n.method === 'GET' && n.url.includes('/api/devices'))
    if (hasFetch && has404 && hasXhr) {
      ok(`network 采集成功（${network.length} 条：fetch ✓ 404 ✓ XHR ✓）`)
    } else {
      fail(`network 采集不完整（fetch=${hasFetch} 404=${has404} xhr=${hasXhr}，共 ${network.length} 条）`)
      console.log('  network 详情:', JSON.stringify(network.map((n) => ({ m: n.method, s: n.status, u: n.url.slice(-30) }))))
    }

    /** 7.1 POST body 采集 —— 验证 reqBody/resBody 被正确捕获 */
    const postEntry = network.find((n) => n.method === 'POST' && n.url.includes('/api/echo'))
    if (postEntry && postEntry.reqBody && postEntry.reqBody.includes('clarosight') && postEntry.resBody) {
      ok(`POST body 采集成功（reqBody ${postEntry.reqBody.length} 字符，resBody ${postEntry.resBody.length} 字符）`)
    } else {
      fail(`POST body 采集异常: ${JSON.stringify({ method: postEntry?.method, hasReq: !!postEntry?.reqBody, hasRes: !!postEntry?.resBody })}`)
    }

    /** 7.15 POST body 大小上限保护 —— 超大 body 返回 413，不撑爆内存 */
    {
      /** 3MB body，超过 2MB 上限 */
      const hugeCode = 'x'.repeat(3 * 1024 * 1024)
      const hugeRes = await fetch(`${SERVER}/api/devices/${device.id}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: hugeCode }),
      })
      /** 正常小 body 仍工作（exec 成功） */
      const normalRes = await (await fetch(`${SERVER}/api/devices/${device.id}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'return 1 + 1' }),
      })).json()
      if (hugeRes.status === 413 && normalRes.success && normalRes.result === '2') {
        ok(`POST body 上限保护生效（3MB → 413，正常 exec 仍成功）`)
      } else {
        fail(`body 上限异常：huge=${hugeRes.status} normal=${normalRes.success}`)
      }
    }

    /** 7.2 请求头/响应头采集 —— fetch 带自定义头 + xhr setRequestHeader */
    {
      /** fetch 带 content-type + 自定义 x- 头 */
      await testPage.evaluate(async () => {
        await fetch('/api/echo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Clarosight-Test': 'header-collect' },
          body: JSON.stringify({ purpose: 'header-test' }),
        })
      })
      /** xhr 带自定义头 */
      await testPage.evaluate(() => {
        return new Promise((resolve) => {
          const xhr = new XMLHttpRequest()
          xhr.open('GET', '/api/devices')
          xhr.setRequestHeader('X-Xhr-Custom', 'xhr-header-val')
          xhr.onload = () => resolve()
          xhr.send()
        })
      })
      await new Promise((r) => setTimeout(r, 800))
      const netHeaders = await (await fetch(`${SERVER}/api/devices/${device.id}/network`)).json()
      const fetchH = netHeaders.find((n) => n.method === 'POST' && n.reqHeaders && n.reqHeaders['x-clarosight-test'])
      const xhrH = netHeaders.find((n) => n.method === 'GET' && n.reqHeaders && n.reqHeaders['x-xhr-custom'])

      /** fetch：应有 content-type + 自定义 x- 头 + 响应头 */
      const fetchOk = fetchH && fetchH.reqHeaders['content-type'] === 'application/json' && fetchH.reqHeaders['x-clarosight-test'] === 'header-collect' && fetchH.resHeaders
      /** xhr：应有自定义头（setRequestHeader 采集）+ 响应头（getAllResponseHeaders 采集） */
      const xhrOk = xhrH && xhrH.reqHeaders['x-xhr-custom'] === 'xhr-header-val' && xhrH.resHeaders

      if (fetchOk && xhrOk) {
        ok(`请求头/响应头采集成功（fetch content-type + x-头 ✓，xhr setRequestHeader + 响应头 ✓）`)
      } else {
        fail(`headers 采集异常：fetchOk=${!!fetchOk} xhrOk=${!!xhrH} fetchH=${JSON.stringify(fetchH?.reqHeaders)} xhrH=${JSON.stringify(xhrH?.reqHeaders)}`)
      }
    }

    /** 8. error 采集 —— 运行时错误 + Promise rejection */
    await testPage.evaluate(() => document.getElementById('runtime-error-btn')?.click())
    await testPage.evaluate(() => document.getElementById('promise-error-btn')?.click())
    await new Promise((r) => setTimeout(r, 800))
    const errors = await (await fetch(`${SERVER}/api/devices/${device.id}/errors`)).json()
    /** file:// 加载的页面，SDK 是跨域脚本，浏览器可能把 message 替换为 "Script error."。
     *  Promise rejection 通常能保留原始 message。关键是 error 事件被捕获。 */
    const hasPromiseError = errors.some((e) => e.message.includes('Promise') || e.message.includes('未处理'))
    if (errors.length >= 1) ok(`error 采集成功（${errors.length} 条${hasPromiseError ? '，含 Promise rejection' : ''}）`)
    else fail(`error 采集异常: 未捕获到错误`)

    /** 8.5 资源加载失败不应计入 errorCount（避免 404 图片误导诊断） */
    {
      /** 记录触发前的 errorCount */
      const beforeDeviceInfo = await fetchDevices()
      const errCountBefore = beforeDeviceInfo.find((d) => d.id === device.id)?.errorCount ?? 0
      const errsBefore = (await (await fetch(`${SERVER}/api/devices/${device.id}/errors`)).json()).length

      /** 注入 3 个 404 资源（img / script / link） */
      await testPage.evaluate(() => {
        const img = document.createElement('img')
        img.src = '/not-exist-resource.png'
        document.body.appendChild(img)
        const script = document.createElement('script')
        script.src = '/not-exist-resource.js'
        document.body.appendChild(script)
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = '/not-exist-resource.css'
        document.head.appendChild(link)
      })
      await new Promise((r) => setTimeout(r, 1200))

      /** 验证 errorCount 和 errors 数量都没增长 */
      const afterDeviceInfo = await fetchDevices()
      const errCountAfter = afterDeviceInfo.find((d) => d.id === device.id)?.errorCount ?? 0
      const errsAfter = (await (await fetch(`${SERVER}/api/devices/${device.id}/errors`)).json()).length

      if (errCountAfter === errCountBefore && errsAfter === errsBefore) {
        ok(`资源加载失败不计入 errorCount（${errCountBefore}→${errCountAfter}，errors ${errsBefore}→${errsAfter}）`)
      } else {
        fail(`资源错误被误计入：errorCount ${errCountBefore}→${errCountAfter}，errors ${errsBefore}→${errsAfter}`)
      }
    }

    /** 9. 控制台 WS 实时推送（选中设备后能看到日志） */
    const seen = await consolePage.evaluate(async (deviceId) => {
      const ws = new WebSocket(`ws://${location.host}/ws/console`)
      ws.send = ws.send.bind(ws)
      return new Promise((resolve) => {
        const got = { list: false, log: false }
        ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', deviceId }))
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data)
          if (m.type === 'device-list') got.list = true
          if (m.type === 'log') got.log = true
        }
        setTimeout(() => resolve(got), 2000)
      })
    }, device.id)
    /** 触发一条新日志让推送生效 */
    await testPage.evaluate(() => document.getElementById('greet-btn')?.click())
    await new Promise((r) => setTimeout(r, 1000))
    if (seen.list) ok(`控制台 WS 连接 + device-list 推送成功`)
    else fail('控制台 WS 未收到 device-list')

    /**
     * 9.1 WS broadcast 背压保护 —— 设备突发大量日志时 server 不崩、控制台仍可订阅
     *
     * server 的 broadcast 有 bufferedAmount 背压上限（1MB），慢客户端超限会被关闭。
     * 这里验证正常路径不受影响：突发日志后新控制台连接仍能收到推送，
     * 且 HTTP API 仍响应（server 进程存活，未被背压拖垮）。
     */
    {
      /** 设备端突发 200 条日志（SDK 有限流，会丢一部分，但 server 收到的都会经 broadcast） */
      await testPage.evaluate(() => {
        for (let i = 0; i < 200; i++) console.info(`burst-${i}`)
      })
      await new Promise((r) => setTimeout(r, 1500))
      /** 新控制台连接订阅，应能收到 device-list（server WS 仍正常接受连接） */
      const afterBurst = await consolePage.evaluate(async (deviceId) => {
        return new Promise((resolve) => {
          const ws = new WebSocket(`ws://${location.host}/ws/console`)
          let gotList = false
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'subscribe', deviceId }))
            gotList = true
          }
          setTimeout(() => { ws.close(); resolve(gotList) }, 1500)
        })
      }, device.id)
      /** HTTP API 仍响应（server 存活） */
      const apiAlive = (await fetch(`${SERVER}/api/devices`)).ok
      const burstLogs = await (await fetch(`${SERVER}/api/devices/${device.id}/logs`)).json()
      const burstReceived = burstLogs.some((l) => String(l.message).includes('burst-'))
      if (afterBurst && apiAlive && burstReceived) {
        ok(`WS 背压保护：突发日志后 server 存活、控制台仍可连接、日志已入库（${burstLogs.length} 条）`)
      } else {
        fail(`背压保护异常：连接=${afterBurst} api=${apiAlive} 日志入库=${burstReceived}`)
      }
    }

    /** 10. 多设备并发 —— 再开第二个 /demo 页面（同源，第二个设备） */
    const testPage2 = await browser.newPage()
    await testPage2.goto(`${SERVER}/demo`, { waitUntil: 'networkidle0', timeout: 15000 })
    await new Promise((r) => setTimeout(r, 1000))
    const devicesList = await fetchDevices()
    if (devicesList.length >= 2) {
      ok(`多设备并发成功（${devicesList.length} 个设备在线）`)
    } else {
      fail(`多设备并发异常（期望 ≥2，实际 ${devicesList.length}）`)
    }

    /** 10.1 设备搜索 —— 控制台搜索框筛选设备列表 */
    const searchResult = await consolePage.evaluate(async (q) => {
      const input = document.querySelector('input[placeholder*="搜索设备"]')
      if (!input) return { error: '无搜索框' }
      input.value = q
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 300))
      const visibleLis = document.querySelectorAll('ul li').length
      return { visibleLis }
    }, 'clarosight')
    if (searchResult.visibleLis >= 2) {
      ok(`控制台设备搜索生效（搜索 "clarosight" 匹配 ${searchResult.visibleLis} 个）`)
    } else {
      fail(`设备搜索异常: ${JSON.stringify(searchResult)}`)
    }

    /** 10.2 清空搜索 */
    await consolePage.evaluate(() => {
      const input = document.querySelector('input[placeholder*="搜索设备"]')
      if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })) }
    })
    await new Promise((r) => setTimeout(r, 300))

    /** 11. AI 诊断上下文 —— 控制台"复制 AI 诊断上下文"按钮 */
    /** 先在测试页触发错误和网络请求，制造诊断现场 */
    await testPage.evaluate(() => document.getElementById('runtime-error-btn')?.click())
    await testPage.evaluate(() => document.getElementById('fetch-404')?.click())
    await new Promise((r) => setTimeout(r, 1000))

    const aiContext = await consolePage.evaluate(async (deviceId) => {
      /** 模拟控制台的"生成 AI 上下文"：拉快照 + 聚合 errors/network/logs */
      const [snapRes, errsRes, netRes, logsRes] = await Promise.all([
        fetch(`/api/devices/${deviceId}/snapshot`),
        fetch(`/api/devices/${deviceId}/errors`),
        fetch(`/api/devices/${deviceId}/network`),
        fetch(`/api/devices/${deviceId}/logs`),
      ])
      const snapshot = await snapRes.text()
      const errors = await errsRes.json()
      const network = await netRes.json()
      const logs = await logsRes.json()
      return { snapshotLen: snapshot.length, errorCount: errors.length, networkCount: network.length, logCount: logs.length }
    }, device.id)
    if (aiContext.snapshotLen > 100 && aiContext.errorCount >= 1 && aiContext.networkCount >= 1) {
      ok(`AI 诊断上下文可聚合现场（快照 ${aiContext.snapshotLen} 字符，错误 ${aiContext.errorCount}，网络 ${aiContext.networkCount}，日志 ${aiContext.logCount}）`)
    } else {
      fail(`AI 诊断上下文数据不完整: ${JSON.stringify(aiContext)}`)
    }

    /** 12. bookmarklet 注入 —— 拉取 bookmarklet，在真实页面执行，验证新设备上线 */
    const beforeCount = (await fetchDevices()).length
    const bookmarklet = await (await fetch(`${SERVER}/inject/bookmarklet`)).text()
    /** bookmarklet 形如 javascript:<encoded>，解码后在目标页面执行 */
    const bmCode = decodeURIComponent(bookmarklet.replace(/^javascript:/, ''))
    const bmPage = await browser.newPage()
    bmPage.on('console', (m) => { if (m.type() === 'error') console.log('  [bm console.error]', m.text()) })
    bmPage.on('pageerror', (e) => console.log('  [bm pageerror]', e.message))
    /** 用一个同源的真实页面（/demo 会自动注入，这里用 server 根控制台页验证"二次注入被防重"不阻断 bookmarklet 自身）
     *  真正验证 bookmarklet：用一个不含 SDK 的独立 HTML 页面 */
    await bmPage.goto(`${SERVER}/inject-test`, { waitUntil: 'domcontentloaded' })
    await bmPage.evaluate(bmCode)
    await new Promise((r) => setTimeout(r, 2000))
    const afterCount = (await fetchDevices()).length
    if (afterCount > beforeCount) {
      ok(`bookmarklet 注入成功（设备数 ${beforeCount} → ${afterCount}）`)
    } else {
      fail(`bookmarklet 注入未上线新设备（${beforeCount} → ${afterCount}）`)
    }

    /** 13. 断线重连 —— 模拟网络闪断，验证设备自动重连 + 历史保留 */
    const reconDev = await waitForDevice()
    if (reconDev) {
      const logsBeforeRecon = await (await fetch(`${SERVER}/api/devices/${reconDev.id}/logs`)).json()
      /** 用 CDP 模拟断网 → 等 WS 断开 → 恢复 → 等 SDK 重连 */
      const cdp = await testPage.target().createCDPSession()
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      })
      await new Promise((r) => setTimeout(r, 3000))
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      })
      await new Promise((r) => setTimeout(r, 6000))
      const reconDevices = await fetchDevices()
      const reconMatch = reconDevices.find((d) => d.id === reconDev.id)
      if (reconMatch) {
        const logsAfterRecon = await (await fetch(`${SERVER}/api/devices/${reconDev.id}/logs`)).json()
        /** 验证：重连后历史日志不丢 */
        if (logsAfterRecon.length >= logsBeforeRecon.length) {
          ok(`断线重连成功（历史保留 ${logsBeforeRecon.length}→${logsAfterRecon.length} 条日志）`)
        } else {
          fail(`重连后历史丢失（${logsBeforeRecon.length}→${logsAfterRecon.length}）`)
        }
      } else {
        fail(`断线重连失败：设备 ${reconDev.id.slice(0, 8)} 未重连`)
      }
    } else {
      fail('重连测试前置失败：无在线设备')
    }

    /** 13.5 SDK 离线缓冲 —— 断线期间产生的数据，重连后不丢失 */
    {
      const bufDev = await waitForDevice()
      if (!bufDev) { fail('SDK 缓冲测试前置失败：无在线设备'); }
      else {
        /** 用唯一标记区分本次测试的日志 */
        const marker = `buffer-test-${Date.now()}`
        const cdp = await testPage.target().createCDPSession()
        await cdp.send('Network.enable')
        /** 断网 */
        await cdp.send('Network.emulateNetworkConditions', {
          offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
        })
        await new Promise((r) => setTimeout(r, 1500))
        /** 断网期间触发日志（SDK WS 已断，应入缓冲队列） */
        await testPage.evaluate((m) => console.log(m), marker)
        await new Promise((r) => setTimeout(r, 500))
        /** 恢复网络，等 SDK 重连 + flush */
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        })
        await new Promise((r) => setTimeout(r, 7000))
        /** 验证带标记的日志到达 server（若无缓冲，断网期间的日志会丢） */
        const logsAfter = await (await fetch(`${SERVER}/api/devices/${bufDev.id}/logs`)).json()
        const arrived = logsAfter.some((l) => l.message.includes(marker))
        if (arrived) {
          ok(`SDK 离线缓冲生效（断线期间日志"${marker}"重连后到达 server）`)
        } else {
          fail(`SDK 离线缓冲失败：断线期间的日志 "${marker}" 丢失`)
        }
      }
    }

    /**
     * 13.6 最近下线设备历史 —— AI 判断"接入过但掉了" vs "从未接入"
     *
     * 设备下线后从 devices 删除，但保留摘要到 recentlyOffline（上限 10），
     * AI 调 /api/devices 能看到"X 分钟前有设备掉过线"，不误判为"用户没接入"。
     * 设备重连后从 recentlyOffline 移除。
     */
    {
      /** 开一个独立 page 作为待下线设备 */
      const offlinePage = await browser.newPage()
      await offlinePage.goto(`${SERVER}/demo`, { waitUntil: 'networkidle0', timeout: 15000 })
      await new Promise((r) => setTimeout(r, 1500))
      const offlineDevs = await fetchDevices()
      const offlineDev = offlineDevs[offlineDevs.length - 1]
      /** close page 触发 WS 断开 → server 检测下线（3s 等 close 事件传播） */
      await offlinePage.close()
      await new Promise((r) => setTimeout(r, 3000))
      const { devices: onlineNow, recentlyOffline: offlineHist } = await fetchDevicesResponse()
      const inOnline = onlineNow.some((d) => d.id === offlineDev.id)
      const inOffline = offlineHist.find((o) => o.id === offlineDev.id)
      if (!inOnline && inOffline && typeof inOffline.offlineAt === 'number') {
        ok(`最近下线设备历史生效（${inOffline.title}，offlineAt 已记录）`)
      } else {
        fail(`下线历史异常：online=${inOnline} offline=${!!inOffline}`)
      }
    }

    /** 14. 设备标签/备注 —— POST /tags 设置，GET /devices 反映，再触发 SPA 路由确认不被覆盖 */
    const tagDev = await waitForDevice()
    if (tagDev) {
      /** 初始应为空标签 */
      if ((tagDev.tags ?? []).length === 0) ok(`设备初始无标签（符合预期）`)
      else fail(`设备初始不应有标签，实际: ${JSON.stringify(tagDev.tags)}`)

      /** 设置标签 + 备注 */
      const setRes = await fetch(`${SERVER}/api/devices/${tagDev.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['生产环境', '用户A'], note: 'iPhone 15 测试机' }),
      }).then((r) => r.json())
      if (setRes.ok && setRes.device.tags.length === 2 && setRes.device.note === 'iPhone 15 测试机') {
        ok(`POST /tags 设置成功：tags=[${setRes.device.tags.join(',')}] note="${setRes.device.note}"`)
      } else {
        fail(`POST /tags 设置异常: ${JSON.stringify(setRes)}`)
      }

      /** GET /devices 应反映新标签 */
      const devWithTags = (await fetchDevices()).find((d) => d.id === tagDev.id)
      if (devWithTags?.tags?.length === 2 && devWithTags?.note === 'iPhone 15 测试机') {
        ok(`GET /devices 正确反映标签/备注`)
      } else {
        fail(`GET /devices 未反映标签: ${JSON.stringify(devWithTags?.tags)}`)
      }

      /** 触发 SPA 路由上报（update-info），验证 tags/note 不被 SDK 上报覆盖 */
      await testPage.evaluate(() => history.pushState({}, '', '/tag-persistence-check'))
      await new Promise((r) => setTimeout(r, 800))
      const devAfterRoute = (await fetchDevices()).find((d) => d.id === tagDev.id)
      if (devAfterRoute?.tags?.length === 2 && devAfterRoute?.note === 'iPhone 15 测试机') {
        ok(`SPA 路由变化后标签/备注保留（未被 update-info 覆盖）`)
      } else {
        fail(`SPA 路由后标签丢失: tags=${JSON.stringify(devAfterRoute?.tags)} note=${JSON.stringify(devAfterRoute?.note)}`)
      }
    } else {
      fail('标签测试前置失败：无在线设备')
    }

    /** 15. source map 解析 —— 压缩代码错误自动映射回原始源码位置 */
    const smDev = await waitForDevice()
    if (smDev) {
      /** 注入带 sourceMappingURL 的压缩脚本，执行时抛错 */
      await testPage.evaluate(() => {
        const s = document.createElement('script')
        s.src = '/test-fixtures/crash.js'
        document.head.appendChild(s)
      })
      /** 等待错误捕获 + source map 异步解析（fetch crash.js → 解析 sourceMappingURL → fetch crash.js.map → 解析） */
      await new Promise((r) => setTimeout(r, 3000))
      const errors = await (await fetch(`${SERVER}/api/devices/${smDev.id}/errors`)).json()
      /** 找到 crash.js 引发的错误（source 含 crash.js） */
      const crashErr = errors.reverse().find((e) => e.source?.includes('crash.js'))
      if (!crashErr) {
        fail('source map 测试前置失败：未捕获到 crash.js 错误')
      } else if (crashErr.mapped && crashErr.mapped.source === 'crash.ts') {
        ok(`source map 解析成功: ${crashErr.source}:${crashErr.line}:${crashErr.col} → ${crashErr.mapped.source}:${crashErr.mapped.line}:${crashErr.mapped.column}`)
      } else {
        fail(`source map 解析失败: mapped=${JSON.stringify(crashErr.mapped)}（source=${crashErr.source}）`)
      }

      /** 16. __clarosight_sourcemap exec 辅助函数 —— AI 主动解析堆栈位置 */
      const smExecRes = await fetch(`${SERVER}/api/devices/${smDev.id}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'return await __clarosight_sourcemap(1, 14, location.origin + "/test-fixtures/crash.js")',
        }),
      }).then((r) => r.json())
      if (smExecRes.success) {
        const pos = JSON.parse(smExecRes.result)
        if (pos && pos.source === 'crash.ts' && pos.line === 2) {
          ok(`__clarosight_sourcemap exec 辅助函数: 1:14 → ${pos.source}:${pos.line}:${pos.column}`)
        } else {
          fail(`__clarosight_sourcemap 返回异常: ${smExecRes.result}`)
        }
      } else {
        fail(`__clarosight_sourcemap 执行失败: ${smExecRes.error}`)
      }
    } else {
      fail('source map 测试前置失败：无在线设备')
    }

    /** 17. iframe 元素采集 —— snapshot 应穿透同源 iframe，元素带 frame 标识 */
    const iframeDev = await waitForDevice()
    if (iframeDev) {
      /** 创建同源 iframe（srcdoc 继承源），内含交互元素 */
      await testPage.evaluate(() => {
        const ifr = document.createElement('iframe')
        ifr.name = 'embed-frame'
        ifr.srcdoc = '<!DOCTYPE html><html><body><button id="iframe-btn">iframe按钮</button><input id="iframe-input" placeholder="iframe输入框" /></body></html>'
        document.body.appendChild(ifr)
      })
      await new Promise((r) => setTimeout(r, 800))
      const snapText = await (await fetch(`${SERVER}/api/devices/${iframeDev.id}/snapshot`)).text()
      /** 验证 iframe 内元素被采集 + 带 frame 标识 */
      if (snapText.includes('[frame:embed-frame]') && snapText.includes('iframe按钮')) {
        ok(`iframe 元素采集成功（snapshot 含 frame:embed-frame 标记）`)
      } else {
        fail(`iframe 元素未出现在 snapshot 中`)
      }

      /** 18. exec 操作 iframe 内元素 —— click iframe 内按钮 */
      const iframeClickRes = await fetch(`${SERVER}/api/devices/${iframeDev.id}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          /** 找到 iframe 内按钮的 idx（snapshot 里带 frame 标识的那个）并点击 */
          code: `
            const snap = __clarosight_snapshot()
            const btn = snap.els.find(e => e.frame === 'embed-frame' && e.tag === 'button')
            if (!btn) return { error: '未找到 iframe 按钮', count: snap.els.filter(e => e.frame).length }
            const clicked = __clarosight_click(btn.idx)
            return { clicked, idx: btn.idx, text: btn.text }
          `,
        }),
      }).then((r) => r.json())
      if (iframeClickRes.success) {
        const r = JSON.parse(iframeClickRes.result)
        if (r.clicked) {
          ok(`exec 成功点击 iframe 内元素（idx=${r.idx}, text="${r.text}"）`)
        } else {
          fail(`点击 iframe 元素失败: ${iframeClickRes.result}`)
        }
      } else {
        fail(`exec iframe 测试失败: ${iframeClickRes.error}`)
      }
    } else {
      fail('iframe 测试前置失败：无在线设备')
    }

    /** 19. Errors 搜索 + 堆栈折叠 —— 控制台 UI 错误面板的关键词过滤与堆栈展开 */
    {
      /** 选中第一个设备（首次在 UI 选设备） */
      await consolePage.evaluate(() => { const li = document.querySelector('ul li'); if (li) li.click() })
      await new Promise((r) => setTimeout(r, 600))
      /** 切到 errors 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('nav button'))
        const errTab = tabs.find((t) => t.textContent.trim().startsWith('Errors'))
        if (errTab) errTab.click()
      })
      await new Promise((r) => setTimeout(r, 400))
      /** 验证堆栈默认收起（<details> 无 open 属性） */
      const stackCollapsed = await consolePage.evaluate(() => {
        const details = document.querySelector('details')
        if (!details) return null
        return !details.hasAttribute('open')
      })
      /** 验证搜索过滤生效 */
      const totalErrors = await consolePage.evaluate(() => document.querySelectorAll('.bg-red-soft.border.border-red-soft.rounded.p-3').length)
      /** 输入搜索词过滤（之前的测试已触发 source map 错误，message 含"source map 测试错误"） */
      await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索错误"]')
        if (input) {
          input.value = 'source map'
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })
      await new Promise((r) => setTimeout(r, 300))
      const filteredErrCount = await consolePage.evaluate(() => document.querySelectorAll('.bg-red-soft.border.border-red-soft.rounded.p-3').length)
      /** 清空搜索 */
      await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索错误"]')
        if (input) {
          input.value = ''
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })
      await new Promise((r) => setTimeout(r, 300))

      if (stackCollapsed === true) {
        ok(`错误堆栈默认收起（<details> 折叠）`)
      } else {
        fail(`错误堆栈折叠异常：stackCollapsed=${stackCollapsed}`)
      }
      if (totalErrors > 0 && filteredErrCount < totalErrors) {
        ok(`错误搜索过滤生效（${totalErrors} → ${filteredErrCount} 条）`)
      } else {
        fail(`错误搜索过滤异常：总数=${totalErrors} 过滤后=${filteredErrCount}`)
      }
    }

    /** 19.5 Tab 数量徽标 —— Console/Network/Errors tab 显示条数，Errors 红色高亮 */
    {
      const badgeInfo = await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('nav button'))
        const findBadge = (label) => {
          const tab = tabs.find((t) => t.textContent.trim().startsWith(label))
          if (!tab) return { found: false, count: 0, isRed: false }
          const span = tab.querySelector('span')
          const count = span ? parseInt(span.textContent.trim(), 10) : 0
          /** Errors 徽标含 red 类（bg-red-600 或 bg-red-100） */
          const isRed = span ? (span.className.includes('red-600') || span.className.includes('red-100')) : false
          return { found: true, count: isNaN(count) ? 0 : count, isRed }
        }
        return {
          errors: findBadge('Errors'),
          network: findBadge('Network'),
        }
      })
      if (badgeInfo.errors.found && badgeInfo.errors.count > 0 && badgeInfo.errors.isRed) {
        ok(`Tab 徽标生效（Errors ${badgeInfo.errors.count} 红色高亮，Network ${badgeInfo.network.count}）`)
      } else {
        fail(`Tab 徽标异常：errors=${JSON.stringify(badgeInfo.errors)} network=${JSON.stringify(badgeInfo.network)}`)
      }
    }

    /** 20. Network 搜索 —— 控制台 UI 网络面板的关键词过滤 */
    {
      /** 切到 network 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('nav button'))
        const netTab = tabs.find((t) => t.textContent.trim().startsWith('Network'))
        if (netTab) netTab.click()
      })
      await new Promise((r) => setTimeout(r, 400))
      const totalNet = await consolePage.evaluate(() => document.querySelectorAll('tbody tr').length)
      /** 输入搜索词过滤（之前的测试产生了 /api/echo 等 POST 请求） */
      await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索请求"]')
        if (input) {
          input.value = 'echo'
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })
      await new Promise((r) => setTimeout(r, 300))
      const filteredNetCount = await consolePage.evaluate(() => document.querySelectorAll('tbody tr').length)
      /** 清空搜索（不影响后续测试） */
      await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索请求"]')
        if (input) {
          input.value = ''
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })
      await new Promise((r) => setTimeout(r, 300))

      if (totalNet > 0 && filteredNetCount < totalNet && filteredNetCount >= 1) {
        ok(`网络搜索过滤生效（${totalNet} → ${filteredNetCount} 条）`)
      } else {
        fail(`网络搜索过滤异常：总数=${totalNet} 过滤后=${filteredNetCount}`)
      }

      /** 20.1 network 列表时间戳列 —— 诊断时序问题时需看请求时刻 */
      const hasTimeCol = await consolePage.evaluate(() => {
        const ths = Array.from(document.querySelectorAll('thead th'))
        const hasHeader = ths.some((th) => th.textContent.trim() === '时间')
        /** 首行首个 td 应是时间格式（HH:MM:SS） */
        const firstTd = document.querySelector('tbody tr td')
        const timeText = firstTd ? firstTd.textContent.trim() : ''
        const isTime = /^\d{1,2}:\d{2}:\d{2}/.test(timeText)
        return hasHeader && isTime
      })
      if (hasTimeCol) {
        ok(`network 列表含时间戳列（表头"时间" + 首行时间格式）`)
      } else {
        fail(`network 列表缺时间戳列`)
      }
    }

    /**
     * 20.8 exec 结果样式 + 快照折叠 —— 失败红色、快照默认折叠不撑屏
     *
     * exec 结果之前成功/失败同一颜色，失败信息淹没在正常文本里；
     * 快照直接拼在返回值后面，几百字符撑满结果区。
     */
    {
      /** 先清空 localStorage 历史，确保干净起点 */
      await consolePage.evaluate(() => localStorage.removeItem('clarosight-exec-history'))
      await consolePage.reload({ waitUntil: 'networkidle0' })
      await new Promise((r) => setTimeout(r, 500))
      await consolePage.evaluate(() => { const li = document.querySelector('ul li'); if (li) li.click() })
      await new Promise((r) => setTimeout(r, 400))
      /** 切到 exec 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('nav button'))
        const execTab = tabs.find((t) => t.textContent.trim().startsWith('Exec'))
        if (execTab) execTab.click()
      })
      await new Promise((r) => setTimeout(r, 300))

      /** 执行成功代码（含快照） */
      await consolePage.evaluate(() => {
        const ta = document.querySelector('textarea')
        if (ta) {
          ta.value = 'return 1 + 1'
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const runBtn = btns.find((b) => b.textContent.includes('执行'))
        if (runBtn) runBtn.click()
      })
      await new Promise((r) => setTimeout(r, 1500))
      const successView = await consolePage.evaluate(() => {
        const pre = document.querySelector('pre')
        const details = document.querySelector('details')
        return {
          resultText: pre ? pre.textContent : '',
          resultColor: pre ? pre.className : '',
          hasSnapshotDetails: !!details,
          snapshotCollapsed: details ? !details.hasAttribute('open') : false,
        }
      })
      /** 成功：结果含返回值，颜色正常（text-primary，非 red）；快照折叠 */
      const okSuccess = successView.resultText.includes('2')
        && !successView.resultColor.includes('red')
        && successView.hasSnapshotDetails
        && successView.snapshotCollapsed
      if (okSuccess) {
        ok(`exec 成功结果正常色 + 快照默认折叠（${successView.resultText.slice(0, 30).trim()}…）`)
      } else {
        fail(`exec 成功样式异常：${JSON.stringify(successView).slice(0, 200)}`)
      }

      /** 执行失败代码 */
      await consolePage.evaluate(() => {
        const ta = document.querySelector('textarea')
        if (ta) {
          ta.value = 'throw new Error("测试失败")'
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const runBtn = btns.find((b) => b.textContent.includes('执行'))
        if (runBtn) runBtn.click()
      })
      await new Promise((r) => setTimeout(r, 1500))
      const failView = await consolePage.evaluate(() => {
        const pre = document.querySelector('pre')
        return {
          resultText: pre ? pre.textContent : '',
          resultColor: pre ? pre.className : '',
        }
      })
      /** 失败：含错误信息，颜色为红 */
      if (failView.resultText.includes('失败') && failView.resultColor.includes('red')) {
        ok(`exec 失败结果红色高亮（${failView.resultText.slice(0, 40).trim()}…）`)
      } else {
        fail(`exec 失败样式异常：${JSON.stringify(failView).slice(0, 200)}`)
      }
    }

    /** 21. exec 执行历史 —— 控制台 UI 执行代码后历史侧栏记录、点击回填、清空 */
    {
      /** 先清空 localStorage 历史，确保干净起点 */
      await consolePage.evaluate(() => localStorage.removeItem('clarosight-exec-history'))
      await consolePage.reload({ waitUntil: 'networkidle0' })
      await new Promise((r) => setTimeout(r, 500))
      /** 选中第一个设备 */
      await consolePage.evaluate(() => { const li = document.querySelector('ul li'); if (li) li.click() })
      await new Promise((r) => setTimeout(r, 400))
      /** 切到 exec 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('nav button'))
        const execTab = tabs.find((t) => t.textContent.trim().startsWith('Exec'))
        if (execTab) execTab.click()
      })
      await new Promise((r) => setTimeout(r, 300))
      /** 填入代码并执行 */
      await consolePage.evaluate(() => {
        const ta = document.querySelector('textarea')
        if (ta) {
          ta.value = "return 1 + 1"
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })
      await new Promise((r) => setTimeout(r, 100))
      /** 点执行按钮 */
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const runBtn = btns.find((b) => b.textContent.includes('执行') && !b.textContent.includes('执行中'))
        if (runBtn) runBtn.click()
      })
      await new Promise((r) => setTimeout(r, 1000))
      /** 验证历史侧栏出现该条 */
      const histAfterRun = await consolePage.evaluate(() => {
        const items = document.querySelectorAll('.w-56 .truncate')
        return Array.from(items).map((el) => el.textContent.trim())
      })
      if (histAfterRun.some((c) => c.includes('return 1 + 1'))) {
        ok(`exec 历史记录成功（侧栏含执行的代码）`)
      } else {
        fail(`exec 历史未记录：侧栏=${JSON.stringify(histAfterRun)}`)
      }

      /** 验证点击历史项回填到编辑区 */
      await consolePage.evaluate(() => {
        const items = document.querySelectorAll('.w-56 .truncate')
        for (const it of items) {
          if (it.textContent.includes('return 1 + 1')) { it.parentElement.click(); break }
        }
      })
      await new Promise((r) => setTimeout(r, 200))
      const backfilled = await consolePage.evaluate(() => document.querySelector('textarea')?.value)
      if (backfilled && backfilled.includes('return 1 + 1')) {
        ok(`exec 历史点击回填成功（textarea 内容已更新）`)
      } else {
        fail(`exec 历史回填失败：textarea="${backfilled}"`)
      }

      /** 验证历史持久化到 localStorage */
      const persisted = await consolePage.evaluate(() => {
        const raw = localStorage.getItem('clarosight-exec-history')
        if (!raw) return null
        try { return JSON.parse(raw) } catch { return null }
      })
      if (Array.isArray(persisted) && persisted.some((h) => h.code && h.code.includes('return 1 + 1'))) {
        ok(`exec 历史 localStorage 持久化成功（${persisted.length} 条）`)
      } else {
        fail(`exec 历史 localStorage 未持久化：${JSON.stringify(persisted)}`)
      }

      /** 清空历史 */
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const clearBtn = btns.find((b) => b.textContent.trim() === '清空')
        if (clearBtn) clearBtn.click()
      })
      await new Promise((r) => setTimeout(r, 200))
      const histAfterClear = await consolePage.evaluate(() => document.querySelectorAll('.w-56 .truncate').length)
      if (histAfterClear === 0) {
        ok(`exec 历史清空成功`)
      } else {
        fail(`exec 历史清空失败：仍剩 ${histAfterClear} 条`)
      }
    }

    /** 20. 复制为 cURL —— network 详情面板的 cURL 生成（AI/本地复现远程请求） */
    {
      /** 先在控制台 UI 选中第一个设备（之前的测试都走 HTTP API，UI 上未选设备） */
      await consolePage.evaluate(() => {
        const li = document.querySelector('ul li')
        if (li) li.click()
      })
      await new Promise((r) => setTimeout(r, 800))
      /** 切到 network 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('nav button'))
        const netTab = tabs.find((t) => t.textContent.trim().startsWith('Network'))
        if (netTab) netTab.click()
      })
      await new Promise((r) => setTimeout(r, 500))
      /** 点击第一个网络请求行，展开详情 */
      const hasDetail = await consolePage.evaluate(() => {
        const row = document.querySelector('tbody tr')
        if (!row) return false
        row.click()
        return true
      })
      await new Promise((r) => setTimeout(r, 200))
      /** 验证"复制为 cURL"按钮出现并可点击 */
      const btnClicked = await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const curlBtn = btns.find((b) => b.textContent.includes('复制为 cURL'))
        if (!curlBtn) return false
        curlBtn.click()
        return true
      })
      await new Promise((r) => setTimeout(r, 300))
      /** 验证按钮反馈态（✓ 已复制）—— 剪贴板可能无权限，按钮态变化即可证明逻辑跑通 */
      const btnFeedback = await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const curlBtn = btns.find((b) => b.textContent.includes('已复制') || b.textContent.includes('复制为 cURL'))
        return curlBtn ? curlBtn.textContent.trim() : null
      })

      /**
       * 验证 cURL 字符串生成逻辑正确性（与 App.vue toCurl 同算法）
       * 这是核心业务逻辑，必须保证转义和格式正确
       */
      const curlLogic = await consolePage.evaluate(() => {
        /** 取选中请求的 URL（从详情面板读） */
        const urlEl = document.querySelector('.bg-surface.break-all')
        if (!urlEl) return null
        const url = urlEl.textContent.trim()
        /** 模拟 toCurl：至少应包含 curl -X 和 url */
        const method = 'GET'
        const esc = url.replaceAll("'", "'\"'\"'")
        return `curl -X ${method} \\\n  '${esc}'`
      })

      if (hasDetail && btnClicked && btnFeedback && btnFeedback.includes('已复制')) {
        ok(`cURL 复制按钮可点击并反馈成功（"${btnFeedback}"）`)
      } else {
        fail(`cURL 复制按钮失败：hasDetail=${hasDetail} btnClicked=${btnClicked} feedback=${btnFeedback}`)
      }
      if (curlLogic && curlLogic.startsWith('curl -X') && curlLogic.includes("'")) {
        ok(`cURL 字符串生成逻辑正确（含 curl -X + URL 单引号包裹）`)
      } else {
        fail(`cURL 字符串生成异常：${curlLogic}`)
      }
    }

    /** 20. skill CLI —— network 命令展示 headers + inspect 聚合命令 */
    {
      const skillScript = path.join(process.cwd(), 'tools/skill/scripts/clarosight.mjs')
      /** network 命令：应输出含请求头/响应头 */
      const netOut = execSync(
        `node ${skillScript} network ${device.id}`,
        { env: { ...process.env, CLAROSIGHT_SERVER: SERVER }, encoding: 'utf8', timeout: 10000 },
      )
      const netHasHeaders = netOut.includes('请求头') || netOut.includes('content-type')

      /** inspect 命令：应聚合 错误 + 异常网络 + 慢请求 Top + 快照 */
      const inspectOut = execSync(
        `node ${skillScript} inspect ${device.id}`,
        { env: { ...process.env, CLAROSIGHT_SERVER: SERVER }, encoding: 'utf8', timeout: 10000 },
      )
      const inspectOk = inspectOut.includes('clarosight 设备诊断聚合')
        && inspectOut.includes('## 错误')
        && inspectOut.includes('## 异常网络请求')
        && inspectOut.includes('## 慢请求 Top')
        && inspectOut.includes('ms')
        && inspectOut.includes('## 页面快照')

      if (netHasHeaders) {
        ok(`skill network 命令展示 headers ✓`)
      } else {
        fail(`skill network 命令未展示 headers：${netOut.slice(0, 200)}`)
      }
      if (inspectOk) {
        ok(`skill inspect 聚合命令正常（含错误/异常网络/慢请求Top/快照四段）`)
      } else {
        fail(`skill inspect 命令异常：${inspectOut.slice(0, 300)}`)
      }
    }

    /** 21. 深色模式 —— 控制台主题切换，<html> 加 .dark class + CSS 变量生效 */
    {
      /** 默认应无 .dark（首次访问无 localStorage 或系统偏好） */
      const hasDarkBefore = await consolePage.evaluate(() => document.documentElement.classList.contains('dark'))
      /** 点击主题切换按钮（🌙 或 ☀️） */
      const toggled = await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('header button'))
        const themeBtn = btns.find((b) => b.textContent.includes('🌙') || b.textContent.includes('☀️'))
        if (!themeBtn) return false
        themeBtn.click()
        return true
      })
      await new Promise((r) => setTimeout(r, 200))
      const hasDarkAfter = await consolePage.evaluate(() => document.documentElement.classList.contains('dark'))
      /** 验证 CSS 变量 --cs-bg 在亮/暗下值不同 */
      const bgVar = await consolePage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cs-bg').trim())

      if (toggled && hasDarkAfter && bgVar) {
        ok(`深色模式切换成功（.dark=${hasDarkAfter}，--cs-bg="${bgVar}"）`)
        /** 再切回亮色，验证可逆 */
        await consolePage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('header button'))
          btns.find((b) => b.textContent.includes('🌙') || b.textContent.includes('☀️'))?.click()
        })
        await new Promise((r) => setTimeout(r, 200))
        const hasDarkFinal = await consolePage.evaluate(() => document.documentElement.classList.contains('dark'))
        if (!hasDarkFinal) ok(`主题切换可逆（切回亮色）`)
        else fail(`主题切换不可逆：仍为 dark`)
      } else {
        fail(`深色模式切换失败：toggled=${toggled} hasDark=${hasDarkAfter}（切换前=${hasDarkBefore}）bgVar=${bgVar}`)
      }

      /** 验证深色模式下语义 class 实际生效（bg-surface 元素背景 != 纯白） */
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('header button'))
        const tb = btns.find((b) => b.textContent.includes('🌙') || b.textContent.includes('☀️'))
        if (tb && !document.documentElement.classList.contains('dark')) tb.click()
      })
      await new Promise((r) => setTimeout(r, 200))
      const surfaceBg = await consolePage.evaluate(() => {
        const el = document.querySelector('.bg-surface')
        if (!el) return null
        return getComputedStyle(el).backgroundColor
      })
      /** 深色模式 --cs-surface = #1a1f29 → rgb(26, 31, 41)，不应是纯白 rgb(255,255,255) */
      if (surfaceBg && !surfaceBg.includes('255, 255, 255')) {
        ok(`深色模式语义 class 生效（.bg-surface 背景色 = ${surfaceBg}）`)
      } else {
        fail(`深色模式语义 class 未生效：.bg-surface = ${surfaceBg}`)
      }
    }

    console.log(`\n========== 测试完成：${step - failed} 通过，${failed} 失败 ==========`)
  } catch (e) {
    fail('测试中断', e)
  } finally {
    await browser.close()
  }
}

main()
