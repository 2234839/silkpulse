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

/**
 * 缩略图最大边长 px（压缩到很小，预览只需模糊轮廓）
 */
const THUMB_SIZE = 48

/**
 * 缩略图缓存：同一 URL 只采集一次（同一页面多次出现的图标/图片）
 */
const thumbCache = new Map<string, string | null>()

/**
 * 把已加载的 HTMLImageElement 压缩成低质量 dataURL
 *
 * 不触发新网络请求——只使用浏览器已缓存的图片数据。
 * 输出约 0.5-2KB 的 JPEG dataURL，足够预览渲染用。
 */
function imgToThumb(img: HTMLImageElement): string | null {
  /** naturalWidth=0 说明图片未加载或加载失败 */
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  if (!nw || !nh) return null

  try {
    const canvas = document.createElement('canvas')
    /** 缩略图尺寸：按比例缩放到 THUMB_SIZE */
    const ratio = Math.min(THUMB_SIZE / nw, THUMB_SIZE / nh, 1)
    canvas.width = Math.max(1, Math.round(nw * ratio))
    canvas.height = Math.max(1, Math.round(nh * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.3)
  } catch {
    /** 跨域图片 drawImage 会抛 SecurityError，静默跳过 */
    return null
  }
}

/**
 * 把已加载的 URL（背景图等）压缩成 dataURL
 *
 * 复用同一 img 元素避免重复加载，带缓存防止重复采集。
 * 不触发新网络请求——浏览器已缓存的图片直接可用。
 */
function urlToThumb(url: string): string | null {
  /** data: URL 直接缓存（可能本身就很短） */
  if (url.startsWith('data:')) {
    return url.length < 500 ? url : null
  }

  /** 命中缓存 */
  if (thumbCache.has(url)) return thumbCache.get(url)!

  /** 用一个临时 img 加载（浏览器缓存命中不会发网络请求） */
  const tmp = new Image()
  tmp.crossOrigin = 'anonymous'
  tmp.src = url

  /** 同步检查：如果浏览器已缓存且立即可用 */
  if (tmp.complete && tmp.naturalWidth > 0) {
    const result = imgToThumb(tmp)
    thumbCache.set(url, result)
    return result
  }

  /** 未缓存（需要网络）——标记为 null 不采集（不阻塞快照） */
  thumbCache.set(url, null)
  return null
}

/**
 * 采集元素的关键视觉样式（控制台侧高保真预览用）
 *
 * 只提取对视觉还原影响最大的属性，跳过 transparent/默认值以节省体积。
 * 返回 null 表示没有有意义的视觉信息。
 */
function captureVisualStyle(el: HTMLElement): SnapshotElement['style'] | null {
  const cs = getComputedStyle(el)
  const s: NonNullable<SnapshotElement['style']> = {}

  /** 背景色：跳过 transparent 和纯白（太常见） */
  const bg = cs.backgroundColor
  if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
    const rgb = bg.match(/rgba?\(([^)]+)\)/)
    if (rgb) {
      const parts = rgb[1].split(',').map((p) => parseFloat(p.trim()))
      /** alpha < 0.05 视为透明 */
      if (parts.length >= 3 && (parts.length < 4 || parts[3] >= 0.05)) {
        s.bg = bg
      }
    }
  }

  /** 文字颜色：跳过纯黑（默认色） */
  const color = cs.color
  if (color && color !== 'rgb(0, 0, 0)') {
    s.color = color
  }

  /** 字号：跳过 16px（浏览器默认） */
  const fs = parseFloat(cs.fontSize)
  if (fs && Math.abs(fs - 16) > 0.5) {
    s.fs = Math.round(fs)
  }

  /** 字重：跳过 400（normal） */
  const fw = cs.fontWeight
  if (fw && fw !== '400' && fw !== 'normal') {
    s.fw = fw
  }

  /** 圆角：跳过 0 */
  const radius = parseFloat(cs.borderTopLeftRadius)
  if (radius && radius > 0) {
    s.radius = Math.round(radius)
  }

  /** 边框：有实线边框才采集 */
  const bw = cs.borderWidth
  const bstyle = cs.borderStyle
  if (bstyle && bstyle !== 'none' && bstyle !== 'hidden' && parseFloat(bw) > 0) {
    s.border = `${Math.round(parseFloat(bw))}px ${bstyle} ${cs.borderColor}`
  }

  /** 文字对齐：非 left 才采集 */
  const align = cs.textAlign
  if (align && align !== 'left' && align !== 'start') {
    s.align = align
  }

  /** 溢出 + 滚动：可滚动容器采集 overflow 和 scroll 位置 */
  const ovx = cs.overflowX
  const ovy = cs.overflowY
  const scrollableX = (ovx === 'auto' || ovx === 'scroll') && el.scrollWidth > el.clientWidth + 1
  const scrollableY = (ovy === 'auto' || ovy === 'scroll') && el.scrollHeight > el.clientHeight + 1
  if (scrollableX || scrollableY) {
    s.overflow = `${scrollableX ? ovx : 'visible'} ${scrollableY ? ovy : 'visible'}`
    s.scroll = [el.scrollLeft, el.scrollTop]
  }

  /** img 元素的缩略图：用 Canvas 把已加载图片压缩成 dataURL */
  if (el.tagName === 'IMG' && (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0) {
    const thumb = imgToThumb(el as HTMLImageElement)
    if (thumb) s.img = thumb
  }

  /** CSS background-image：如果是已加载的图片 URL，采集缩略图 */
  const bgImg = cs.backgroundImage
  if (bgImg && bgImg !== 'none') {
    const urlMatch = bgImg.match(/url\(["']?([^"')]+)["']?\)/)
    if (urlMatch) {
      const thumb = urlToThumb(urlMatch[1])
      if (thumb) s.bgImg = thumb
    }
  }

  return Object.keys(s).length > 0 ? s : null
}

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
  /** 布局位置（相对视口），控制台侧据此渲染布局框图预览 */
  entry.rect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  }

  /** 关键视觉样式（控制台侧高保真预览用） */
  const vs = captureVisualStyle(el as HTMLElement)
  if (vs) entry.style = vs

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
      /**
       * select 的 value 输出 value:text 格式
       *
       * AI 操作 select 需要知道 option 的 value（__clarosight_setValue 传 value），
       * 但纯 value（如 "bj"）无语义，需配 text（"北京"）让 AI 理解含义。
       * 格式 "bj:北京" 兼顾两者——AI 看到 val=bj:北京 知道当前选"北京"，
       * setValue(idx, "bj") 可切换。
       */
      if (selOpt) entry.value = `${selOpt.value}:${selOpt.text}`.slice(0, 60)
      /**
       * options 同样用 value:text 格式，让 AI 知道每个选项的 value 和 label。
       * 若 value 和 text 相同（无 value 属性的 option），只输出 text 省空间。
       */
      if (sel.options.length > 0 && sel.options.length <= 10) {
        entry.options = Array.from(sel.options, (o) =>
          o.value && o.value !== o.text ? `${o.value}:${o.text}` : o.text,
        )
      }
    } else {
      /** 密码框不采集 value（隐私保护——密码明文不上报） */
      if (type === 'password') {
        entry.type = 'password'
      } else {
        if (htmlEl.value) entry.value = htmlEl.value.slice(0, 60)
        if (htmlEl.placeholder) entry.placeholder = htmlEl.placeholder.slice(0, 60)
        if (type && type !== 'text') entry.type = type
      }
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
  /**
   * 当前聚焦元素标记
   *
   * AI 远程操作表单时需知道光标位置：诊断"输入后提交失败"时，焦点在哪个输入框
   * 是关键上下文；AI 执行 __clarosight_type 前能从快照判断是否需要先 click 定位。
   * 用 ownerDocument 而非 document，穿透 iframe 时判断的是 iframe 内的聚焦元素。
   */
  if (el.ownerDocument && el.ownerDocument.activeElement === el) {
    entry.focused = true
  }

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
    /** 视口尺寸：诊断响应式/布局错乱时让 AI 知道当前可视区域（手机/平板/桌面） */
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
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
/**
 * 确保元素有稳定 idx（Element 面板用）
 *
 * 已有 data-clarosight-idx 就复用；没有就分配新 idx（取当前 registry 最大 idx + 1）
 * 并写入 elementsRegistry，让 __clarosight_click(idx) 等操作能定位到这个元素。
 *
 * 与 processElement 的分配逻辑对齐：不写 data-clarosight-idx 属性（避免污染 DOM，
 * 该属性只在 snapshot 真正采集时才打），只维护 registry 映射。
 * 返回 -1 表示元素已脱离文档（isConnected=false）。
 */
export function ensureElementIdx(el: Element): number {
  if (!el.isConnected) return -1
  /** 复用已有 idx（如果元素已被 snapshot 采集过） */
  for (const [k, v] of elementsRegistry) {
    if (v === el) return k
  }
  /** 分配新 idx：取当前最大值 + 1（与 processElement 的 maxIdx 策略对齐） */
  let maxIdx = 0
  for (const k of elementsRegistry.keys()) {
    if (k >= maxIdx) maxIdx = k + 1
  }
  elementsRegistry.set(maxIdx, el)
  return maxIdx
}