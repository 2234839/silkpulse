/**
 * 后注入场景端到端验证 —— SDK 在 Vue app 完全启动之后才注入
 *
 * 场景还原（对应 examples/post-inject-test.html）：
 *   1. 页面用 Vue 生产构建（vue.global.prod.js）渲染——模拟线上编译后的应用
 *      （prod 无 devtools 事件、app._instance 缺失，是最严苛场景）
 *   2. HTML 不含 sdk.js——等 window.__TEST_PAGE_READY__（app.mount 完成）后
 *      动态注入 <script src="/sdk.js">，即「后注入」
 *   3. 验证 recoverExistingVueApps 补注册后整条 DevTools 链路可用：
 *      available 探测 → 组件树 → inspect 组件状态 → set 改 state 生效
 *
 * 运行：node scripts/post-inject-test.mjs（需 8080 server 在跑）
 */
import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const SERVER = process.env.SILKPULSE_SERVER ?? 'http://localhost:8080'
const ADMIN_KEY = process.env.SILKPULSE_ADMIN_KEY ?? '9bc0af165928751a919613f607a2de17247c9237c0a18d24'

const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
let passed = 0
let failed = 0
function ok(msg) { passed++; console.log(`${PASS} ${msg}`) }
function fail(msg, detail = '') { failed++; console.error(`${FAIL} ${msg}`, detail) }

/** 带鉴权 API fetch */
async function api(path, init = {}) {
  return fetch(`${SERVER}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

/** 在指定设备上 exec 代码（server 转 WS 到设备页执行；路径参数形式 /api/devices/:id/exec）
 *  exec 的 result 是 SuperJSON 序列化字符串，resultValue.preview 也有简版——优先 JSON.parse(result) */
async function execOn(deviceId, code) {
  const res = await api(`/api/devices/${deviceId}/exec`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
  const data = await res.json()
  if (!data.success) throw new Error(`exec 失败: ${JSON.stringify(data).slice(0, 300)}`)
  /** devtools 函数返回 Promise：exec-runner 会 await 后再序列化 */
  try {
    return data.result != null ? JSON.parse(data.result) : data.resultValue ?? null
  } catch {
    return data.resultValue?.preview ?? data.result ?? null
  }
}

function detectChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  for (const name of ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable']) {
    try {
      const found = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf8' }).trim()
      if (found && fs.existsSync(found)) return found
    } catch {}
  }
  console.error('未找到 chromium，请设置 CHROMIUM_PATH')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等设备注册到 server（带超时）；设备列表项字段是 id/url/title */
async function waitDevice(titleHint, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const data = await (await api('/api/devices')).json()
    const dev = (data.devices ?? []).find((d) => !titleHint || (d.title ?? d.url ?? '').includes(titleHint))
    if (dev) return dev
    await sleep(500)
  }
  return null
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: detectChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })

  /** 1. 打开生产 Vue 页面（无 SDK） */
  await page.goto(`${SERVER}/post-inject-test.html`, { waitUntil: 'networkidle0' })
  const vueMounted = await page.evaluate(() => ({
    ready: window.__TEST_PAGE_READY__ === true,
    /** 生产构建关键锚点：根容器上的 __vue_app__（apiCreateApp.ts 无条件挂载） */
    hasVueAppAnchor: !!document.querySelector('#app')?.__vue_app__,
    /** 此刻页面还没有任何 devtools hook——后注入的起点状态 */
    noVueHook: !window.__VUE_DEVTOOLS_GLOBAL_HOOK__,
    rendered: document.querySelector('.counter')?.textContent?.trim(),
  }))
  vueMounted.ready && vueMounted.hasVueAppAnchor && vueMounted.noVueHook
    ? ok(`生产 Vue 页面已启动（counter=${vueMounted.rendered}），无 devtools hook，DOM 锚点 __vue_app__ 在场`)
    : fail('生产 Vue 页面启动状态异常', JSON.stringify(vueMounted))

  /** 2. 动态注入 SDK（后注入时刻） */
  await page.evaluate((origin) => {
    const s = document.createElement('script')
    s.src = `${origin}/sdk.js`
    s.dataset.server = origin
    s.dataset.apiKey = 'post-inject-test'
    document.head.appendChild(s)
  }, SERVER)

  /** 等 SDK 连上 server：设备列表出现新设备（按页面 title 匹配，避开压测残留设备） */
  const dev = await waitDevice('后注入测试页', 15000)
  if (!dev) { fail('SDK 后注入后未注册到 server'); await browser.close(); process.exit(1) }
  ok(`SDK 后注入成功，设备已注册：${dev.title ?? ''} (${dev.id})`)

  /** 等 recoverExistingVueApps 完成（initVueDevToolsBridge 同步跑一次 + hook apps 注册是同步链） */
  await sleep(1500)
  const device = dev.id

  /** 3. available 探测：恢复后应报 vue:true */
  const avail = await execOn(device, `__silkpulse_devtools_available()`)
  avail?.vue === true
    ? ok(`available 探测正确：vue=${avail.vue}, react=${avail.react}`)
    : fail('available 探测未识别出 Vue（恢复失败？）', JSON.stringify(avail).slice(0, 300))

  /** 4. 组件树：后注入恢复的核心验证——纯拉模式现场遍历，应立即完整 */
  const tree = await execOn(device, `__silkpulse_devtools_tree()`)
  const treeJson = JSON.stringify(tree ?? {})
  const hasApp = treeJson.includes('ProdApp')
  const hasUserCard = treeJson.includes('UserCard')
  hasApp && hasUserCard
    ? ok(`组件树恢复完整：ProdApp 根 + UserCard 子组件都在（${treeJson.length} bytes）`)
    : fail('组件树缺少预期组件', treeJson.slice(0, 500))

  /** 5. inspect：读 counter 组件的 setup state（prod 构建的 _container 兜底链路） */
  const idx = await execOn(device, `__silkpulse_ensureIdx(document.getElementById('inc-btn'))`)
  const insp = await execOn(device, `__silkpulse_devtools_inspect(${idx})`)
  const inspJson = JSON.stringify(insp ?? {})
  inspJson.includes('count') && (inspJson.includes('42') || inspJson.includes('userName'))
    ? ok(`inspect 读取成功：包含 setup state（count/userName 等）`)
    : fail('inspect 未读到组件 state', inspJson.slice(0, 500))

  /** 6. set：后注入场景写 state → 响应式更新生效（UI 同步变化） */
  const setResult = await execOn(device, `__silkpulse_devtools_set(${idx}, 'state', ['count'], 100)`)
  await sleep(300)
  const counterText = await page.evaluate(() => document.querySelector('.counter')?.textContent?.trim())
  setResult?.success === true && counterText === '100'
    ? ok(`set 写 state 生效：count 42 → ${counterText}，UI 已响应式更新`)
    : fail('set 后 UI 未更新', `result=${JSON.stringify(setResult.data).slice(0, 200)} counter=${counterText}`)

  /** 7. 后续增量：恢复后再点按钮（onCommit 等价物）——树仍可用 */
  await page.click('#inc-btn')
  await sleep(300)
  const counterAfterClick = await page.evaluate(() => document.querySelector('.counter')?.textContent?.trim())
  counterAfterClick === '101'
    ? ok(`恢复后交互正常：点击 +1 后 count=${counterAfterClick}（后续事件流不受影响）`)
    : fail('恢复后点击异常', `counter=${counterAfterClick}`)

  /** 8. 动态 mount 补扫验证：5s 补扫应捡起新 mount 的 app */
  await page.evaluate(() => {
    const { createApp, ref } = window.Vue
    const el = document.createElement('div')
    el.id = 'late-app'
    document.body.appendChild(el)
    window.__LATE_APP__ = createApp({
      name: 'LateApp',
      setup: () => { const n = ref(7); return { n } },
      template: '<div class="late">{{ n }}</div>',
    }).mount(el)
  })
  /** 补扫周期 5s，等 6s 确保触发 */
  await sleep(6200)
  const tree2 = await execOn(device, `__silkpulse_devtools_tree()`)
  const tree2Json = JSON.stringify(tree2 ?? {})
  tree2Json.includes('LateApp')
    ? ok(`5s 补扫生效：动态 mount 的 LateApp 已进组件树`)
    : fail('动态 mount 的 app 未被补扫捡起', tree2Json.slice(0, 400))

  await browser.close()

  console.log(`\n${'='.repeat(50)}`)
  console.log(`后注入验证结果：${passed} 通过 / ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error('测试执行异常:', e); process.exit(1) })
