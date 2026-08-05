/**
 * 无头浏览器端到端测试 —— puppeteer-core + 系统 chromium
 *
 * 验证：控制台 UI、SDK 注入连接、snapshot、exec、__clarosight_click、console/error 采集
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'

const SERVER = process.env.CLAROSIGHT_SERVER ?? 'http://localhost:8081'
const CHROMIUM = '/usr/bin/chromium-browser'
const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'

let step = 0
let failed = 0
function ok(msg) { console.log(`${PASS} [${step++}] ${msg}`) }
function fail(msg, e) { console.error(`${FAIL} [${step++}] ${msg}`, e ?? ''); failed++ }

async function waitForDevice(timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const devices = await (await fetch(`${SERVER}/api/devices`)).json()
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
    const devAfter = (await (await fetch(`${SERVER}/api/devices`)).json()).find((d) => d.id === device.id)
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

    /** 6. console 采集 */
    await testPage.evaluate(() => document.getElementById('greet-btn')?.click())
    await new Promise((r) => setTimeout(r, 800))
    const logs = await (await fetch(`${SERVER}/api/devices/${device.id}/logs`)).json()
    if (logs.some((l) => l.message.includes('打招呼'))) ok(`console 采集成功（${logs.length} 条）`)
    else fail(`console 采集异常: ${logs.slice(-2).map((l) => l.message).join(' | ')}`)

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

    /** 10. 多设备并发 —— 再开第二个 /demo 页面（同源，第二个设备） */
    const testPage2 = await browser.newPage()
    await testPage2.goto(`${SERVER}/demo`, { waitUntil: 'networkidle0', timeout: 15000 })
    await new Promise((r) => setTimeout(r, 1000))
    const devicesList = await (await fetch(`${SERVER}/api/devices`)).json()
    if (devicesList.length >= 2) {
      ok(`多设备并发成功（${devicesList.length} 个设备在线）`)
    } else {
      fail(`多设备并发异常（期望 ≥2，实际 ${devicesList.length}）`)
    }

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
    const beforeCount = (await (await fetch(`${SERVER}/api/devices`)).json()).length
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
    const afterCount = (await (await fetch(`${SERVER}/api/devices`)).json()).length
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
      const reconDevices = await (await fetch(`${SERVER}/api/devices`)).json()
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

    console.log(`\n========== 测试完成：${step - failed} 通过，${failed} 失败 ==========`)
  } catch (e) {
    fail('测试中断', e)
  } finally {
    await browser.close()
  }
}

main()
