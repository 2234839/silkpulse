/**
 * compact 页面快照 —— 移植自 vite-plugin-pilot 的 snapshot 算法
 *
 * 核心设计（移植自 pilot）：
 * 1. 只采叶子节点 + 有信息量元素（交互/标题/有 id/有文本），~80 行压缩页面状态
 * 2. 稳定索引（data-clarosight-idx），跨快照复用，AI 引用元素不漂移
 * 3. 穿透 shadow DOM（open mode）
 *
 * 针对线上 H5 场景的简化（相比 pilot）：
 * - 去掉 src/line（无源码定位）
 * - 去掉 Vue 组件树采集（非 Vue 专用，线上是任意框架）
 * - 去掉 _btns/li 深度合并
 *
 * 暴露全局：
 * - __clarosight_snapshot()  → 返回 SnapshotData JSON
 * - __clarosight_elements    → 元素引用注册表（exec 操作用）
 * - __clarosight_click(idx)  → 点击元素
 * - __clarosight_setValue(idx, val)  → 设置表单值
 */

import type { SnapshotData, SnapshotElement } from '@clarosight/shared'

/** 不可见标签（采集时跳过） */
const SKIP_TAGS: Record<string, true> = {
  SCRIPT: true, STYLE: true, LINK: true, HEAD: true, META: true,
  NOSCRIPT: true, SVG: true, OPTION: true, OPTGROUP: true,
  TABLE: true, THEAD: true, TBODY: true, TR: true,
}

/** 结构性标签（需有额外信息才采集） */
const STRUCT_TAGS: Record<string, true> = {
  DIV: true, SECTION: true, UL: true, OL: true, MAIN: true,
  HEADER: true, FOOTER: true, NAV: true, ARTICLE: true,
}

/** 永远视为非叶子（内部有独立结构） */
const ALWAYS_NONLEAF: Record<string, true> = {
  SELECT: true, TEXTAREA: true, TABLE: true, UL: true, OL: true,
}

/** 不可见的子元素标签 */
const INVISIBLE_TAGS: Record<string, true> = { SCRIPT: true, STYLE: true, OPTION: true, OPTGROUP: true }

/** 状态提取正则（从 class 提取 active/selected/checked 等） */
const STATE_RE = /(active|selected|current|checked|open|expanded)/i

/** 元素注册表：idx → element（exec 操作时用 idx 取回元素） */
const elementsRegistry = new Map<number, Element>()

/** 判断元素是否为叶子（无可见子元素） */
function isLeaf(el: Element): boolean {
  if (el.tagName in ALWAYS_NONLEAF) return false
  if ((el as HTMLElement).shadowRoot) return false
  for (const child of el.children) {
    if (!(child.tagName in INVISIBLE_TAGS) && (child as HTMLElement).offsetParent !== null) return false
  }
  return true
}

/** 带上下文的元素：frame 标识来自递归进入 iframe 时记录 */
interface CollectedElement {
  el: Element
  /** 所在 iframe 标识（src 路径），主文档元素为 undefined */
  frame?: string
}

/**
 * 递归收集所有元素，穿透 shadow DOM（open mode）+ 同源 iframe
 * 跨域 iframe 受浏览器安全限制无法访问（属正常行为）
 */
function collectAllElements(root: ParentNode, frame?: string): CollectedElement[] {
  const result: CollectedElement[] = []
  for (const el of root.querySelectorAll('*')) {
    result.push({ el, frame })
    const shadow = (el as HTMLElement).shadowRoot
    if (shadow) {
      for (const s of collectAllElements(shadow, frame)) result.push(s)
    }
    /** 同源 iframe：递归采集其 document 内元素，标记 frame 标识 */
    if (el.tagName === 'IFRAME') {
      const ifr = el as HTMLIFrameElement
      /** iframe 标识：优先 name，否则 src 路径（省 origin 避免泄露完整地址） */
      const frameLabel = ifr.name || ifr.getAttribute('src') || 'iframe'
      try {
        const doc = ifr.contentDocument
        if (doc?.body) {
          for (const s of collectAllElements(doc.body, frameLabel)) result.push(s)
        }
      } catch {
        /** 跨域 iframe 访问 contentDocument 会抛 SecurityError，跳过 */
      }
    }
  }
  return result
}

/** 查找父级 LABEL（用于 checkbox/radio 的文本标签） */
function findParentLabel(el: Element): Element | null {
  let cur = el.parentElement
  while (cur) {
    if (cur.tagName === 'LABEL') return cur
    cur = cur.parentElement
  }
  return null
}

/** 取元素文本（根据是否叶子走不同策略，截断到 maxLen） */
function getElementText(el: Element, tagLower: string, leaf: boolean): string {
  if (tagLower === 'select') return ''
  if (leaf) {
    return (el.textContent || '').trim().slice(0, 60)
  }
  /** 非叶子：优先取直接文本节点 */
  let directText = ''
  for (const node of el.childNodes) {
    if (node.nodeType === 3) directText += node.textContent || ''
  }
  if (directText.trim()) return directText.trim().slice(0, 60)
  /** 否则拼接可见直接子元素文本，去重 */
  const seen = new Set<string>()
  const parts: string[] = []
  for (const child of el.children) {
    if ((child as HTMLElement).offsetParent === null) continue
    const t = (child.textContent || '').trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      parts.push(t)
    }
  }
  return parts.join(' ').slice(0, 60)
}

/**
 * 采集单个元素 → SnapshotElement（不采集则返回 null）
 * @param frame 元素所在的 iframe 标识（主文档为 undefined）
 */
function processElement(el: Element, maxIdx: { v: number }, frame?: string): SnapshotElement | null {
  const tag = el.tagName
  if (tag in SKIP_TAGS) return null

  const rect = (el as HTMLElement).getBoundingClientRect()
  if ((el as HTMLElement).offsetParent === null && tag !== 'BODY' && rect.width === 0 && rect.height === 0) return null
  if (rect.width === 0 && rect.height === 0) return null
  if (el.id === 'app' || el.id === '__nuxt') return null

  const tagLower = tag.toLowerCase()
  const leaf = isLeaf(el)

  /** label 含交互子元素时跳过（信息已由子元素捕获） */
  if (tagLower === 'label') {
    for (const c of el.children) {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(c.tagName)) return null
    }
  }

  const txt = getElementText(el, tagLower, leaf)
  const hasText = !!txt
  const hasId = !!el.id
  const isInteractive = ['button', 'a', 'input', 'textarea', 'select', 'option'].includes(tagLower)
  const isStructural = tag in STRUCT_TAGS

  const htmlEl = el as HTMLInputElement
  const hasValue = (tagLower === 'input' || tagLower === 'textarea' || tagLower === 'select') && !!htmlEl.value

  if (isStructural && !hasText && !isInteractive && !hasId && !hasValue) return null

  /** 稳定索引：复用 data-clarosight-idx，否则分配新的 */
  let idx: number
  const existing = el.getAttribute('data-clarosight-idx')
  if (existing !== null) {
    idx = parseInt(existing, 10)
  } else {
    idx = maxIdx.v++
    el.setAttribute('data-clarosight-idx', String(idx))
  }
  elementsRegistry.set(idx, el)

  const entry: SnapshotElement = { tag: tagLower, idx }
  if (el.id) entry.id = el.id
  if (txt) entry.text = txt
  if (frame) entry.frame = frame

  /** 交互元素的状态标记 */
  if (isInteractive) {
    const cls = ((htmlEl.className as string) || '').toLowerCase()
    const m = cls.match(STATE_RE)
    if (m) entry.state = m[1]
  }

  /** a 标签的 href（相对路径，省 origin/query） */
  if (tagLower === 'a' && (el as HTMLAnchorElement).href) {
    try {
      const hrefUrl = new URL((el as HTMLAnchorElement).href)
      entry.href = hrefUrl.origin !== location.origin
        ? hrefUrl.host + hrefUrl.pathname + hrefUrl.hash
        : hrefUrl.pathname + hrefUrl.hash
    } catch {
      entry.href = el.getAttribute('href') || ''
    }
  }

  /** 表单元素的值/类型/选项 */
  if (tagLower === 'input' || tagLower === 'textarea' || tagLower === 'select') {
    const type = htmlEl.type
    if (type === 'checkbox' || type === 'radio') {
      if (htmlEl.checked) entry.checked = true
      entry.type = type
      /** 从父 label 取文本标签 */
      const label = findParentLabel(el)
      if (label) {
        const lt = (label.textContent || '').trim().slice(0, 40)
        if (lt) entry.text = lt
      }
    } else if (tagLower === 'select') {
      const sel = el as HTMLSelectElement
      const selOpt = sel.options[sel.selectedIndex]
      if (selOpt) entry.value = selOpt.text.slice(0, 60)
      if (sel.options.length > 0 && sel.options.length <= 10) {
        entry.options = Array.from(sel.options, (o) => o.text)
      }
    } else {
      if (htmlEl.value) entry.value = htmlEl.value.slice(0, 60)
      if (htmlEl.placeholder) entry.placeholder = htmlEl.placeholder.slice(0, 60)
      if (type && type !== 'text') entry.type = type
    }
  }

  /**
   * 表单状态全量采集
   *
   * AI 诊断远程表单问题（提交失败/无法点击/值改不了）时，必须看到这些状态：
   * - disabled：原生禁用，点击无效
   * - readOnly：值不可编辑（但能聚焦、能选中复制），与 disabled 行为不同
   * - required：必填，表单校验失败的常见根因
   * - indeterminate：checkbox 半选（全选列表的中间态）
   * - aria-disabled：自定义组件（尤 Vue/React 按钮组件）常用 aria 而非原生 disabled
   * - aria-expanded：折叠/展开态（菜单、抽屉、手风琴），AI 判断"展开后元素找不到"的关键
   */
  if (htmlEl.disabled) entry.disabled = true
  if (htmlEl.readOnly) entry.readOnly = true
  if (htmlEl.required) entry.required = true
  if (htmlEl.type === 'checkbox' && htmlEl.indeterminate) entry.indeterminate = true
  const ariaDisabled = el.getAttribute('aria-disabled')
  if (ariaDisabled === 'true') entry.ariaDisabled = true
  const ariaExpanded = el.getAttribute('aria-expanded')
  if (ariaExpanded !== null) entry.ariaExpanded = ariaExpanded === 'true'
  const aria = el.getAttribute('aria-label')
  if (aria) entry.aria = aria.slice(0, 40)

  return entry
}

/** 最近错误缓存（error-catcher 写入，snapshot 时附加） */
let recentErrors: string[] = []
let totalErrorCount = 0

/** error-catcher 调用：记录最近错误，供 snapshot 附加 */
export function pushRecentError(msg: string): void {
  totalErrorCount++
  recentErrors.push(msg)
  if (recentErrors.length > 5) recentErrors.shift()
}

/**
 * 采集当前页面快照（供 exec 和定期上报调用）
 * 返回 SnapshotData（JSON 可序列化）
 */
export function takeSnapshot(): SnapshotData {
  /** 清理悬空引用（页面导航后旧元素失效） */
  for (const [k, el] of elementsRegistry) {
    if (!el.isConnected) elementsRegistry.delete(k)
  }

  /** 重置 maxIdx 上限：基于已注册 idx 计算 */
  let maxIdx = 0
  for (const k of elementsRegistry.keys()) {
    if (k >= maxIdx) maxIdx = k + 1
  }
  const maxIdxBox = { v: maxIdx }

  const all = collectAllElements(document.body)
  const els: SnapshotElement[] = []
  for (const { el, frame } of all) {
    const entry = processElement(el, maxIdxBox, frame)
    if (entry) els.push(entry)
    /** 上限 120 个元素，防爆体积 */
    if (els.length >= 120) break
  }

  return {
    t: new Date().toISOString(),
    url: location.href,
    title: document.title,
    els,
    errors: totalErrorCount,
    lastErrors: recentErrors.length > 0 ? [...recentErrors] : undefined,
  }
}

/** 当前已注册的最大 idx（exec 操作时校验用） */
export function hasElement(idx: number): boolean {
  return elementsRegistry.has(idx)
}

/** 按 idx 取元素（exec 操作用） */
export function getElement(idx: number): Element | undefined {
  return elementsRegistry.get(idx)
}
