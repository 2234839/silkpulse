/** 冒烟测试：register / log / subscribe / 扇出 / health 链路 */
const { createRequire } = require('node:module')
const rq = createRequire('/home/gs/opensource_code/clarosight/packages/server/package.json')
const WS = rq('ws')
const BASE = process.env.BASE ?? 'http://localhost:8082'

;(async () => {
  const console_ = new WS(BASE.replace(/^http/, 'ws') + '/ws/console')
  const seen = []
  console_.on('message', (m) => seen.push(JSON.parse(m.toString()).type))
  await new Promise((r) => console_.on('open', r))

  const dev = new WS(BASE.replace(/^http/, 'ws') + '/ws/device')
  await new Promise((r) => dev.on('open', r))
  /** exec 响应器：必须在 exec HTTP 请求之前挂好 */
  dev.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.type === 'exec') {
      dev.send(JSON.stringify({ type: 'exec-result', execId: m.execId, result: { success: true, result: '2', resultValue: { type: 'number', preview: '2', value: 2 } } }))
    }
  })
  dev.send(JSON.stringify({ type: 'register', sessionToken: 'st-1', device: { id: 'smoke-1', url: 'https://example.com/a', title: '冒烟设备', deviceType: 'desktop', tags: [] } }))
  await new Promise((r) => setTimeout(r, 300))

  /** 未订阅时 log 不应送fanout（真实 server 语义：watchers 为空不发送） */
  dev.send(JSON.stringify({ type: 'log', log: { level: 'log', message: 'hello-uws', timestamp: new Date().toISOString() } }))
  await new Promise((r) => setTimeout(r, 300))

  /** 订阅后再发，控制台应收到 log */
  console_.send(JSON.stringify({ type: 'subscribe', deviceId: 'smoke-1' }))
  await new Promise((r) => setTimeout(r, 200))
  dev.send(JSON.stringify({ type: 'log', log: { level: 'log', message: 'subscribed-log', timestamp: new Date().toISOString() } }))
  await new Promise((r) => setTimeout(r, 300))

  /** exec 链路 */
  const r1 = await fetch(BASE + '/api/devices/smoke-1/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'return 1+1' }),
  })
  const execRes = await r1.json()

  const health = await (await fetch(BASE + '/api/health')).json()
  console.log('console 消息类型:', seen.join(','))
  console.log('exec HTTP:', JSON.stringify(execRes).slice(0, 120))
  console.log('fanout sent:', health.fanoutSent, 'rss:', health.rssMB)
  dev.close(); console_.close()
  process.exit(0)
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
