/**
 * 快照文本序列化 —— 把 exec 返回的 JSON 快照序列化为 AI 友好的 compact 文本
 *
 * 移植自 pilot 的 compact.ts，针对 clarosight「任意线上 H5」场景简化：
 * - 去掉 src/line（无源码定位，非本地开发场景）
 * - 去掉 _btns/li 深度合并（保留核心的交互元素序列化）
 * - 保留：元素过滤、连续同类合并、稳定 idx、token 友好的单行格式
 */

import type { SnapshotData, SnapshotElement } from '@clarosight/shared'

/** compact 过滤：保留交互元素、标题、有 id 的元素、含文本的内容元素 */
function filterCompact(data: SnapshotData): SnapshotElement[] {
  const INTERACTIVE = new Set(['button', 'input', 'textarea', 'select', 'a', 'option'])
  const SECTIONS = new Set(['h1', 'h2', 'h3', 'h4'])
  const CONTENT = new Set(['li', 'td', 'th'])

  const filtered = data.els.filter((e) =>
    INTERACTIVE.has(e.tag)
    || SECTIONS.has(e.tag)
    || (e.id !== undefined && e.text)
    || (CONTENT.has(e.tag) && e.text)
    || (e.tag === 'span' && e.text)
  )
  return filtered
}

/**
 * 将元素数组序列化为 compact 文本（每行一个元素，字段空格分隔）
 * 格式：tag[#idx][val=V][type:T][ph=P][disabled][check=labels][state=s][opts=o] text|text|...
 */
function serializeCompactText(els: SnapshotElement[]): string {
  const INTERACTIVE_TAGS = new Set(['button', 'input', 'textarea', 'select', 'a', 'option'])
  return els.map((e) => {
    const parts: string[] = [e.tag]
    /** 交互元素显示 idx，供 AI 通过 __clarosight_click(i) 等精确操作 */
    if (e.idx != null) parts.push(`#${e.idx}`)
    /** 有 id 的非交互元素输出 id，帮助 AI 理解语义 */
    if (e.id != null && !INTERACTIVE_TAGS.has(e.tag)) parts.push(`#${e.id}`)
    if (e.value != null) {
      const opts = e.options
      if (opts) {
        const idx = opts.indexOf(String(e.value))
        if (idx >= 0) parts.push(`check=${e.value}`)
        else parts.push(`val=${e.value}`)
      } else {
        parts.push(`val=${e.value}`)
      }
    }
    if (e.type != null) parts.push(`type:${e.type}`)
    if (e.placeholder != null) parts.push(`ph:${e.placeholder}`)
    if (e.href != null) parts.push(`href:${e.href}`)
    if (e.disabled) parts.push('disabled')
    if (e.checked != null) parts.push('check')
    if (e.state != null) parts.push(`(${e.state})`)
    if (e.options != null) parts.push(`<${e.options.join('|')}>`)
    if (e.text != null) parts.push(String(e.text))
    if (e.aria != null) parts.push(`aria:${e.aria}`)
    return parts.join(' ')
  }).join('\n')
}

/**
 * 完整快照文本（带 meta 头部）—— exec 返回的 result 是 JSON 字符串，这里解析后序列化
 * 入参 rawResult 是设备端 __clarosight_snapshot() 返回的 JSON 字符串
 */
export function sendSnapshot(rawResult: string | undefined): string {
  if (!rawResult) return '[快照为空]'
  let data: SnapshotData
  try {
    data = JSON.parse(rawResult)
  } catch {
    return `[快照解析失败] ${rawResult.slice(0, 200)}`
  }
  const filtered = filterCompact(data)
  const text = serializeCompactText(filtered)
  const header = [
    `# url: ${data.url}`,
    `# title: ${data.title}`,
    `# errors: ${data.errors}`,
  ].join('\n')
  const errorSuffix =
    data.lastErrors && data.lastErrors.length > 0
      ? '\n# last errors:\n' + data.lastErrors.map((e) => `#   ${e}`).join('\n')
      : ''
  return header + '\n' + text + errorSuffix
}
