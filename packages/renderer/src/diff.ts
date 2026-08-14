/**
 * 快照增量 diff 引擎
 *
 * 对比新旧两份 SnapshotData，输出三种补丁：
 * - added：新出现的元素（需创建 DOM 节点）
 * - updated：属性变化的已存在元素（需更新 style/class）
 * - removed：消失的元素（需删除 DOM 节点）
 *
 * 以 idx 为 key 做映射，O(n) 时间复杂度。
 * 控制台渲染层拿到 diff 后只操作受影响的节点，避免全量重渲染。
 */
import type { SnapshotData, SnapshotElement } from '@silkpulse/shared'
import { diffText, type TextDiffSegment } from './text-diff.js'

/** 单个元素的变更补丁 */
export interface ElementPatch {
  /** 元素稳定索引 */
  idx: number
  /** 新的元素数据（added/updated 时有值，removed 时无值） */
  el?: SnapshotElement
  /**
   * 文本内容的字符级 diff（仅当 text 字段发生变化时有值）
   *
   * 消费方可据此高亮显示"改了哪些字符"，而非只展示新全文。
   * 基于 grapheme cluster 分割，正确处理 emoji / 组合字符 / 国旗等。
   */
  textDiff?: TextDiffSegment[]
}

/** diff 结果 */
export interface SnapshotDiff {
  /** 新增的元素 */
  added: ElementPatch[]
  /** 更新的元素（属性或 style 发生了变化） */
  updated: ElementPatch[]
  /** 删除的元素 */
  removed: ElementPatch[]
  /** 视口是否变化（影响画布尺寸重计算） */
  viewportChanged: boolean
  /** 快照是否完全不同（首次加载 / URL 切换 → 全量渲染，不走增量） */
  fullRefresh: boolean
}

/**
 * 浅比较两个元素的「视觉相关」字段是否变化
 *
 * 只比较影响渲染的字段：rect / style / text / tag / state / focused 等。
 * 跳过 idx（不变）、href、aria 等不影响布局外观的字段。
 */
function isVisualChanged(old_: SnapshotElement, new_: SnapshotElement): boolean {
  if (old_.tag !== new_.tag) return true
  if (old_.text !== new_.text) return true
  if (old_.focused !== new_.focused) return true
  if (old_.state !== new_.state) return true
  if (old_.disabled !== new_.disabled) return true
  if (old_.value !== new_.value) return true
  if (old_.placeholder !== new_.placeholder) return true

  /** rect 变化（位置/尺寸） */
  const or = old_.rect
  const nr = new_.rect
  if (!or !== !nr) return true
  if (or && nr && (or.x !== nr.x || or.y !== nr.y || or.w !== nr.w || or.h !== nr.h)) return true

  /** style 变化（浅比 JSON 字符串，style 对象小，开销可接受） */
  const os = JSON.stringify(old_.style)
  const ns = JSON.stringify(new_.style)
  if (os !== ns) return true

  return false
}

/**
 * 计算新旧快照的增量 diff
 *
 * @param old_ 上一份快照（null 表示首次加载 → fullRefresh）
 * @param new_ 当前快照
 * @returns diff 补丁集
 */
export function diffSnapshots(old_: SnapshotData | null, new_: SnapshotData): SnapshotDiff {
  /** 首次加载或 URL 变了 → 全量刷新 */
  if (!old_ || old_.url !== new_.url) {
    return {
      added: new_.els.map((el) => ({ idx: el.idx, el })),
      updated: [],
      removed: [],
      viewportChanged: true,
      fullRefresh: true,
    }
  }

  /** 构建 old idx → element 映射 */
  const oldMap = new Map<number, SnapshotElement>()
  for (const el of old_.els) oldMap.set(el.idx, el)

  /** 构建 new idx → element 映射 */
  const newMap = new Map<number, SnapshotElement>()
  for (const el of new_.els) newMap.set(el.idx, el)

  const added: ElementPatch[] = []
  const updated: ElementPatch[] = []
  const removed: ElementPatch[] = []

  /** 遍历新快照：分类 added / updated */
  for (const [idx, newEl] of newMap) {
    const oldEl = oldMap.get(idx)
    if (!oldEl) {
      added.push({ idx, el: newEl })
    } else if (isVisualChanged(oldEl, newEl)) {
      /**
       * 文本变化时附带字符级 diff。
       * 只在 text 字段确实不同时生成（空 vs 空 不生成），
       * 避免非 text 变化（如 rect/style）时浪费计算。
       */
      const patch: ElementPatch = { idx, el: newEl }
      if (oldEl.text !== newEl.text && (oldEl.text || newEl.text)) {
        patch.textDiff = diffText(oldEl.text ?? '', newEl.text ?? '')
      }
      updated.push(patch)
    }
    /** 没变化的不进任何列表（增量渲染的核心收益） */
  }

  /** 遍历旧快照：找出 removed */
  for (const [idx] of oldMap) {
    if (!newMap.has(idx)) {
      removed.push({ idx })
    }
  }

  const viewportChanged =
    old_.viewportWidth !== new_.viewportWidth ||
    old_.viewportHeight !== new_.viewportHeight

  return { added, updated, removed, viewportChanged, fullRefresh: false }
}
