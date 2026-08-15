import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'
let chrom = process.env.CHROMIUM_PATH
if (!chrom) { for (const n of ['chromium-browser','chromium','google-chrome']) { try { const f = execSync(`which ${n} 2>/dev/null`,{encoding:'utf8'}).trim(); if (f) { chrom = f; break } } catch {} } }
const b = await puppeteer.launch({ executablePath: chrom, headless: true, args: ['--no-sandbox'] })
const p = await b.newPage()
await p.goto('http://localhost:8080/post-inject-react-test.html', { waitUntil: 'networkidle0' })
const shape = await p.evaluate(() => {
  const el = document.getElementById('root')
  const key = Object.getOwnPropertyNames(el).find((k) => k.startsWith('__reactContainer$'))
  const c = el[key]
  return {
    key,
    type: typeof c,
    keys: c ? Object.keys(c).slice(0, 20) : null,
    hasCurrent: !!c?.current,
    ctor: c?.constructor?.name,
    /** 深看一层：current 字段可能叫别的 */
    sample: c ? JSON.stringify(Object.keys(c)) : null,
  }
})
console.log(JSON.stringify(shape, null, 2))
await b.close()
