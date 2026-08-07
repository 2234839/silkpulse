/**
 * useLayoutPreview —— 布局框图预览 hook
 *
 * 基于 snapshot 数据（含 rect 位置）计算布局预览所需的缩放比例、
 * 色块样式、颜色分类等。供 ElementPanel 的布局预览视图使用。
 */
import { ref, computed, onMounted, onUnmounted, nextTick, type Ref } from 'vue'
import type { SnapshotData, SnapshotElement } from '@clarosight/shared'

/** 容器标签 —— 只画虚线边框，不填充背景色 */
const CONTAINER_TAGS = new Set([
  'div', 'section', 'header', 'footer', 'nav', 'main', 'aside',
  'article', 'ul', 'ol', 'li', 'form', 'fieldset', 'figure',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
])

/** 判断是否为容器元素（框）而非叶子元素（内容） */
export function isContainer(el: SnapshotElement): boolean {
  return CONTAINER_TAGS.has(el.tag)
}

/** 叶子/交互元素的颜色 —— 实心半透明色块 */
const LEAF_COLORS: Record<string, string> = {
  button: 'bg-blue-500/25 border-blue-500/60 text-blue-700 dark:text-blue-300',
  a: 'bg-green-500/20 border-green-500/50 text-green-700 dark:text-green-300',
  input: 'bg-amber-500/20 border-amber-500/50 text-amber-700 dark:text-amber-300',
  textarea: 'bg-amber-500/20 border-amber-500/50 text-amber-700 dark:text-amber-300',
  select: 'bg-amber-500/20 border-amber-500/50 text-amber-700 dark:text-amber-300',
  h1: 'bg-purple-500/20 border-purple-500/50 text-purple-700 dark:text-purple-300',
  h2: 'bg-purple-500/20 border-purple-500/50 text-purple-700 dark:text-purple-300',
  h3: 'bg-purple-500/15 border-purple-500/40 text-purple-700 dark:text-purple-300',
  h4: 'bg-purple-500/15 border-purple-500/40 text-purple-700 dark:text-purple-300',
  h5: 'bg-purple-500/15 border-purple-500/40 text-purple-700 dark:text-purple-300',
  h6: 'bg-purple-500/15 border-purple-500/40 text-purple-700 dark:text-purple-300',
  img: 'bg-pink-500/15 border-pink-500/40 text-pink-700 dark:text-pink-300',
  span: 'bg-teal-500/15 border-teal-500/35 text-teal-700 dark:text-teal-300',
  p: 'bg-teal-500/15 border-teal-500/35 text-teal-700 dark:text-teal-300',
  label: 'bg-teal-500/15 border-teal-500/35 text-teal-700 dark:text-teal-300',
}

const DEFAULT_LEAF = 'bg-gray-500/15 border-gray-400/40 text-gray-600 dark:text-gray-400'

/** 容器框样式 —— 虚线边框 + 无背景色 */
const CONTAINER_BORDER: Record<string, string> = {
  header: 'border-blue-400/40 text-blue-500/60 dark:text-blue-400/50',
  nav: 'border-green-400/40 text-green-500/60 dark:text-green-400/50',
  main: 'border-purple-400/40 text-purple-500/60 dark:text-purple-400/50',
  aside: 'border-cyan-400/40 text-cyan-500/60 dark:text-cyan-400/50',
  footer: 'border-gray-400/40 text-gray-500/60 dark:text-gray-400/50',
  form: 'border-amber-400/40 text-amber-500/60 dark:text-amber-400/50',
  ul: 'border-orange-400/30 text-orange-500/50 dark:text-orange-400/40',
  ol: 'border-orange-400/30 text-orange-500/50 dark:text-orange-400/40',
  li: 'border-orange-400/30 text-orange-500/50 dark:text-orange-400/40',
}

const DEFAULT_CONTAINER = 'border-gray-300/30 text-gray-400/50 dark:text-gray-500/40'

/** 获取元素的样式类（区分容器框和叶子色块） */
export function elementColor(el: SnapshotElement): string {
  if (isContainer(el)) {
    return CONTAINER_BORDER[el.tag] ?? DEFAULT_CONTAINER
  }
  return LEAF_COLORS[el.tag] ?? DEFAULT_LEAF
}

/** 获取色块内显示的标签文字（优先显示真实文字内容） */
export function elementLabel(el: SnapshotElement): string {
  /** 有文字内容时优先显示文字（截断） */
  if (el.text && el.text.length > 0) {
    return el.text.length > 25 ? el.text.slice(0, 25) + '…' : el.text
  }
  if (el.placeholder) return el.placeholder.slice(0, 20)
  if (el.value) return el.value.slice(0, 20)
  /** 无文字时回退到 tag + idx */
  const parts: string[] = [el.tag]
  if (el.idx !== undefined) parts.push(`#${el.idx}`)
  return parts.join(' ')
}

/**
 * 布局预览计算 hook
 *
 * @param snapshotData 快照数据 Ref（含 rect 的结构化数据）
 * @param sentinelRef  sentinel div 的 Ref（用于 ResizeObserver 测量容器宽度）
 */
export function useLayoutPreview(
  snapshotData: Ref<SnapshotData | null>,
  sentinelRef: Ref<HTMLElement | null>,
) {
  const PREVIEW_PADDING = 32

  /** 容器宽度（响应式，由 ResizeObserver 更新） */
  const containerWidth = ref(800)

  /** 计算缩放比例 */
  const scale = computed(() => {
    const vw = snapshotData.value?.viewportWidth ?? 375
    return Math.max(0.1, (containerWidth.value - PREVIEW_PADDING) / vw)
  })

  /** 带有 rect 的元素列表 */
  const rectElements = computed(() => {
    if (!snapshotData.value?.els) return []
    return snapshotData.value.els.filter((e) => e.rect && e.rect.w > 0 && e.rect.h > 0)
  })

  /** 预览画布尺寸 */
  const canvasWidth = computed(() => {
    const vw = snapshotData.value?.viewportWidth ?? 375
    return Math.round(vw * scale.value)
  })
  /**
   * 画布高度：取所有元素的最大底部（y + h）和 viewportHeight 的较大值。
   * 不能只用 viewportHeight，因为页面有滚动内容时元素 rect.y 会远超视口高度。
   */
  const canvasHeight = computed(() => {
    const vh = snapshotData.value?.viewportHeight ?? 800
    const maxBottom = rectElements.value.reduce((max, el) => {
      const b = (el.rect!.y + el.rect!.h) * scale.value
      return b > max ? b : max
    }, vh * scale.value)
    return Math.round(maxBottom)
  })

  /**
   * 根据 rect + style 返回完整的 CSS 定位 + 视觉样式
   *
   * 优先使用采集到的真实样式（style.bg / style.color / style.fs 等），
   * 没有 style 数据时 fallback 到色块分类（elementColor）。
   */
  function elementStyle(el: SnapshotElement): Record<string, string> {
    if (!el.rect) return {}
    const s = scale.value
    const w = Math.max(2, Math.round(el.rect.w * s))
    const h = Math.max(2, Math.round(el.rect.h * s))
    const styles: Record<string, string> = {
      left: `${Math.round(el.rect.x * s)}px`,
      top: `${Math.round(el.rect.y * s)}px`,
      width: `${w}px`,
      height: `${h}px`,
    }

    const vs = el.style
    if (vs) {
      /** 有真实视觉样式 → 高保真渲染 */
      if (vs.bg) styles.backgroundColor = vs.bg
      if (vs.color) styles.color = vs.color
      if (vs.border) styles.border = vs.border
      else {
        /** 无显式 border 时加细微轮廓以便辨识边界 */
        styles.border = '1px solid rgba(128,128,128,0.15)'
      }
      if (vs.radius) styles.borderRadius = `${Math.max(1, Math.round(vs.radius * s))}px`
      if (vs.align) styles.textAlign = vs.align
      /** 阴影：按缩放比例近似（shadow 值含 px，缩放后视觉差异不大，直接用原值） */
      if (vs.shadow) styles.boxShadow = vs.shadow
      /** 透明度 */
      if (vs.opacity !== undefined) styles.opacity = String(vs.opacity)
      /** 内边距（按缩放比例） */
      if (vs.pad) styles.padding = `${Math.round(vs.pad * s)}px`
      /** 行高（无单位倍数直接用，px 值按缩放） */
      if (vs.lh) {
        styles.lineHeight = vs.lh < 5 ? String(vs.lh) : `${Math.round(vs.lh * s)}px`
      }
      /** 字间距（按缩放比例） */
      if (vs.lsp) styles.letterSpacing = `${Math.round(vs.lsp * s * 10) / 10}px`
      /** 文字修饰 */
      if (vs.tdecor) styles.textDecoration = vs.tdecor
      /** 文字转换 */
      if (vs.ttrans) styles.textTransform = vs.ttrans
      /** 不换行 + 省略 */
      if (vs.noWrap) {
        styles.whiteSpace = 'nowrap'
        styles.textOverflow = 'ellipsis'
        styles.overflow = 'hidden'
      }
      /** 图片缩略图优先（img 元素 > CSS background-image > 渐变） */
      if (vs.img) {
        styles.backgroundImage = `url(${vs.img})`
        styles.backgroundSize = 'cover'
        styles.backgroundPosition = 'center'
      } else if (vs.bgImg) {
        /** CSS background-image 缩略图 */
        styles.backgroundImage = `url(${vs.bgImg})`
        styles.backgroundSize = 'cover'
        styles.backgroundPosition = 'center'
      } else if (vs.gradient) {
        /** 背景渐变（原样传递 CSS 值） */
        styles.backgroundImage = vs.gradient
      }

      /** 字号缩放，但不小于 8px（太小看不见） */
      if (vs.fs) styles.fontSize = `${Math.max(8, Math.round(vs.fs * s))}px`
      if (vs.fw) styles.fontWeight = vs.fw

      /** 可滚动容器：还原 overflow 行为（滚动位置由 ElementPanel 的 onUpdated 设置） */
      if (vs.overflow) {
        const [ovx, ovy] = vs.overflow.split(' ')
        styles.overflowX = ovx === 'visible' ? 'hidden' : ovx
        styles.overflowY = ovy === 'visible' ? 'hidden' : ovy
      } else if (!vs.noWrap) {
        /** 普通元素隐藏溢出（noWrap 的 overflow 已在上面设为 hidden） */
        styles.overflow = 'hidden'
      }
    }

    return styles
  }

  /** 色块是否够大可以显示文字 */
  function canShowLabel(el: SnapshotElement): boolean {
    if (!el.rect) return false
    const s = scale.value
    return el.rect.w * s > 40 && el.rect.h * s > 16
  }

  /** ResizeObserver 逻辑 */
  let resizeObserver: ResizeObserver | null = null

  onMounted(async () => {
    await nextTick()
    if (sentinelRef.value) {
      containerWidth.value = sentinelRef.value.clientWidth
      resizeObserver = new ResizeObserver((entries) => {
        for (const e of entries) {
          const w = e.borderBoxSize?.[0]?.inlineSize ?? e.contentRect.width
          if (w > 0) containerWidth.value = w
        }
      })
      resizeObserver.observe(sentinelRef.value)
    }
  })

  onUnmounted(() => {
    resizeObserver?.disconnect()
  })

  return {
    scale,
    rectElements,
    canvasWidth,
    canvasHeight,
    elementStyle,
    canShowLabel,
  }
}
