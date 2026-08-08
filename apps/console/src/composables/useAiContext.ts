/**
 * useAiContext —— 将当前设备状态打包为 AI 可读诊断上下文
 *
 * silkpulse 的 AI-native 灵魂：人在控制台看到问题时，一键把设备现场
 * （错误 + 快照 + 网络 + 日志）压缩成一段 token 友好的文本，
 * 粘贴给任意 AI agent 即可开始诊断，或直接喂给 silkpulse skill。
 */
import { ref } from 'vue'
import type { LogEntry, NetworkEntry, ErrorEntry } from '@silkpulse/shared'
import { copyText } from '../utils/clipboard'
import { apiFetch } from '../utils/api'

interface AiContextInput {
  /** 设备 id */
  deviceId: string
  /** 设备展示信息（标题/url） */
  title: string
  url: string
  /** 当前错误列表 */
  errors: ErrorEntry[]
  /** 当前网络请求列表 */
  network: NetworkEntry[]
  /** 当前日志列表 */
  logs: LogEntry[]
}

export function useAiContext() {
  /** 最近一次生成的上下文（供弹窗展示/复制） */
  const contextText = ref('')
  const generating = ref(false)
  /** 复制状态：idle / copied / error */
  const copyState = ref<'idle' | 'copied' | 'error'>('idle')

  /**
   * 拉取最新快照并聚合为 AI 诊断上下文文本
   * 快照走 HTTP（保证最新），其余数据用控制台已收到的实时缓存
   */
  async function generate(input: AiContextInput) {
    generating.value = true
    try {
      const snapRes = await apiFetch(`/api/devices/${input.deviceId}/snapshot`)
      const snapshot = snapRes.ok ? await snapRes.text() : '（快照不可用）'
      contextText.value = buildContext({ ...input, snapshot })
    } finally {
      generating.value = false
    }
  }

  /** 复制到剪贴板 */
  async function copyToClipboard() {
    if (!contextText.value) return
    const ok = await copyText(contextText.value)
    if (ok) {
      copyState.value = 'copied'
      setTimeout(() => (copyState.value = 'idle'), 1500)
    } else {
      copyState.value = 'error'
    }
  }

  return { contextText, generating, copyState, generate, copyToClipboard }
}

/** 聚合设备现场为一段 AI 可读文本 */
function buildContext(input: AiContextInput & { snapshot: string }): string {
  const lines: string[] = []
  lines.push(`# silkpulse 设备诊断上下文`)
  lines.push(``)
  lines.push(`- 页面: ${input.title}`)
  lines.push(`- URL: ${input.url}`)
  lines.push(`- 时间: ${new Date().toISOString()}`)
  lines.push(``)

  /** 错误（最多 10 条，AI 诊断最关键输入） */
  lines.push(`## 错误 (${input.errors.length})`)
  if (input.errors.length === 0) {
    lines.push(`（无）`)
  } else {
    for (const e of input.errors.slice(-10)) {
      lines.push(`- ${e.message}`)
      /** 优先展示 source map 解析出的原始源码位置（压缩代码定位的关键） */
      if (e.mapped) {
        lines.push(`  原始源码: ${e.mapped.source}:${e.mapped.line}:${e.mapped.column}${e.mapped.name ? ` (${e.mapped.name})` : ''}`)
      } else if (e.source) {
        lines.push(`  位置: ${e.source}:${e.line}:${e.col}`)
      }
      if (e.stack) lines.push(`  \`\`\``, ...e.stack.split('\n').slice(0, 4).map((l) => `  ${l}`), `  \`\`\``)
    }
  }
  lines.push(``)

  /** 页面快照 */
  lines.push(`## 页面快照`)
  lines.push(`\`\`\``)
  lines.push(input.snapshot)
  lines.push(`\`\`\``)
  lines.push(``)

  /** 失败的网络请求（4xx/5xx，AI 诊断常见线索） */
  const failed = input.network.filter((n) => n.status >= 400 || n.status === 0)
  lines.push(`## 异常网络请求 (${failed.length})`)
  if (failed.length === 0) {
    lines.push(`（无）`)
  } else {
    for (const n of failed.slice(-10)) {
      lines.push(`- ${n.method} ${n.status} ${n.url} (${n.duration}ms)`)
    }
  }
  lines.push(``)

  /**
   * 慢请求 Top 5 —— 按耗时降序，>500ms 标记 ⚠
   *
   * 与 skill CLI inspect 的慢请求段对齐：诊断"页面慢/卡"时，失败的请求往往不是根因，
   * 真正的瓶颈是那些 status 200 但耗时 2-3s 的慢请求。
   * 控制台"AI 诊断上下文"按钮之前缺这段，导致复制给 AI 的现场丢失性能线索。
   */
  const SLOW_THRESHOLD = 500
  const byDuration = [...input.network].sort((a, b) => b.duration - a.duration)
  const slowTop = byDuration.slice(0, 5).filter((n) => n.duration > 0)
  lines.push(`## 慢请求 Top ${slowTop.length}（> ${SLOW_THRESHOLD}ms 标记 ⚠）`)
  if (slowTop.length === 0) {
    lines.push(`（无网络请求）`)
  } else {
    for (const n of slowTop) {
      const mark = n.duration > SLOW_THRESHOLD ? ' ⚠' : ''
      lines.push(`- ${n.duration}ms${mark} ${n.method} ${n.status} ${n.url}`)
    }
  }
  lines.push(``)

  /** 最近的日志（最多 20 条） */
  lines.push(`## 最近日志 (${input.logs.length})`)
  if (input.logs.length === 0) {
    lines.push(`（无）`)
  } else {
    for (const l of input.logs.slice(-20)) {
      lines.push(`- [${l.type}] ${l.message}`)
    }
  }

  lines.push(``)
  lines.push(`---`)
  lines.push(`提示：可用 silkpulse skill 在该设备执行诊断代码，例如：`)
  lines.push(`  silkpulse exec ${input.deviceId.slice(0, 8)} --code "return __silkpulse_snapshot()"`)

  return lines.join('\n')
}
