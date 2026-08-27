/**
 * snapshot-zoom-verify.mjs —— 独立 puppeteer 验证脚本（后台标签不节流）
 *
 * 验证两件事：
 * 1. 缩放锚定：放大 N 步再缩小回来，同一屏幕锚点下的图像内容点比例不变
 * 2. 整画布拖拽：图片外容器空白区 mousedown 拖动，offset 跟随且 cursor 变化
 *
 * 用法：CHROMIUM_PATH=... node scripts/snapshot-zoom-verify.mjs
 */
import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'

const BASE = 'http://localhost:8080'
const ADMIN_KEY = process.env.SILKPULSE_ADMIN_KEY ?? 'smoke-admin-9x7y'

let chrom = process.env.CHROMIUM_PATH
if (!chrom) {
  for (const n of ['chromium-browser', 'chromium', 'google-chrome']) {
    try {
      const f = execSync(`which ${n} 2>/dev/null`, { encoding: 'utf8' }).trim()
      if (f) { chrom = f; break }
    } catch { /* continue */ }
  }
}
if (!chrom) {
  console.error('找不到 Chrome，请设置 CHROMIUM_PATH')
  process.exit(1)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: chrom,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900 },
})

/** 从 demo 页拿到的 SDK 全局函数是否可达（诊断） */
async function probeSdk(demo) {
  return await demo.evaluate(() => ({
    visibility: document.visibilityState,
    hasShot: typeof window.__silkpulse_screenshot === 'function',
    hasTree: typeof window.__silkpulse_devtools_tree === 'function',
  }))
}

/**
 * 读 img 布局盒 + 当前 transform 反解内容点比例：
 * 给定视口锚点 (ax, ay)（页面像素坐标），算出该锚点命中的图像内容归一化坐标。
 * 内容点固定性断言：缩放前后同锚点的内容比应一致。
 */
function setupHelpers(page) {
  return page.evaluateHandle(() => {
    const fracAt = (ax, ay) => {
      const i = document.querySelector('img[alt="页面快照"]')
      if (!i) return null
      const b = i.getBoundingClientRect()
      // getBoundingClientRect 已含 transform；反推 scale 与 translate 后的仿射原点
      const styleTx = new DOMMatrixReadOnly(getComputedStyle(i).transform)
      const s = Math.hypot(styleTx.a, styleTx.b) || 1
      // transform-origin 默认 center：布局盒中心
      const lb = i.offsetLeft, tb = i.offsetTop // offsetParent 内的布局位置不可靠，改用未变换盒
      // 未变换布局盒：rect 是变换后的。用 scale+translate 反解：
      // rect.center = layoutCenter + t （scale 绕布局中心进行）
      const dispW = b.width, dispH = b.height          // 显示尺寸 = layout * s
      const layoutW = dispW / s, layoutH = dispH / s
      const cx = b.left + b.width / 2 - styleTx.e       // 布局盒中心 x（screen）
      const cy = b.top + b.height / 2 - styleTx.f       // 布局盒中心 y（screen）
      // 屏幕锚点 → 布局盒内归一化坐标
      const fx = (ax - (cx - layoutW / 2)) / layoutW
      const fy = (ay - (cy - layoutH / 2)) / layoutH
      return { fx, fy, s, t: { x: styleTx.e, y: styleTx.f }, layoutW, layoutH }
    }
    return { fracAt }
  })
}

async function main() {
  const ctx = browser.defaultBrowserContext()
  // 控制台页
  const con = await ctx.newPage()
  await con.setViewport({ width: 1400, height: 900 })
  await con.goto(BASE + '/?tab=element', { waitUntil: 'networkidle2' })

  // 登录（localStorage 注入 key 走正常登录流程）
  const hasLogin = await con.evaluate(() =>
    !!document.querySelector('input[type="password"], input:not([type])'))
  if (hasLogin) {
    await con.type('input', ADMIN_KEY)
    await con.click('button')
    await sleep(1200)
  }

  // 等 admin 会话就绪
  await con.waitForFunction(
    () => !document.body.textContent.includes('输入管理密钥'),
    { timeout: 8000 },
  )

  // 等设备出现
  try {
    await con.waitForFunction(
      () => /在线设备 \(\d+\)/.test(document.body.textContent),
      { timeout: 15000 },
    )
  } catch {
    console.error('设备列表未出现在线设备')
    process.exit(2)
  }

  // 打开 demo 页作为被调试端（注入 sdk.js）
  const demo = await ctx.newPage()
  await demo.setViewport({ width: 1149, height: 853 })
  await demo.goto(`${BASE}/demo?apiKey=pg-key-test&projectId=cs_playground`,
    { waitUntil: 'networkidle2' })
  await sleep(2500)

  console.log('demo 页 SDK 探针:', JSON.stringify(await probeSdk(demo)))

  // 控制台选中该设备 → Element tab → 画面 → 快照
  await con.bringToFront()
  await con.evaluate(() => {
    const item = [...document.querySelectorAll('li')].find(el =>
      el.textContent?.includes('silkpulse 测试页'))
    item?.click()
  })
  await sleep(600)
  await con.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    btns.find(b => b.textContent?.trim() === '画面')?.click()
  })
  await sleep(400)
  await con.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.includes('快照'))
    btn?.click()
  })

  let shotOk = true
  try {
    await con.waitForSelector('img[alt="页面快照"]', { timeout: 20000 })
    console.log('✓ 快照已生成')
  } catch {
    shotOk = false
    console.log('✗ 快照超时')
  }

  if (!shotOk) process.exit(3)

  const state = await setupHelpers(con)

  /** 当前几何状态 */
  const geo = () => state.evaluate(h => h.fracAt(700, 450))

  // ─────────────────────────────────────────────
  // 测试 1：缩放锚定 —— 同一屏幕锚点，先放大后缩小
  // ─────────────────────────────────────────────
  console.log('\n== 测试 1：缩放锚定 ==')
  const areaBox = await con.evaluate(() => {
    // 容器 ref 对应 div 没有直接选择器，用 wheel 目标即 img 的父级 flex 容器
    const img = document.querySelector('img[alt="页面快照"]')
    // 向上找最近的 overflow-hidden 容器（事件宿主）
    let el = img.parentElement
    while (el && !el.className.includes('overflow-hidden')) el = el.parentElement
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
  // 锚点选容器内的一个非中心点，暴露所有平移项错误
  const ax = areaBox.left + areaBox.width * 0.72
  const ay = areaBox.top + areaBox.height * 0.31

  // 记录初始内容比例
  const f0 = await state.evaluate((h, ax, ay) => h.fracAt(ax, ay), ax, ay)
  console.log('初始:', JSON.stringify(f0))

  /** 在绝对屏募坐标滚轮 */
  async function wheelAt(x, y, deltaY, n = 1) {
    for (let k = 0; k < n; k++) {
      await con.mouse.move(x, y)
      await con.mouse.wheel({ deltaY })
      await sleep(220)
    }
  }

  await wheelAt(ax, ay, -240, 3)          // 放大 ×3 步 ≈ 1.15³ ≈ 1.52
  const fIn = await state.evaluate((h, ax, ay) => h.fracAt(ax, ay), ax, ay)
  console.log('放大后:', JSON.stringify(fIn), 'scale=', fIn.s)

  await wheelAt(ax, ay, 240, 3)           // 缩小回 ≈1.0
  const fBack = await state.evaluate((h, ax, ay) => h.fracAt(ax, ay), ax, ay)
  console.log('缩小后:', JSON.stringify(fBack), 'scale=', fBack.s)

  const driftAB = Math.hypot(fBack.fx - f0.fx, fBack.fy - f0.fy)
  console.log(`往返漂移 = ${driftAB.toFixed(6)}（要求 < 0.02）`)
  const anchorFixed = driftAB < 0.02

  // 再来一轮乱序：再放大 2 步、缩小 5 步（穿过 1.0 被 clamp 的场景不做——clamp 属预期）
  await wheelAt(ax, ay, -240, 2)
  await wheelAt(ax, ay, 240, 4)   // 净缩小一步，会 clamp 到 min? 不，1.15²→÷1.15⁴ 会触底
  const fRound2 = await state.evaluate((h, ax, ay) => h.fracAt(ax, ay), ax, ay)
  const driftR2 = Math.hypot(fRound2.fx - f0.fx, fRound2.fy - f0.fy)
  console.log(`含 clamp 往返漂移 = ${driftR2.toFixed(6)}（净变化步触底属预期，仅记录不作为断言失败项）`)

  // ─────────────────────────────────────────────
  // 测试 2：整画布拖拽 —— 图片显示盒之外的容器空白处按下拖动
  // ---------------------------------------------
  console.log('\n== 测试 2：图片外区域拖拽 ==')
  // 先确保 scale > 1：以 img 的实际 transform 为准（fracAt.s 在 clamp 混乱期可能失真）
  let sBefore = await con.evaluate(() => {
    const m = new DOMMatrixReadOnly(getComputedStyle(
      document.querySelector('img[alt="页面快照"]')).transform)
    return Math.hypot(m.a, m.b)
  })
  while (sBefore <= 1.001) {
    await wheelAt(ax, ay, -240, 1)
    sBefore = await con.evaluate(() => {
      const m = new DOMMatrixReadOnly(getComputedStyle(
        document.querySelector('img[alt="页面快照"]')).transform)
      return Math.hypot(m.a, m.b)
    })
  }
  console.log('拖拽前 scale =', sBefore.toFixed(3))

  // 找图片外、容器内的空白点：容器右下角内侧 padding 处
  const dragFrom = {
    x: areaBox.left + areaBox.width - 8,
    y: areaBox.top + 8,
  }
  // 确认这个点在 img 显示盒之外
  const outsideImg = await con.evaluate(({ x, y }) => {
    const b = document.querySelector('img[alt="页面快照"]').getBoundingClientRect()
    return x < b.left || x > b.right || y < b.top || y > b.bottom
  }, dragFrom)
  console.log('拖拽起点在图片外:', outsideImg)

  const before = await con.evaluate(() => {
    const m = new DOMMatrixReadOnly(
      getComputedStyle(document.querySelector('img[alt="页面快照"]')).transform)
    return { e: m.e, f: m.f }
  })

  // 容器空白处的 cursor class 断言（scale>1 时应带 cursor-grab）
  const cursorClass = await con.evaluate(() => {
    const img = document.querySelector('img[alt="页面快照"]')
    let el = img.parentElement
    while (el && !el.className.includes('overflow-hidden')) el = el.parentElement
    return el.className
  })
  const hasGrab = cursorClass.includes('cursor-grab')
  console.log('容器带 cursor-grab:', hasGrab)

  // 执行拖拽：down → move×3 → up
  await con.mouse.move(dragFrom.x, dragFrom.y)
  await con.mouse.down()
  for (let k = 1; k <= 3; k++) {
    await con.mouse.move(dragFrom.x + 20 * k, dragFrom.y + 12 * k)
    await sleep(60)
  }
  await con.mouse.up()
  await sleep(500) // transition 0.15s ease-out 结束

  const after = await con.evaluate(() => {
    const m = new DOMMatrixReadOnly(
      getComputedStyle(img_q()).transform)
    function img_q() { return document.querySelector('img[alt="页面快照"]') }
    return { e: m.e, f: m.f }
  })

  const dx = after.e - before.e, dy = after.f - before.f
  const dragged = Math.abs(dx) >= 55 && Math.abs(dy) >= 30
  console.log(`offset Δ = (${dx.toFixed(1)}, ${dy.toFixed(1)}) px — ${dragged ? '✓ 容器空白区拖拽生效' : '✗ 未生效'}`)

  // 双击复位回归：两连击（同坐标 240ms 内）
  await con.mouse.click(ax, ay, { clickCount: 1 })
  await con.mouse.click(ax, ay, { clickCount: 2 })
  await sleep(600)
  let resetScale = await con.evaluate(() => {
    const m = new DOMMatrixReadOnly(getComputedStyle(
      document.querySelector('img[alt="页面快照"]')).transform)
    return Math.hypot(m.a, m.b)
  })
  if (resetScale !== 1) {
    // 合成 dblclick 兜底：确认容器上的 @dblclick 绑定可达
    await con.evaluate(() => {
      const img = document.querySelector('img[alt="页面快照"]')
      let el = img.parentElement
      while (el && !el.className.includes('overflow-hidden')) el = el.parentElement
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await sleep(400)
    resetScale = await con.evaluate(() => {
      const m = new DOMMatrixReadOnly(getComputedStyle(
        document.querySelector('img[alt="页面快照"]')).transform)
      return Math.hypot(m.a, m.b)
    })
    console.log('合成 dblclick 后 scale =', resetScale.toFixed(4))
  }
  console.log('双击复位:', resetScale === 1 ? '✓' : '✗（原生双击未合成到容器）')
  const reset = await con.evaluate(() => {
    const m = new DOMMatrixReadOnly(getComputedStyle(
      document.querySelector('img[alt="页面快照"]')).transform)
    return { scale: Math.hypot(m.a, m.b) }
  })
  console.log('双击复位后 scale =', reset.scale.toFixed(4), reset.scale === 1 ? '✓' : '(若未复位需检查 dblclick 合成)')

  console.log('\n======== 结论 ========')
  console.log('锚定往返漂移 < 0.02 :', anchorFixed ? 'PASS' : 'FAIL', `(${driftAB.toFixed(5)})`)
  console.log('图片外容器拖拽     :', dragged && outsideImg ? 'PASS' : 'FAIL')

  await browser.close()
  if (!(anchorFixed && dragged)) process.exit(4)
}

await main()
