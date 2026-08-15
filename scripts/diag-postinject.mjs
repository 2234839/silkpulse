/** 手动诊断：后注入 SDK 时页面发生了什么（console/pageerror 全打印） */
import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'

let chrom = process.env.CHROMIUM_PATH
if (!chrom) {
  for (const n of ['chromium-browser', 'chromium', 'google-chrome']) {
    try {
      const f = execSync(`which ${n} 2>/dev/null`, { encoding: 'utf8' }).trim()
      if (f) { chrom = f; break }
    } catch {}
  }
}
const b = await puppeteer.launch({ executablePath: chrom, headless: true, args: ['--no-sandbox'] })
const p = await b.newPage()
p.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)))
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 400)))
p.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText))
await p.goto('http://localhost:8080/post-inject-test.html', { waitUntil: 'networkidle0' })
console.log('--- 页面就绪，注入 SDK ---')
await p.evaluate((origin) => {
  const s = document.createElement('script')
  s.src = `${origin}/sdk.js`
  s.dataset.server = origin
  document.head.appendChild(s)
}, 'http://localhost:8080')
await new Promise((r) => setTimeout(r, 6000))
const state = await p.evaluate(() => ({
  hook: !!window.__VUE_DEVTOOLS_GLOBAL_HOOK__,
  apps: window.__VUE_DEVTOOLS_GLOBAL_HOOK__?.apps?.length,
  sdk: typeof window.__silkpulse_devtools_available,
}))
console.log('state:', JSON.stringify(state))
await b.close()
