/** React 激活失败诊断：捕获真实异常 */
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
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 600)))
p.on('console', (m) => {
  const t = m.text()
  if (!t.includes('favicon')) console.log('[console]', t.slice(0, 400))
})
await p.goto('http://localhost:8080/post-inject-react-test.html', { waitUntil: 'networkidle0' })

const origin = 'http://localhost:8080'
await p.evaluate((src) => {
  const s = document.createElement('script')
  s.src = src
  s.dataset.server = src.slice(0, src.lastIndexOf('/'))
  document.head.appendChild(s)
}, `${origin}/sdk.js`)
await new Promise((r) => setTimeout(r, 2000))

const out = await p.evaluate(async () => {
  try {
    const t = await window.__silkpulse_devtools_tree()
    return JSON.stringify(t).slice(0, 400)
  } catch (e) {
    return `ERROR: ${e.message}`
  }
})
console.log('tree:', out)

const manual = await p.evaluate(async () => {
  const steps = {}
  try {
    const r = await fetch('/plugins/react-devtools/assets/backend.bundle.js')
    steps.http = r.status
    const code = await r.text()
    steps.codeLen = code.length
    const f = new Function(`${code};return typeof ReactDevToolsBackend !== 'undefined' ? ReactDevToolsBackend : undefined`)
    const m = f.call(window)
    steps.exportOk = !!m
    steps.keys = m ? Object.keys(m).slice(0, 12) : null
  } catch (e) {
    steps.fail = e.message
    steps.stack = String(e.stack).slice(0, 500)
  }
  return steps
})
console.log('手动加载 bundle（与 loadBackendBundle 相同路径）:', JSON.stringify(manual, null, 2))
await b.close()
