/** React 后注入完整五步验证：available → tree → inspect(hooks) → set → click */
import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'

const SERVER = 'http://localhost:8080'
const ADMIN_KEY = '9bc0af165928751a919613f607a2de17247c9237c0a18d24'

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
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)))
await p.goto(`${SERVER}/post-inject-react-test.html`, { waitUntil: 'networkidle0' })
await p.evaluate(
  (origin) => {
    const s = document.createElement('script')
    s.src = `${origin}/sdk.js`
    s.dataset.server = origin
    document.head.appendChild(s)
  },
  SERVER,
)
await new Promise((r) => setTimeout(r, 2000))

const api = (path, init = {}) => fetch(`${SERVER}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
})
const devs = await (await api('/api/devices')).json()
const dev = (devs.devices ?? []).find((d) => (d.url ?? '').includes('post-inject-react-test'))
console.log('device:', dev?.id)
const exec = async (code) => {
  const r = await (await api(`/api/devices/${dev.id}/exec`, { method: 'POST', body: JSON.stringify({ code }) })).json()
  if (!r.success) throw new Error(JSON.stringify(r).slice(0, 200))
  return r.result != null ? JSON.parse(r.result) : r.resultValue ?? null
}

console.log('1. available:', JSON.stringify(await exec('__silkpulse_devtools_available()')))
console.log('2. tree:', JSON.stringify(await exec('__silkpulse_devtools_tree()')))
const idx = await exec('__silkpulse_ensureIdx(document.querySelector("#inc-btn"))')
const insp = await exec(`__silkpulse_devtools_inspect(${idx})`)
console.log('3. inspect:', JSON.stringify(insp).slice(0, 600))
const setR = await exec(`__silkpulse_devtools_set(${idx}, 'hooks', [], 100, 0)`)
console.log('4. set:', JSON.stringify(setR).slice(0, 200))
await new Promise((r) => setTimeout(r, 400))
const counter = await p.evaluate(() => document.querySelector('.counter')?.textContent?.trim())
console.log('   counter after set:', counter)
const clickOk = await p.click('#inc-btn').then(() => true, async () => {
  try { await p.evaluate(() => document.querySelector('#inc-btn')?.click()); return true } catch { return false }
})
await new Promise((r) => setTimeout(r, 400))
const counter2 = await p.evaluate(() => document.querySelector('.counter')?.textContent?.trim())
console.log(`5. click(${clickOk}) counter:`, counter2)
await b.close()
