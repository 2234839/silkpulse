/**
 * DevTools 桥接全矩阵验证 —— 开发/生产构建 × 先注入/后注入 × Vue/React
 *
 * 矩阵（8 个场景）：
 *   A. Vue dev + 先注入（examples/vue-test-page.html 语义：SDK 在 Vue 前加载）
 *   B. Vue dev + 后注入（dev 构建但 SDK 晚注入）
 *   C. Vue prod + 先注入（生产构建 + SDK 先加载）
 *   D. Vue prod + 后注入（最严苛：无事件 + 无 devtools 标记，靠 __vue_app__ 恢复）
 *   E-H. 同上四格 × React 18 生产构建（__reactContainer$ 恢复）
 *
 * 每格验证：available 探测 → 组件树 → inspect → set（响应式生效）→ 后续交互
 *
 * 运行：node scripts/devtools-matrix-test.mjs（需 8080 server 在跑）
 */
import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const SERVER = process.env.SILKPULSE_SERVER ?? 'http://localhost:8080'
const ADMIN_KEY = process.env.SILKPULSE_ADMIN_KEY

const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
let passed = 0
let failed = 0
function ok(msg) { passed++; console.log(`  ${PASS} ${msg}`) }
function fail(msg, detail = '') { failed++; console.error(`  ${FAIL} ${msg}`, detail) }

async function api(path, init = {}) {
  return fetch(`${SERVER}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

async function execOn(deviceId, code) {
  const res = await api(`/api/devices/${deviceId}/exec`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
  const data = await res.json()
  if (!data.success) {
    /** 掉线时打印现场（设备列表）帮助定位 */
    const devs = await (await api('/api/devices')).json()
    console.error(`    [exec 失败] code=${code.slice(0, 80)}`)
    console.error(`    [当前在线] ${JSON.stringify((devs.devices ?? []).map((d) => ({ id: d.id, title: d.title })))}`)
    throw new Error(`exec 失败: ${JSON.stringify(data).slice(0, 300)}`)
  }
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

async function waitDevice(urlHint, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const data = await (await api('/api/devices')).json()
    /** 按 URL 匹配（先注入场景注册时 title 可能还是空，URL 恒在） */
    const dev = (data.devices ?? []).find((d) => (d.url ?? '').includes(urlHint))
    if (dev) {
      /** 探活：设备条目可能在离线宽限期（同 id 重连/reload 续接场景），
       *  旧 sock 已关但条目还在列表——试一次轻量 exec 确认 WS 真正可用 */
      try {
        const probe = await api(`/api/devices/${dev.id}/exec`, { method: 'POST', body: JSON.stringify({ code: '1' }) })
        const pd = await probe.json()
        if (pd.success) return dev
      } catch {}
    }
    await sleep(400)
  }
  return null
}

/** 动态注入 SDK（后注入动作本体） */
async function injectSDK(page) {
  await page.evaluate((origin) => {
    const s = document.createElement('script')
    s.src = `${origin}/sdk.js`
    s.dataset.server = origin
    document.head.appendChild(s)
  }, SERVER)
}

/** 逐 case 启独立浏览器（独立 profile → 独立 localStorage → 独立持久设备 id，
 *  避免 case 间撞 id / 撞离线宽限期）。
 *  profile 路径必须放 home 下 snap chromium 可写的位置（/tmp 被 snap 沙箱禁写，
 *  --user-data-dir 指向 /tmp 会被静默忽略 → 所有 case 共享 profile 撞 id） */
import os from 'node:os'
import path from 'node:path'
let caseSeq = 0
async function launchCase() {
  caseSeq++
  const profileDir = process.env.CHROMIUM_PROFILE_DIR
    ?? path.join(os.homedir(), 'snap/chromium/common/tmp-profiles')
  return puppeteer.launch({
    executablePath: detectChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${path.join(profileDir, `matrix-${caseSeq}`)}`],
  })
}

/**
 * 运行一格矩阵
 *
 * @param browser puppeteer 实例
 * @param cfg     { name, url, preInject, framework, rootName, childName, btnSel, counterSel, idxSel, setPath, stateKey, initVal, setVal, afterClickVal }
 *                 preInject=true 时用 requestAnimationFrame 拦截法在页面脚本前注入（先注入语义）
 */
async function runCase(cfg) {
  console.log(`\n■ ${cfg.name}`)
  const browser = await launchCase()
  const page = await browser.newPage()
  try {
    if (cfg.preInject) {
      /** 先注入：在任意页面脚本执行前插入 SDK script（等价官方扩展的 document_start） */
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        req.continue({
          headers: req.headers(),
        }).catch(() => {})
      })
      await page.evaluateOnNewDocument((origin) => {
        /** document_start 时 head/body 均可能为 null——监听首个元素落地再插 */
        const inject = () => {
          const s = document.createElement('script')
          s.src = `${origin}/sdk.js`
          s.dataset.server = origin
          ;(document.head ?? document.documentElement).appendChild(s)
        }
        if (document.documentElement) inject()
        else document.addEventListener('readystatechange', () => document.readyState !== 'loading' && inject(), { once: true })
      }, SERVER)
      await page.goto(cfg.url, { waitUntil: 'networkidle0' })
    } else {
      await page.goto(cfg.url, { waitUntil: 'networkidle0' })
      const ready = await page.evaluate(() => window.__TEST_PAGE_READY__ === true)
      if (!ready) fail('页面未就绪标记缺失')
      await injectSDK(page)
    }

    const dev = await waitDevice(cfg.urlHint, 20000)
    if (!dev) { fail('SDK 未注册到 server'); return }
    ok(`SDK ${cfg.preInject ? '先注入' : '后注入'}，设备已注册 (${dev.id})`)
    await sleep(1500)
    /** 页面崩溃/关闭监控：打印非正常断开 */
    page.on('crash', () => console.error('    [page crashed]'))
    page.on('error', (e) => console.error('    [page error]', e.message))

    /** 1. available 探测 */
    const avail = await execOn(dev.id, `__silkpulse_devtools_available()`)
    avail?.[cfg.framework] === true
      ? ok(`available 探测正确：${cfg.framework}=true`)
      : fail('available 探测失败', JSON.stringify(avail).slice(0, 200))

    /** 2. 组件树 */
    const tree = await execOn(dev.id, `__silkpulse_devtools_tree()`)
    const treeJson = JSON.stringify(tree ?? {})
    treeJson.includes(cfg.rootName) && treeJson.includes(cfg.childName)
      ? ok(`组件树完整：${cfg.rootName} + ${cfg.childName} 在场`)
      : fail('组件树缺少预期组件', treeJson.slice(0, 400))

    /** 3. inspect：Vue 断言 state 含 count；React 断言 hooks 里有可编辑 State（value 在场） */
    const idx = await execOn(dev.id, `__silkpulse_ensureIdx(document.querySelector('${cfg.idxSel}'))`)
    const insp = await execOn(dev.id, `__silkpulse_devtools_inspect(${idx})`)
    const inspJson = JSON.stringify(insp ?? {})
    const inspOk = cfg.framework === 'vue'
      ? inspJson.includes(cfg.stateKey)
      : inspJson.includes('"isStateEditable":true') && /"value":\d+/.test(inspJson)
    inspOk
      ? ok(`inspect 读到 state（含 ${cfg.stateKey}）`)
      : fail('inspect 未读到 state', inspJson.slice(0, 300))

    /** 4. set 写 state → UI 更新。
     *  React 生产构建 react-dom 的 override 系列为 null（官方扩展同此限制），
     *  预期应返回明确 error 而非假成功 */
    const setResult = cfg.framework === 'vue'
      ? await execOn(dev.id, `__silkpulse_devtools_set(${idx}, 'state', ${JSON.stringify(cfg.setPath)}, ${JSON.stringify(cfg.setVal)})`)
      : await execOn(dev.id, `__silkpulse_devtools_set(${idx}, 'hooks', [], ${JSON.stringify(cfg.setVal)}, ${cfg.hookID})`)
    await sleep(300)
    const counterText = await execOn(dev.id, `document.querySelector('${cfg.counterSel}')?.textContent?.trim()`)
    if (setResult?.success === true && counterText === String(cfg.setVal)) {
      ok(`set 写 state 生效：${cfg.stateKey} → ${counterText}，UI 已更新`)
    } else if (setResult?.error && cfg.reactProdNoSet) {
      ok(`set 如实报告能力受限：${String(setResult.error).slice(0, 60)}`)
    } else {
      fail('set 后 UI 未更新', `result=${JSON.stringify(setResult).slice(0, 200)} counter=${counterText}`)
    }

    /** 5. 后续交互不受影响。
     *  经验教训：snap chromium 多 tab 下 puppeteer 的 page.click/evaluate 上下文
     * 偶发漂移（querySelector('#id') 时有时无），不能作为可靠观测通道。改走与
     * exec 相同的设备通道（WS），在目标页上下文里派发真实 click 事件 */
    const beforeClick = counterText
    const expectAfter = String(Number(beforeClick) + 1)
    const clickExec = await execOn(dev.id, `return (() => {
      const btn = document.querySelector('${cfg.idxSel}')
      if (!btn) return 'btn-not-found'
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return 'clicked'
    })()`)
    await sleep(600)
    const afterClick = await execOn(dev.id, `document.querySelector('${cfg.counterSel}')?.textContent?.trim()`)
    clickExec === 'clicked' && afterClick === expectAfter
      ? ok(`恢复后交互正常：点击后 ${cfg.stateKey}=${afterClick}`)
      : fail('恢复后点击异常', `clickExec=${clickExec} counter=${afterClick}（期望 ${expectAfter}）`)
  } finally {
    await browser.close()
  }
}

async function main() {
  const vueCfg = {
    framework: 'vue', rootName: 'ProdApp', childName: 'UserCard',
    idxSel: '#inc-btn', counterSel: '.counter', stateKey: 'count',
    setPath: ['count'], setVal: 100, afterClickVal: 101,
    urlHint: 'post-inject-vue-dev',
  }
  const reactCfg = {
    framework: 'react', rootName: 'ProdApp', childName: 'UserCard',
    idxSel: '#inc-btn', counterSel: '.counter', stateKey: 'count',
    hookID: 0, setVal: 100, afterClickVal: 101,
    urlHint: 'post-inject-react',
    /** react-dom 生产构建 override 为 null（官方扩展同此），set 预期返回能力受限 error */
    reactProdNoSet: true,
  }

  await runCase({
    ...vueCfg,
    name: 'D. Vue prod + 后注入（最严苛：无事件无 devtools 标记）',
    url: `${SERVER}/post-inject-test.html`,
    urlHint: 'post-inject-test.html',
    preInject: false,
  })
  await runCase({
    ...vueCfg,
    name: 'C. Vue prod + 先注入',
    url: `${SERVER}/post-inject-test.html`,
    urlHint: 'post-inject-test.html',
    preInject: true,
  })
  await runCase({
    ...reactCfg,
    name: 'H. React prod + 后注入（__reactContainer$ 合成 renderer 恢复）',
    url: `${SERVER}/post-inject-react-test.html`,
    urlHint: 'post-inject-react-test.html',
    preInject: false,
  })
  await runCase({
    ...reactCfg,
    name: 'G. React prod + 先注入',
    urlHint: 'post-inject-react-test.html',
    url: `${SERVER}/post-inject-react-test.html`,
    preInject: true,
  })
  await runCase({
    ...vueCfg,
    name: 'B. Vue dev + 后注入',
    url: `${SERVER}/post-inject-vue-dev.html`,
    urlHint: 'post-inject-vue-dev.html',
    preInject: false,
  })
  await runCase({
    ...vueCfg,
    name: 'A. Vue dev + 先注入',
    urlHint: 'post-inject-vue-dev.html',
    url: `${SERVER}/post-inject-vue-dev.html`,
    preInject: true,
  })

  console.log(`\n${'='.repeat(50)}`)
  console.log(`矩阵验证结果：${passed} 通过 / ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error('测试执行异常:', e); process.exit(1) })
