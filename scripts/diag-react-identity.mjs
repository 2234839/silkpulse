/** 精确诊断：fiberRoot 的身份与 map key 一致性 */
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
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 500)))
await p.goto('http://localhost:8080/post-inject-react-test.html', { waitUntil: 'networkidle0' })
await p.evaluate(
  (origin) => {
    const s = document.createElement('script')
    s.src = `${origin}/sdk.js`
    s.dataset.server = origin
    document.head.appendChild(s)
  },
  'http://localhost:8080',
)
await new Promise((r) => setTimeout(r, 2000))

const info = await p.evaluate(async () => {
  const el = document.getElementById('root')
  const key = Object.getOwnPropertyNames(el).find((k) => k.startsWith('__reactContainer$'))
  const hostRootFiber = el[key]
  const stateNode = hostRootFiber.stateNode
  const out = {
    fiberTag: hostRootFiber.tag,
    stateNodeType: typeof stateNode,
    stateNodeIsNull: stateNode == null,
    /** 真实 FiberRoot 的判定：current 指回 HostRoot fiber */
    stateNodeCurrentIsSelf: !!(stateNode && stateNode.current === hostRootFiber),
    stateNodeKeys: stateNode && typeof stateNode === 'object' ? Object.keys(stateNode).slice(0, 12) : null,
  }
  /** 触发激活（会失败但推进状态），再看 hook 里注册的 fiberRoot 身份 */
  try { await window.__silkpulse_devtools_tree() } catch {}
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
  const ids = hook?.renderers ? [...hook.renderers.keys()] : []
  out.stubRendererIds = ids
  const rootsInfo = []
  for (const id of ids) {
    for (const root of hook.getFiberRoots(id)) {
      rootsInfo.push({
        isStateNode: root === stateNode,
        isSynthetic: !(root === stateNode),
        currentIsHostRoot: root.current === hostRootFiber,
        rootKeys: Object.keys(root).slice(0, 8),
      })
    }
  }
  out.roots = rootsInfo
  return out
})
console.log(JSON.stringify(info, null, 2))
await b.close()
