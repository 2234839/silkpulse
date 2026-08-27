/**
 * 真实 React vite build 产物验证（React 18.3.1 ESM prod minified）
 *
 * 与手写 UMD 测试页的本质差异：
 * 1. ESM 模块作用域——window.React / react-dom 全局不存在
 *    → 后注入恢复时 dispatcherRef 探测（靠全局 React）拿不到
 *    → 先注入时 react-dom 求值同步 inject 进 stub（真实 renderer 含
 *      currentDispatcherRef，ESM 下 react-dom 内部仍有），不受影响
 * 2. frameworks 时序——ESM chunk 异步加载，先注入时 React root 创建晚于 SDK
 * 3. minify 后 displayName 不可用（匿名函数组件）——树节点名走兜底路径
 *
 * 两个页面：
 * - react-vite-post.html：head 里带 sdk.js script（先注入）
 * - react-vite-late.html：不带（后注入，测试脚本动态插 SDK）
 */
import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const SERVER = process.env.SILKPULSE_SERVER ?? 'http://localhost:8080'
const KEY = process.env.SILKPULSE_ADMIN_KEY
/** 游客/项目密钥——鉴权部署下设备接入用（714a2bc 后必须自持密钥） */
const PLAYGROUND_KEY = process.env.SILKPULSE_PLAYGROUND_KEY ?? ''

async function execOn(devId, code) {
  const res = await fetch(`${SERVER}/api/devices/${devId}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ code }),
  })
  /** HTTP 响应：{ success, result: JSON字符串, resultValue, ... } */
  const j = await res.json()
  if (j.result?.error) throw new Error(String(j.result.error))
  const raw = j.result
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return raw }
}

async function findDevice(urlPart) {
  const d = await (await fetch(`${SERVER}/api/devices`, { headers: { authorization: `Bearer ${KEY}` } })).json()
  return d.devices?.find((x) => x.url?.includes(urlPart))
}

let chrom = process.env.CHROMIUM_PATH
if (!chrom) for (const n of ['chromium-browser', 'chromium', 'google-chrome']) {
  try { const f = execSync(`which ${n} 2>/dev/null`, { encoding: 'utf8' }).trim(); if (f) { chrom = f; break } } catch {}
}

async function runCase(name, url, preInject) {
  console.log(`\n■ ${name}`)
  const b = await puppeteer.launch({
    executablePath: chrom, headless: true,
    /** --disable-features=LocalNetworkAccessChecks：Chrome 146 拦截 mock 文档
     *  发起的 ws://localhost 连接（ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS） */
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=LocalNetworkAccessChecks', `--user-data-dir=${path.join(os.homedir(), `snap/chromium/common/tmp-profiles/rv-${Date.now()}`)}`],
  })
  const page = await b.newPage()
  let pass = 0, failCount = 0
  const ok = (m) => { pass++; console.log(`  ✓ ${m}`) }
  const fail = (m, d = '') => { failCount++; console.log(`  ✗ ${m}${d ? ' ' + d : ''}`) }
  try {
    if (preInject) {
      /** 先注入：react-vite-post.html 静态页内嵌的 sdk script 无法携带密钥
       *  （密钥不能进仓库/产物），拦截文档响应、给 <script src="/sdk.js"> 标签
       *  补上 data-api-key/data-project-id（714a2bc 后设备接入必须自持密钥），
       *  SDK 仍由页面自身在 document_start 语义下加载——先注入时序不变。 */
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        const proceed = () => { req.continue({ headers: req.headers() }).catch(() => {}) }
        if (req.resourceType() === 'document' && req.url().includes('react-vite-post')) {
          /** 用 fetch 拿原始 HTML，改写后 mock 响应（request.response() 在
           *  continue 前为 null，不可用） */
          fetch(req.url())
            .then((res) => res.text())
            .then((html) => {
              const patched = html.replace(
                '<script src="/sdk.js" data-server="http://localhost:8080"></script>',
                `<script src="/sdk.js" data-server="${SERVER}"${PLAYGROUND_KEY ? ` data-api-key="${PLAYGROUND_KEY}" data-project-id="cs_playground"` : ''}></script>`,
              )
              req.respond({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: patched }).catch(() => {})
            })
            .catch(proceed)
        } else {
          proceed()
        }
      })
      await page.goto(url, { waitUntil: 'networkidle0' })
    } else {
      await page.goto(url, { waitUntil: 'networkidle0' })
      await page.evaluate((origin, apiKey) => {
        const s = document.createElement('script')
        s.src = `${origin}/sdk.js`
        s.dataset.server = origin
        if (apiKey) {
          s.dataset.apiKey = apiKey
          s.dataset.projectId = 'cs_playground'
        }
        document.head.appendChild(s)
      }, SERVER, PLAYGROUND_KEY)
    }
    /** 等设备注册 */
    let dev = null
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      dev = await findDevice(url.split('/').pop())
      if (dev) break
    }
    if (!dev) { fail('设备未注册'); return { pass, fail: failCount } }
    ok(`设备注册 (${dev.id}) frameworks=${JSON.stringify(dev.frameworks)}`)
    if (!dev.frameworks?.includes('react')) { fail('frameworks 未含 react'); return { pass, fail: failCount } }
    ok('frameworks 探测到 react（自适应重报生效）')

    /** 等 bridge 恢复/激活（先注入要等 root 创建，后注入要等恢复扫描） */
    await new Promise((r) => setTimeout(r, 4000))

    const avail = await execOn(dev.id, `return __silkpulse_devtools_available()`)
    avail?.react === true ? ok('available: react=true') : fail('available 失败', JSON.stringify(avail ?? null))

    const tree = await execOn(dev.id, `return __silkpulse_devtools_tree()`)
    const tj = JSON.stringify(tree ?? {})
    /** prod minified 名字是压缩后的（Sd/wd）——官方 React DevTools 同样，
     * 断言树结构非空 + 有层级（children），不检查源码名 */
    const nodes = tree?.tree ?? []
    const hasNesting = nodes.length > 0 && nodes.some((n) => (n.children?.length ?? 0) > 0)
    hasNesting
      ? ok(`组件树完整（${nodes.length} 根节点含子层级，prod minified 名）`)
      : fail('组件树缺失', tj.slice(0, 300))

    const idx = await execOn(dev.id, `return __silkpulse_ensureIdx(document.querySelector('#inc-btn'))`)
    const insp = await execOn(dev.id, `return __silkpulse_devtools_inspect(${idx})`)
    const ij = JSON.stringify(insp ?? {})
    /** 先注入：走 backend 重放（isStateEditable=true + value）；
     *  后注入 ESM：#321 fallback 静态解析（state hook 的 lastRenderedState + props） */
    const replayOk = ij.includes('"isStateEditable":true') && /"value":\d+/.test(ij)
    const staticOk = /"name":"state"/.test(ij) && /"value":\d+/.test(ij)
    if (replayOk) ok('inspect hooks 完整（backend 重放路径）')
    else if (staticOk) ok('inspect hooks 完整（#321 静态解析 fallback）')
    else fail('inspect hooks 异常', ij.slice(0, 300))

    const setRes = await execOn(dev.id, `return __silkpulse_devtools_set(${idx}, 'hooks', [], 100, 0)`)
    setRes?.error
      ? ok(`set 如实报告受限（prod 预期）：${String(setRes.error).slice(0, 50)}`)
      : setRes?.success ? ok('set 成功（意外但可接受）') : fail('set 返回异常', JSON.stringify(setRes ?? null).slice(0, 200))

    const before = await execOn(dev.id, `return document.querySelector('.counter')?.textContent?.trim()`)
    const click = await execOn(dev.id, `return (() => {
      const btn = document.querySelector('#inc-btn')
      if (!btn) return 'btn-not-found'
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return 'clicked'
    })()`)
    await new Promise((r) => setTimeout(r, 500))
    const after = await execOn(dev.id, `return document.querySelector('.counter')?.textContent?.trim()`)
    click === 'clicked' && Number(after) === Number(before) + 1
      ? ok(`恢复后交互正常：${before} → ${after}`)
      : fail('点击异常', `click=${click} ${before} → ${after}`)
  } finally {
    await b.close()
  }
  return { pass, fail: failCount }
}

const r1 = await runCase('真实 React vite build + 先注入（ESM chunk 异步 + stub 提前就位）', `${SERVER}/react-vite-post.html`, true)
const r2 = await runCase('真实 React vite build + 后注入（无全局 React，dispatcherRef 探测受限）', `${SERVER}/react-vite-late.html`, false)
console.log(`\n结果：${r1.pass + r2.pass} 通过 / ${r1.fail + r2.fail} 失败`)
process.exit(r1.fail + r2.fail > 0 ? 1 : 0)
