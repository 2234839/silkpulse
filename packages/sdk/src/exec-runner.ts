/**
 * exec 通道 —— 接收 server 下发的 JS 代码，在页面执行，回传结果
 *
 * 移植自 pilot 的 exec 设计，改 WS 主动下发：
 * 1. server 通过 WS 发 {type:'exec', execId, code}
 * 2. SDK 端用 new Function 执行 code（非 eval，隔离作用域）
 * 3. 执行期间 console 被单独捕获（startExecCapture / endExecCapture）
 * 4. 回传 {type:'exec-result', execId, result: ExecResult}
 *
 * 暴露给 AI 的页面级辅助函数（exec code 里可直接调用）：
 * - __clarosight_click(idx)
 * - __clarosight_setValue(idx, val) / __clarosight_type(idx, text)
 * - __clarosight_pressKey(idx, key, mods?)
 * - __clarosight_scroll(idx, x, y) / __clarosight_scrollIntoView(idx, block?)
 * - __clarosight_hover(idx)
 * - __clarosight_wait(ms) / __clarosight_snapshot()
 * - __clarosight_sourcemap(...) / __clarosight_sourcemapStack(...)
 */

import type { ServerToDeviceMessage, ExecResult } from '@clarosight/shared'
import { startExecCapture, endExecCapture } from './log-collector.js'
import { takeSnapshot, getElement } from './snapshot.js'
import { resolveOriginalPosition, resolveStack } from './source-map-helper.js'

/** exec 回调类型（由 ws-client 设置，负责 WS 回传） */
export type ExecHandler = (message: ServerToDeviceMessage) => void

let resultSender: ((execId: string, result: ExecResult) => void) | null = null

/** 注册 exec 结果回传器（ws-client 初始化时调用） */
export function setResultSender(sender: (execId: string, result: ExecResult) => void): void {
  resultSender = sender
}

/**
 * 序列化 exec 返回值（限深限长，移植 pilot serializeResult）
 *
 * 截断阈值 20000：足以容纳完整页面快照（__clarosight_snapshot() 的结构化 JSON，
 * 典型 2-8KB，大页面可达 15KB+），同时仍能挡住 `return document` 之类的失误
 * （整个 DOM 序列化远超 20K）。WS 单帧 20K 文本在背压保护下安全。
 */
const MAX_RESULT_LEN = 20000
function serializeResult(val: unknown): string {
  try {
    return JSON.stringify(val, (_, v) => {
      if (typeof v === 'bigint') return String(v)
      if (typeof v === 'function') return `[fn]`
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }
      if (typeof v === 'object' && v !== null && typeof (v as { toISOString?: unknown }).toISOString === 'function') {
        return (v as { toISOString(): string }).toISOString()
      }
      return v
    }, 0)?.slice(0, MAX_RESULT_LEN) ?? 'undefined'
  } catch (e) {
    return `[serialize failed: ${e instanceof Error ? e.message : String(e)}]`
  }
}

/**
 * 安装全局辅助函数（exec code 中可直接调用）
 * 必须在 exec 执行前就挂到 window，否则 new Function 作用域找不到
 */
export function installHelpers(): void {
  const w = window as unknown as Record<string, unknown>

  /**
   * 用原生 setter 设置 input/textarea/select 的 value
   *
   * 直接 el.value = x 在 React 等框架的受控组件上不生效（框架覆盖了 setter）。
   * 用原型链上的原生 setter（各元素 prototype 上的 value setter）绕过。
   * setValue 和 type 共用此 helper，确保两者在 React/Vue 上行为一致。
   * select 走 HTMLSelectElement.prototype.value 的 setter。
   */
  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, val: string): void => {
    let proto: object
    if (el.tagName === 'TEXTAREA') {
      proto = HTMLTextAreaElement.prototype
    } else if (el.tagName === 'SELECT') {
      proto = HTMLSelectElement.prototype
    } else {
      proto = HTMLInputElement.prototype
    }
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) {
      setter.call(el, val)
    } else {
      el.value = val
    }
  }

  /**
   * 用原生 checked setter 设置 checkbox/radio 的勾选状态，绕过框架对 checked 的 setter 覆盖。
   * 与 setNativeValue 同理：React/Vue 受控组件会覆盖 el.checked 的赋值。
   */
  const setNativeChecked = (el: HTMLInputElement, checked: boolean): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set
    if (setter) setter.call(el, checked)
    else el.checked = checked
  }

  /**
   * CSS.escape 转义 name 属性值，用于 querySelector 属性选择器中安全引用。
   * 无 CSS.escape 时回退到双引号包裹 + 转义双引号/反斜杠。
   */
  const cssEscape = (s: string): string => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  /**
   * 点击元素（触发完整鼠标事件序列）
   *
   * 派发 mouseover → mousedown → mouseup → click 四个事件，而非只调 .click()。
   * 原因：线上大量自定义组件（div[role=button]、Vue/React 按钮组件）监听的是
   * mousedown/mouseup 而非 click，只触发 click 对它们无效，表现为"点了没反应"。
   * 最后用 .click() 兜底，确保原生默认行为（a 跳转、button 提交）也生效。
   * hover 类的下拉菜单会在 mouseover 时展开，也一并覆盖。
   */
  w.__clarosight_click = (idx: number): boolean => {
    const el = getElement(idx) as HTMLElement | undefined
    if (!el) return false
    /** MouseEvent 带 bubbles + cancelable，模拟真实用户点击的事件冒泡与可取消性 */
    const opts = { bubbles: true, cancelable: true, view: window }
    el.dispatchEvent(new MouseEvent('mouseover', opts))
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.click()
    return true
  }

  /**
   * 设置表单值（触发 input/change 事件，兼容 Vue/React v-model）
   *
   * 支持 input / textarea / select / checkbox / radio：
   * - input/textarea：用原生 value setter（React 受控组件兼容），触发 input + change
   * - select：设 .value（匹配 option 的 value），触发 change
   * - checkbox：val 为 'true'/'1'/'checked' 勾选，'false'/'0' 取消（原生 checked setter 兼容框架）
   * - radio：val 有值即选中当前，并手动取消同组（同 name）其他 radio —— 合成事件不触发
   *   浏览器的 pre-click 默认行为，互斥需自行实现
   */
  w.__clarosight_setValue = (idx: number, val: string): boolean => {
    const el = getElement(idx) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined
    if (!el) return false
    /** checkbox/radio：设 checked 而非 value */
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const input = el as HTMLInputElement
      /** radio 一旦选中无法取消；checkbox 按 val 判定 */
      const shouldCheck = el.type === 'radio'
        ? true
        : val === 'true' || val === '1' || val === 'checked'
      setNativeChecked(input, shouldCheck)
      /**
       * radio 互斥：合成事件不触发浏览器的 pre-click activation（只有 el.click() 或真实点击才触发），
       * 所以同组其他已选中的 radio 需手动取消，并对每个被取消的派发 change（与浏览器行为一致）
       */
      if (el.type === 'radio' && input.name) {
        for (const other of document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${cssEscape(input.name)}"]`)) {
          if (other !== input && other.checked) {
            setNativeChecked(other, false)
            other.dispatchEvent(new Event('change', { bubbles: true }))
          }
        }
      }
      /** checkbox/radio 的框架事件常绑在 click/change 上，两种都触发 */
      input.dispatchEvent(new Event('click', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    setNativeValue(el, val)
    /** select 主要监听 change；input/textarea 主要监听 input。两种都触发，覆盖所有框架约定 */
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  /**
   * 模拟键盘逐字输入（触发 keydown/keypress/input/keyup 序列）
   * 用于搜索框 autocomplete、监听 keyup 的场景，setValue 不够用时使用
   */
  w.__clarosight_type = (idx: number, text: string): boolean => {
    const el = getElement(idx) as HTMLInputElement | undefined
    if (!el) return false
    el.focus()
    setNativeValue(el, '')
    for (const ch of text) {
      /**
       * 逐字累加也要用原生 setter —— 直接 el.value += ch 在 React 受控组件上
       * 会被框架覆盖，导致输入不生效。每次累加后用 setNativeValue 写入完整值。
       */
      setNativeValue(el, el.value + ch)
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }))
    }
    return true
  }

  /** 异步等待（exec code 中 await __clarosight_wait(100)） */
  w.__clarosight_wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /**
   * 滚动页面或元素到指定位置
   *
   * 两种模式：
   * - 不传 idx（idx < 0）：滚动整个窗口（window.scrollTo）
   * - 传 idx：滚动该元素内部（如 overflow:auto 的 div）
   *
   * 用途：触发懒加载、检查 sticky 定位、滚动到折叠区域查看内容。
   * 滚动后 AI 应重新 __clarosight_snapshot() 看页面变化。
   */
  w.__clarosight_scroll = (idx: number, x: number, y: number): boolean => {
    if (idx < 0) {
      window.scrollTo(x, y)
      return true
    }
    const el = getElement(idx)
    if (!el) return false
    ;(el as HTMLElement).scrollTo(x, y)
    return true
  }

  /**
   * 滚动元素到可视区域（scrollIntoView）
   *
   * 用于让某个元素滚入视野：检查懒加载元素、让 sticky header 遮挡的元素可见。
   * block/inline 参数对应原生 scrollIntoViewOptions，默认 'center'（居中展示）。
   */
  w.__clarosight_scrollIntoView = (idx: number, block: ScrollLogicalPosition = 'center'): boolean => {
    const el = getElement(idx)
    if (!el) return false
    ;(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' })
    return true
  }

  /**
   * 鼠标悬停（模拟 hover，触发 mouseover/mouseenter 事件）
   *
   * 用于诊断 hover 展开的下拉菜单、tooltip、CSS :hover 样式变化。
   * CSS :hover 伪类无法通过 JS 直接触发，但 mouseover/mouseenter 事件能
   * 覆盖依赖 JS 的 hover 逻辑（大部分框架组件的下拉/tooltip）。
   */
  w.__clarosight_hover = (idx: number): boolean => {
    const el = getElement(idx)
    if (!el) return false
    const target = el as HTMLElement
    target.focus?.()
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }))
    target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true }))
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }))
    return true
  }

  /**
   * 按键（模拟键盘输入，派发 keydown + keyup 事件）
   *
   * 用于诊断键盘交互：Enter 提交表单、Escape 关闭弹窗、Tab 切换焦点、
   * 方向键导航、快捷键（Ctrl+S 等）。
   * 某些框架（Vue @keydown、React onKeyDown）只认 keydown，部分（监听 keyup 的
   * 搜索框、Autocomplete）需要 keyup —— 两者都派发覆盖主流场景。
   *
   * idx 指定目标元素（先 focus 再按键）；idx<0 时对当前 activeElement 按键。
   * mods 可选修饰键 { ctrl, shift, alt, meta }，用于模拟组合键。
   */
  w.__clarosight_pressKey = (
    idx: number,
    /** KeyboardEvent.key 值，如 'Enter' / 'Escape' / 'ArrowDown' / 'a' */
    key: string,
    mods?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
  ): boolean => {
    let target: Element | undefined
    if (idx < 0) {
      target = document.activeElement ?? undefined
    } else {
      target = getElement(idx)
    }
    if (!target) return false
    const el = target as HTMLElement
    el.focus?.()
    const opts: KeyboardEventInit = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      ctrlKey: mods?.ctrl ?? false,
      shiftKey: mods?.shift ?? false,
      altKey: mods?.alt ?? false,
      metaKey: mods?.meta ?? false,
    }
    const keyDown = new KeyboardEvent('keydown', opts)
    const keyUp = new KeyboardEvent('keyup', opts)
    el.dispatchEvent(keyDown)
    el.dispatchEvent(keyUp)
    return true
  }

  /** 取页面快照（exec code 也可手动调用） */
  w.__clarosight_snapshot = (): ReturnType<typeof takeSnapshot> => takeSnapshot()

  /**
   * source map 解析：把压缩代码位置映射回原始源码位置
   * 用法：const pos = await __clarosight_sourcemap(line, col, sourceUrl?)
   * sourceUrl 省略时用当前页面 URL
   * 返回 { source, line, column, name? } 或 null
   */
  w.__clarosight_sourcemap = (
    line: number,
    col: number,
    sourceUrl?: string,
  ): Promise<import('@clarosight/shared').SourceMapPosition | null> =>
    resolveOriginalPosition(sourceUrl ?? location.href, line, col)

  /**
   * 批量解析堆栈帧（紧凑文本输出，AI 直接读）
   * 用法：const lines = await __clarosight_sourcemapStack([{url, line, col}, ...])
   */
  w.__clarosight_sourcemapStack = (
    frames: Array<{ url: string; line: number; col: number }>,
  ): Promise<string[]> => resolveStack(frames)

  /**
   * 查询页面存储（localStorage / sessionStorage / cookie）
   *
   * 远程调试高频需求：登录态/token 存 localStorage、用户配置存 sessionStorage、
   * 会话信息存 cookie。用户报"登录态丢了""接口 401""显示异常"时，根因常在 storage。
   * 不用这个函数就得手写 Object.keys(localStorage).map(...)，笨重且易出错。
   *
   * type: 'local'（默认）/ 'session' / 'cookie'
   * 返回 { key: value } 对象，单个值截断到 200 字符（防过大值撑爆 exec 结果）
   */
  w.__clarosight_storage = (
    /** 查询类型：localStorage / sessionStorage / cookie */
    type: 'local' | 'session' | 'cookie' = 'local',
  ): Record<string, string> => {
    /** 单个值最大长度：超长截断（如 base64 图片、JWT 较长，留头部够诊断） */
    const MAX_VAL = 200
    const truncate = (s: string): string => (s.length > MAX_VAL ? s.slice(0, MAX_VAL) + `…(${s.length})` : s)
    if (type === 'cookie') {
      const result: Record<string, string> = {}
      /** document.cookie 是 "k1=v1; k2=v2" 格式，HttpOnly cookie 拿不到（浏览器限制） */
      for (const part of document.cookie.split(';')) {
        const eq = part.indexOf('=')
        if (eq > 0) {
          const k = part.slice(0, eq).trim()
          result[k] = truncate(part.slice(eq + 1).trim())
        }
      }
      return result
    }
    const store = type === 'session' ? sessionStorage : localStorage
    const result: Record<string, string> = {}
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k) result[k] = truncate(store.getItem(k) || '')
    }
    return result
  }
}

/**
 * SDK 端 exec 超时（ms），比 server 端（10s）早 1s 触发
 *
 * 异步永不 resolve 的代码（如 `return new Promise(() => {})`）会让 await fn() 永久挂起。
 * 若靠 server 端 10s 超时来兜底，server 会回"超时"给 AI，但 SDK 端的 promise 仍泄漏、
 * exec 日志捕获队列永不结束。SDK 端先于 server 触发，能干净地回传超时 + 释放资源。
 * 同步死循环（while(true){}）无法救——它阻塞主线程，连定时器都跑不了。
 */
const SDK_EXEC_TIMEOUT = 9000

/**
 * 处理 server 下发的 exec 指令
 * 异步执行 code，捕获 console，取快照，回传 ExecResult
 */
export async function handleExec(code: string, execId: string): Promise<void> {
  startExecCapture()
  let success = true
  let result: string | undefined
  let error: string | undefined

  try {
    /**
     * 把 code 作为 async 函数体执行 —— AI 可以写多条语句，自己决定 return 什么。
     * 辅助函数（__clarosight_click 等）已挂到 window，函数体内可直接访问。
     */
    const fn = new Function(`"use strict"; return (async () => {\n${code}\n})()`) as () => Promise<unknown>
    /**
     * 超时兜底 + 定时器清理
     *
     * 正常完成时必须 clearTimeout，否则：
     * 1. 定时器句柄泄漏 9s
     * 2. 超时 promise reject 时无人接住 → 触发 unhandledrejection →
     *    被 error-catcher 当成设备错误上报，污染 errorCount
     */
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('执行超时（SDK 9s）')), SDK_EXEC_TIMEOUT)
    })
    try {
      const ret = await Promise.race([fn(), timeoutPromise])
      result = serializeResult(ret)
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (e) {
    success = false
    /**
     * 错误信息增强：运行时错误附带 stack（截断 6 行），帮 AI 定位出错位置。
     * 语法错误（SyntaxError 无 stack）只返回 name: message。
     * stack 含压缩代码位置没关系——source map 解析能力已具备，AI 可进一步解析。
     */
    if (e instanceof Error) {
      error = `${e.name}: ${e.message}`
      if (e.stack) {
        const stackLines = e.stack.split('\n').slice(0, 6).join('\n')
        error += `\n${stackLines}`
      }
    } else {
      error = String(e)
    }
  }

  const logs = endExecCapture()

  /** exec 后自动取一次快照，让 AI 看到 操作后的页面变化 */
  let snapshotText: string | undefined
  if (success) {
    try {
      const snap = takeSnapshot()
      snapshotText = JSON.stringify(snap)
    } catch {
      /** 快照失败不影响 exec 结果回传 */
    }
  }

  resultSender?.(execId, { success, result, error, logs, snapshotText })
}
