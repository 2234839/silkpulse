/**
 * 结构化序列化器 —— 把任意 JS 值转为 SerializedValue 节点树
 *
 * 用于 exec 返回值的可交互对象树展示（类似 DevTools console）。
 * 前端拿到 SerializedValue 后递归渲染为可展开/折叠的树。
 *
 * 核心设计：
 * - WeakSet 检测循环引用（祖先链模式：进递归 add，出递归 delete）
 * - 限深 maxDepth=5，超限显示 ...
 * - 每层限 50 个属性/元素（DevTools 也有限制）
 * - 特殊类型（Date/RegExp/Error/Map/Set/Element 等）有专属 type + preview
 */

import type { SerializedValue, SerializedProperty } from '@clarosight/shared'

/** 最大递归深度（防止深层嵌套爆栈和性能问题） */
const MAX_DEPTH = 5
/** 每层最多展开的属性/元素数 */
const MAX_ENTRIES = 50

/**
 * 主序列化入口
 *
 * @param val 要序列化的值
 * @param depth 当前递归深度
 * @param seen 祖先链 WeakSet（循环引用检测）
 * @param refMap 对象→refId 映射（跨树去重，同一对象第二次出现用 refId 标记）
 */
export function toSerializedValue(
  val: unknown,
  depth = 0,
  seen?: WeakMap<object, number>,
  refMap?: Map<object, number>,
): SerializedValue {
  /** 基本类型直接返回 */
  if (val === null) return { type: 'null', preview: 'null', value: 'null' }
  if (val === undefined) return { type: 'undefined', preview: 'undefined', value: 'undefined' }
  if (typeof val === 'string') return { type: 'string', preview: `"${truncate(val, 100)}"`, value: val }
  if (typeof val === 'number') return { type: 'number', preview: String(val), value: val }
  if (typeof val === 'boolean') return { type: 'boolean', preview: String(val), value: val }
  if (typeof val === 'bigint') return { type: 'bigint', preview: `${val}n`, value: String(val) }
  if (typeof val === 'symbol') {
    return { type: 'symbol', preview: val.toString() }
  }

  /** function */
  if (typeof val === 'function') {
    const name = (val as { name?: string }).name || 'anonymous'
    const isAsync = val.constructor?.name === 'AsyncFunction'
    const isGen = val.constructor?.name === 'GeneratorFunction'
    const prefix = isAsync ? 'async ' : isGen ? 'function* ' : 'ƒ '
    return { type: 'function', preview: `${prefix}${name}()`, constructorName: 'Function' }
  }

  /** 到此一定是 object，做循环引用检测 */
  const obj = val as object

  /** 初始化 seen/refMap（仅在最外层创建一次） */
  if (!seen) seen = new WeakMap()
  if (!refMap) refMap = new Map()

  /** 循环引用检测：如果这个对象在祖先链上出现过 */
  const refSeen = seen.get(obj)
  if (refSeen !== undefined) {
    return { type: 'object', preview: '[Circular]', refId: refSeen }
  }

  /** 分配 refId（每个对象一个唯一 id） */
  let refId: number | undefined
  if (refMap.has(obj)) {
    /** 这个对象之前在别的分支已经展开过了，标记为引用 */
    refId = refMap.get(obj)!
    return { type: 'object', preview: getPreview(val), refId }
  } else {
    refId = refMap.size + 1
    refMap.set(obj, refId)
  }

  /** 标记当前对象在祖先链上 */
  seen.set(obj, refId)

  try {
    const result = serializeObject(val, depth, seen, refMap, refId)
    return result
  } finally {
    /** 退出祖先链 */
    seen.delete(obj)
  }
}

/**
 * 序列化对象/数组/特殊类型
 */
function serializeObject(
  val: unknown,
  depth: number,
  seen: WeakMap<object, number>,
  refMap: Map<object, number>,
  refId: number,
): SerializedValue {
  const obj = val as object

  /** 超过最大深度：返回截断标记 */
  if (depth >= MAX_DEPTH) {
    return { type: 'object', preview: '…', refId }
  }

  /** Date */
  if (val instanceof Date) {
    return { type: 'date', preview: val.toISOString(), constructorName: 'Date' }
  }

  /** RegExp */
  if (val instanceof RegExp) {
    return { type: 'regexp', preview: val.toString(), constructorName: 'RegExp' }
  }

  /** Error */
  if (val instanceof Error) {
    const props: SerializedProperty[] = [
      { key: 'message', value: toSerializedValue(val.message, depth + 1, seen, refMap) },
      { key: 'stack', value: toSerializedValue(val.stack, depth + 1, seen, refMap) },
    ]
    return { type: 'error', preview: `${val.name}: ${val.message}`, properties: props, constructorName: val.name }
  }

  /** Map */
  if (val instanceof Map) {
    const entries = Array.from(val.entries()).slice(0, MAX_ENTRIES)
    const props: SerializedProperty[] = entries.map(([k, v], i) => ({
      key: formatKey(k),
      value: toSerializedValue(v, depth + 1, seen, refMap),
    }))
    return {
      type: 'map',
      preview: `Map(${val.size})`,
      properties: props,
      length: val.size,
      constructorName: 'Map',
      refId,
    }
  }

  /** Set */
  if (val instanceof Set) {
    const values = Array.from(val).slice(0, MAX_ENTRIES)
    const elements: SerializedValue[] = values.map((v) => toSerializedValue(v, depth + 1, seen, refMap))
    return {
      type: 'set',
      preview: `Set(${val.size})`,
      elements,
      length: val.size,
      constructorName: 'Set',
      refId,
    }
  }

  /** WeakMap / WeakSet（不可遍历） */
  if (val instanceof WeakMap) {
    return { type: 'weakmap', preview: 'WeakMap { … }', constructorName: 'WeakMap', refId }
  }
  if (val instanceof WeakSet) {
    return { type: 'weakset', preview: 'WeakSet { … }', constructorName: 'WeakSet', refId }
  }

  /** Promise */
  if (val instanceof Promise) {
    return { type: 'promise', preview: 'Promise { <pending> }', constructorName: 'Promise', refId }
  }

  /** DOM Element */
  if (val instanceof Element) {
    const el = val as Element
    const tag = el.tagName.toLowerCase()
    const id = el.id ? `#${el.id}` : ''
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : ''
    const text = el.textContent?.trim().slice(0, 30)
    const props: SerializedProperty[] = [
      { key: 'tagName', value: toSerializedValue(tag.toUpperCase(), depth + 1, seen, refMap) },
      { key: 'id', value: toSerializedValue(el.id, depth + 1, seen, refMap) },
      { key: 'className', value: toSerializedValue(el.className, depth + 1, seen, refMap) },
      { key: 'innerHTML', value: toSerializedValue(el.innerHTML?.slice(0, 200), depth + 1, seen, refMap) },
    ]
    return {
      type: 'element',
      preview: `<${tag}${id}${cls}>${text ? ' ' + truncate(text, 30) : ''}</${tag}>`,
      properties: props,
      constructorName: el.constructor?.name || tag.toUpperCase(),
      refId,
    }
  }

  /** Text Node */
  if (val instanceof Text) {
    const text = (val as Text).textContent || ''
    return { type: 'textnode', preview: `#text "${truncate(text, 50)}"`, constructorName: 'Text', refId }
  }

  /** Event */
  if (typeof Event !== 'undefined' && val instanceof Event) {
    const ev = val as Event
    return {
      type: 'event',
      preview: `[${ev.constructor?.name || 'Event'} type=${ev.type}]`,
      constructorName: ev.constructor?.name || 'Event',
      refId,
    }
  }

  /** Array */
  if (Array.isArray(val)) {
    const elements = val.slice(0, MAX_ENTRIES).map((v) => toSerializedValue(v, depth + 1, seen, refMap))
    return {
      type: 'array',
      preview: `Array(${val.length}) [${val.slice(0, 3).map(previewOne).join(', ')}${val.length > 3 ? ', …' : ''}]`,
      elements,
      length: val.length,
      constructorName: 'Array',
      refId,
    }
  }

  /** TypedArray */
  if (ArrayBuffer.isView(val)) {
    const arr = val as { length: number; [i: number]: unknown }
    const elements: SerializedValue[] = Array.from({ length: Math.min(arr.length, MAX_ENTRIES) }, (_, i) =>
      toSerializedValue(arr[i], depth + 1, seen, refMap),
    )
    const name = (val as { constructor: { name: string } }).constructor.name
    return {
      type: 'array',
      preview: `${name}(${arr.length})`,
      elements,
      length: arr.length,
      constructorName: name,
      refId,
    }
  }

  /** 普通对象 */
  const ctorName = (val as { constructor?: { name?: string } }).constructor?.name
  const isPlain = !ctorName || ctorName === 'Object'

  /** 收集自身 + 原型链第一层属性名 */
  const allKeys: { key: string; isSymbol: boolean; isGetter: boolean }[] = []
  const seenKeys = new Set<string>()

  /** 自身可枚举属性 */
  for (const k of Object.keys(val)) {
    if (!seenKeys.has(k)) {
      seenKeys.add(k)
      allKeys.push({ key: k, isSymbol: false, isGetter: false })
    }
  }

  /** 自身不可枚举属性（Web API 对象如 Navigator/Location 的属性大多在此） */
  for (const k of Object.getOwnPropertyNames(val)) {
    if (!seenKeys.has(k)) {
      seenKeys.add(k)
      allKeys.push({ key: k, isSymbol: false, isGetter: false })
    }
  }

  /**
   * 原型链属性（最多遍历 3 层）
   *
   * 很多 Web API 对象（navigator, location, history 等）的属性
   * 定义在原型链上而非实例自身，需要遍历原型链才能采集到。
   */
  let proto = Object.getPrototypeOf(val)
  let protoDepth = 0
  while (proto && protoDepth < 3 && allKeys.length < MAX_ENTRIES) {
    try {
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k === 'constructor') continue
        if (!seenKeys.has(k)) {
          seenKeys.add(k)
          allKeys.push({ key: k, isSymbol: false, isGetter: false })
        }
      }
    } catch { /** 安全降级 */ }
    proto = Object.getPrototypeOf(proto)
    protoDepth++
  }

  /** Symbol 属性 */
  const symbols = Object.getOwnPropertySymbols(val)
  for (const s of symbols) {
    const key = s.toString()
    if (!seenKeys.has(key)) {
      seenKeys.add(key)
      allKeys.push({ key: s.description || key, isSymbol: true, isGetter: false })
    }
  }

  /** 取属性值 + 检测 getter */
  const props: SerializedProperty[] = []
  for (const { key, isSymbol } of allKeys.slice(0, MAX_ENTRIES)) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(val, key)
      const isGetter = !!descriptor && typeof descriptor.get === 'function'
      const rawVal = (val as Record<string, unknown>)[key]
      props.push({
        key,
        value: toSerializedValue(rawVal, depth + 1, seen, refMap),
        isGetter,
        isSymbol,
      })
    } catch {
      /** getter 抛错时跳过 */
      props.push({ key, value: { type: 'unknown', preview: '[getter throws]' }, isGetter: true, isSymbol })
    }
  }

  const previewKeys = allKeys.slice(0, 3).map((k) => k.key)
  const previewBody = previewKeys.map((k) => {
    try {
      return `${k}: ${previewOne((val as Record<string, unknown>)[k])}`
    } catch {
      return `${k}: …`
    }
  }).join(', ')

  return {
    type: 'object',
    preview: `${isPlain ? '{' : (ctorName || 'Object') + ' {'}${previewBody ? ' ' + previewBody : ''}${allKeys.length > 3 ? ', …' : ''} }`,
    properties: props,
    constructorName: isPlain ? undefined : ctorName,
    refId,
  }
}

/** 单个值的预览（一行摘要） */
function previewOne(val: unknown): string {
  if (val === null) return 'null'
  if (val === undefined) return 'undefined'
  const t = typeof val
  if (t === 'string') return `"${truncate(val as string, 30)}"`
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(val)
  if (t === 'function') return `ƒ ${(val as { name?: string }).name || ''}()`
  if (Array.isArray(val)) return `Array(${val.length})`
  if (t === 'object') {
    const ctorName = (val as { constructor?: { name?: string } }).constructor?.name
    if (ctorName && ctorName !== 'Object') return ctorName
    return '{…}'
  }
  return String(val)
}

/** 获取对象预览文本 */
function getPreview(val: unknown): string {
  return previewOne(val)
}

/** 格式化 Map key */
function formatKey(k: unknown): string {
  if (typeof k === 'string') return k
  if (typeof k === 'number') return String(k)
  if (typeof k === 'symbol') return k.toString()
  return String(k)
}

/** 截断字符串 */
function truncate(s: string | null | undefined, max: number): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}
