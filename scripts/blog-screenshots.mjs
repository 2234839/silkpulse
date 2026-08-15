/**
 * blog-screenshots.mjs —— 独立 puppeteer 脚本：为博客截取控制台面板截图
 *
 * 用法：node scripts/blog-screenshots.mjs
 * 产物：apps/console/public/blog/*.png（deviceScaleFactor=2 高清）
 *
 * 为什么不用集成浏览器：多 tab 下 evaluate 上下文会漂移，
 * 测量值和截图视口对不上，导致截图边缘空白。
 */
import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const OUT = 'apps/console/public/blog'
const BASE = 'http://localhost:8080'
const ADMIN_KEY = process.env.SILKPULSE_ADMIN_KEY || '9bc0af165928751a919613f607a2de17247c9237c0a18d24'

let chrom = process.env.CHROMIUM_PATH
if (!chrom) {
  for (const n of ['chromium-browser', 'chromium', 'google-chrome']) {
    try {
      const f = execSync(`which ${n} 2>/dev/null`, { encoding: 'utf8' }).trim()
      if (f) { chrom = f; break }
    } catch { /* continue */ }
  }
}

/** 等待函数 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 点击 nav tab（徽标元素会 intercept pointer events，绕过用 DOM click） */
async function clickTab(page, label) {
  await page.evaluate((label) => {
    const btns = [...document.querySelectorAll('nav button')]
    btns.find(b => b.textContent?.includes(label))?.click()
  }, label)
}

/** 验证面板内容实际右边界贴住视口右缘（无空白的关键断言） */
async function assertFullWidth(page, name) {
  const geo = await page.evaluate(() => {
    const main = document.querySelector('main')
    const nav = main?.querySelector('nav')
    const mr = main ? Math.round(main.getBoundingClientRect().right) : 0
    const nr = nav ? Math.round(nav.getBoundingClientRect().right) : 0
    return { viewport: innerWidth, mainRight: mr, navRight: nr }
  })
  const ok = geo.viewport - geo.mainRight < 4 && geo.viewport - geo.navRight < 4
  console.log(`  [${name}] viewport=${geo.viewport} main=${geo.mainRight} nav=${geo.navRight} ${ok ? '✓ 满宽' : '✗ 未满宽'}`)
  return ok
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: chrom,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    // ── 1. demo 设备页：接入 + 制造日志/网络/错误数据 ──
    const demo = await browser.newPage()
    await demo.setViewport({ width: 742, height: 895 })
    await demo.goto(`${BASE}/demo`, { waitUntil: 'networkidle0' })
    await sleep(2500)
    await demo.evaluate(() => {
      // 业务感长日志（让 console 面板行饱满）
      console.log('[order#98123] 支付成功 · 3 items · ¥1,298.00 · wxpay · polls=3 · 842ms · gateway=cache-hit')
      console.warn('[inventory] SKU-8890 库存低于安全阈值 · 剩余 2 件 · 已触发自动补货 · ETA 2h')
      console.log('[session] uid=42078 · role=tester · iPhone 15 · Safari 17 · 375×667 · net=5g')
      console.log('[router] navigate /checkout → /order/98123 · guard=auth ✓ · restore scroll=0')
      console.log('[perf] LCP=1.2s FCP=0.8s CLS=0.00 · resource=32 · transfer=412KB · cached=61%')
      // 网络请求
      const ids = ['btn-fetch-ok', 'btn-fetch-404', 'btn-xhr', 'btn-xhr-json', 'btn-post', 'btn-post-req', 'btn-post-form']
      ids.forEach(id => document.getElementById(id)?.click())
      // 错误
      document.getElementById('btn-err-sync')?.click()
      document.getElementById('btn-err-promise')?.click()
    })
    await sleep(2500)

    // ── 2. 控制台页：登录 + 选设备 + 逐面板截图 ──
    const consolePage = await browser.newPage()
    await consolePage.setViewport({ width: 1440, height: 860, deviceScaleFactor: 2 })
    await consolePage.goto(`${BASE}/?key=${ADMIN_KEY}`, { waitUntil: 'networkidle0' })
    await sleep(3000)
    // 选中 demo 设备
    await consolePage.evaluate(() => {
      const item = [...document.querySelectorAll('aside li')].find(li => li.textContent?.includes('demo'))
      item?.click()
    })
    await sleep(2500)

    // Console 面板
    await clickTab(consolePage, 'Console')
    await sleep(1500)
    await assertFullWidth(consolePage, 'console')
    await consolePage.screenshot({ path: `${OUT}/console-panel.png` })

    // Network 面板：点开 401 请求详情
    await clickTab(consolePage, 'Network')
    await sleep(1500)
    await consolePage.evaluate(() => {
      const rows = [...document.querySelectorAll('main table tbody tr')]
      rows.find(r => r.textContent?.includes('404') || r.textContent?.includes('401'))?.click()
    })
    await sleep(1500)
    await assertFullWidth(consolePage, 'network')
    await consolePage.screenshot({ path: `${OUT}/network-panel.png` })

    // Errors 面板：展开一条堆栈
    await clickTab(consolePage, 'Errors')
    await sleep(1500)
    await consolePage.evaluate(() => {
      const groups = [...document.querySelectorAll('main [role="group"], main details')]
      groups[0]?.querySelector('summary')?.click?.()
      groups[0]?.click?.()
    })
    await sleep(1000)
    await assertFullWidth(consolePage, 'errors')
    await consolePage.screenshot({ path: `${OUT}/errors-panel.png` })

    // Snapshot 面板
    await clickTab(consolePage, 'Snapshot')
    await sleep(1500)
    await assertFullWidth(consolePage, 'snapshot')
    await consolePage.screenshot({ path: `${OUT}/snapshot-panel.png` })

    // Exec 面板：执行代码展示返回值
    await clickTab(consolePage, 'Exec')
    await sleep(1200)
    await consolePage.evaluate(() => {
      const ta = document.querySelector('main textarea')
      if (ta) {
        ta.value = "return { title: document.title, url: location.href, viewport: innerWidth + 'x' + innerHeight }"
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    // 用页面内真实键盘事件触发执行（比合成事件可靠）
    await consolePage.keyboard.down('Control')
    await consolePage.keyboard.press('Enter')
    await consolePage.keyboard.up('Control')
    await sleep(2500)
    await assertFullWidth(consolePage, 'exec')
    await consolePage.screenshot({ path: `${OUT}/exec-panel.png` })

    console.log('\n全部截图完成 →', OUT)
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
