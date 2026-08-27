/**
 * UI 审查截图脚本：node /tmp/shot.mjs <url> <outfile> [等待毫秒] [点击选择器(逗号分隔,可含文本::前缀)]
 */
import puppeteer from 'puppeteer-core'

const [url, out, waitMs = '1500', clicks = ''] = process.argv.slice(2)
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium-browser',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) console.log('[page.' + m.type() + ']', m.text())
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 })
if (clicks) {
  for (const c of clicks.split(',')) {
    if (c.startsWith('text::')) {
      const t = c.slice(6)
      const clicked = await page.evaluate((t) => {
        const els = [...document.querySelectorAll('button,a,[role=tab],.cursor-pointer,span,div')]
        const el = els.find((e) => e.textContent?.trim() === t && e.offsetParent !== null)
        if (el) { el.click(); return true }
        return false
      }, t)
      if (!clicked) console.log('[warn] 未找到文本元素:', t)
    } else {
      try { await page.click(c) } catch { console.log('[warn] 点击失败:', c) }
    }
    await new Promise((r) => setTimeout(r, 600))
  }
}
await new Promise((r) => setTimeout(r, Number(waitMs)))
await page.screenshot({ path: out })
await browser.close()
console.log('saved', out)
