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
 * - __silkpulse_click(idx)
 * - __silkpulse_setValue(idx, val) / __silkpulse_type(idx, text)
 * - __silkpulse_pressKey(idx, key, mods?)
 * - __silkpulse_scroll(idx, x, y) / __silkpulse_scrollIntoView(idx, block?)
 * - __silkpulse_hover(idx)
 * - __silkpulse_wait(ms) / __silkpulse_snapshot()
 * - __silkpulse_sourcemap(...) / __silkpulse_sourcemapStack(...)
 * - __silkpulse_screenshot(idx?, opts?) — 截取页面或指定元素，返回 dataURL
 */

import type { ServerToDeviceMessage, ExecResult } from '@silkpulse/shared'
import { startExecCapture, endExecCapture } from './log-collector.js'
import { takeSnapshot, getElement, ensureElementIdx } from './snapshot.js'
import { resolveOriginalPosition, resolveStack } from './source-map-helper.js'
import { toSerializedValue } from './serialize-value.js'

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
 * 截断阈值 500000：截图 dataURL（JPEG base64）可达 50-300KB，
 * 需完整传输才能正确解码。快照 JSON 典型 2-8KB，大页面可达 15KB+。
 */
const MAX_RESULT_LEN = 500000
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
  w.__silkpulse_click = (idx: number): boolean => {
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
   *
   * React 18 对 checkbox/radio 的 onChange 特殊性：
   * React 在 root 上委托 click 事件，内部用 inputValueTracking 对比 click 前后的 checked 值。
   * 如果提前 setChecked 再 dispatchEvent click，React 看到 checked 没变化（和 tracker 相同），不触发 onChange。
   * 正确做法：让 .click() 的浏览器原生 pre-click activation 来切换 checked 状态，
   * 这样 React 能检测到 before ≠ after，从而触发 onChange。
   */
  w.__silkpulse_setValue = (idx: number, val: string): boolean => {
    const el = getElement(idx) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined
    if (!el) return false
    /** checkbox/radio：通过 .click() 让浏览器原生切换状态 */
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const input = el as HTMLInputElement
      const shouldCheck = el.type === 'radio'
        ? true
        : val === 'true' || val === '1' || val === 'checked'
      /**
       * 如果目标状态和当前状态相同，.click() 会反而在 checkbox 上取消勾选。
       * 此时需要先重置为反状态，再 .click() 让浏览器切到目标状态。
       */
      if (input.checked === shouldCheck && el.type === 'checkbox') {
        setNativeChecked(input, !shouldCheck)
      }
      /**
       * radio 如果已经选中，.click() 无法改变状态，框架检测不到变化。
       * 先手动取消选中触发 onChange(checked=false)，然后 .click() 重新选中触发 onChange(checked=true)。
       */
      if (el.type === 'radio' && input.checked) {
        setNativeChecked(input, false)
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      /**
       * radio 互斥：浏览器 .click() 的 pre-click activation 会自动取消同组其他 radio，
       * 但只在同 frame 内有效。提前手动取消 + dispatchEvent change，覆盖边缘情况。
       */
      if (el.type === 'radio' && input.name) {
        for (const other of document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${cssEscape(input.name)}"]`)) {
          if (other !== input && other.checked) {
            setNativeChecked(other, false)
            other.dispatchEvent(new Event('change', { bubbles: true }))
          }
        }
      }
      /** .click() 触发浏览器原生 pre-click activation（切换 checked） + 冒泡 click 事件 → React/Vue onChange */
      input.click()
      /** 额外派发 change 事件，覆盖不监听 click 只监听 change 的场景 */
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
  w.__silkpulse_type = (idx: number, text: string): boolean => {
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

  /** 异步等待（exec code 中 await __silkpulse_wait(100)） */
  w.__silkpulse_wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /**
   * 滚动页面或元素到指定位置
   *
   * 两种模式：
   * - 不传 idx（idx < 0）：滚动整个窗口（window.scrollTo）
   * - 传 idx：滚动该元素内部（如 overflow:auto 的 div）
   *
   * 用途：触发懒加载、检查 sticky 定位、滚动到折叠区域查看内容。
   * 滚动后 AI 应重新 __silkpulse_snapshot() 看页面变化。
   */
  w.__silkpulse_scroll = (idx: number, x: number, y: number): boolean => {
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
  w.__silkpulse_scrollIntoView = (idx: number, block: ScrollLogicalPosition = 'center'): boolean => {
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
   *
   * 连续 hover 不同元素时，会对上一个 hovered 元素先触发 mouseout/mouseleave，
   * 模拟真实鼠标移动行为（React onMouseLeave / Vue @mouseleave 需要此事件）。
   */
  w.__silkpulse_hover = (idx: number): boolean => {
    const el = getElement(idx)
    if (!el) return false
    const target = el as HTMLElement

    /** 对上一个 hovered 元素触发离开事件 */
    const prev = (w as unknown as { __silkpulse_lastHover?: Element }).__silkpulse_lastHover
    if (prev && prev !== target && prev.isConnected) {
      prev.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, relatedTarget: target }))
      prev.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true, relatedTarget: target }))
    }
    ;(w as unknown as { __silkpulse_lastHover?: Element }).__silkpulse_lastHover = target

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
  w.__silkpulse_pressKey = (
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
    const keyPress = new KeyboardEvent('keypress', opts)
    const keyUp = new KeyboardEvent('keyup', opts)
    el.dispatchEvent(keyDown)
    el.dispatchEvent(keyPress)
    el.dispatchEvent(keyUp)
    return true
  }

  /** 取页面快照（exec code 也可手动调用） */
  w.__silkpulse_snapshot = (): ReturnType<typeof takeSnapshot> => takeSnapshot()

  /**
   * source map 解析：把压缩代码位置映射回原始源码位置
   * 用法：const pos = await __silkpulse_sourcemap(line, col, sourceUrl?)
   * sourceUrl 省略时用当前页面 URL
   * 返回 { source, line, column, name? } 或 null
   */
  w.__silkpulse_sourcemap = (
    line: number,
    col: number,
    sourceUrl?: string,
  ): Promise<import('@silkpulse/shared').SourceMapPosition | null> =>
    resolveOriginalPosition(sourceUrl ?? location.href, line, col)

  /**
   * 批量解析堆栈帧（紧凑文本输出，AI 直接读）
   * 用法：const lines = await __silkpulse_sourcemapStack([{url, line, col}, ...])
   */
  w.__silkpulse_sourcemapStack = (
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
  w.__silkpulse_storage = (
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

  /**
   * 给任意元素打稳定 idx（Element 面板用）
   *
   * snapshot 只给可见/交互元素打 idx，Element 面板要展示全量 DOM 树，
   * 需要给所有元素打 idx 供后续诊断/操作定位。
   * 已有 idx 就复用；没有就分配新的（写入 elementsRegistry）。
   * 返回 -1 表示元素已脱离文档。
   */
  w.__silkpulse_ensureIdx = (el: Element): number => ensureElementIdx(el)

  /**
   * 按 idx 取元素（Element 面板的 inspect 代码用）
   *
   * 与 getElement 模块内版本一致，挂 window 让 exec 代码可调。
   * 注意：ensureElementIdx 打的 idx 不写 DOM 属性（避免污染），
   * 所以不能用 querySelector 反查，必须走 elementsRegistry。
   */
  w.__silkpulse_getElement = (idx: number): Element | undefined => getElement(idx)

  /**
   * 截取页面或指定元素的截图（返回 dataURL）
   *
   * 用 SnapDOM 的 toCanvas 将 DOM 渲染为 canvas，再编码为 JPEG/PNG dataURL。
   * Agent 通过 exec 调用此函数获取页面可视化快照。
   *
   * @param idx  元素 idx（来自 snapshot/element-tree），不传则截取整个 body（viewport）
   * @param opts 截图选项
   * @returns dataURL 字符串（可直接用于 <img> 或下载）
   *
   * 用法：
   * - 全页截图：return await __silkpulse_screenshot()
   * - 指定元素：return await __silkpulse_screenshot(42)
   * - 高质量 PNG：return await __silkpulse_screenshot(42, { format:'png', scale:2 })
   */
  w.__silkpulse_screenshot = async (
    idx?: number,
    opts?: { format?: 'jpg' | 'png' | 'webp'; quality?: number; scale?: number; backgroundColor?: string },
  ): Promise<string> => {
    /** dynamic import snapdom（避免 exec-runner 同步加载依赖） */
    const { snapdom } = await import('@zumer/snapdom')

    /** 确定截图目标：指定 idx 的元素，或 document.body */
    const target = idx != null ? getElement(idx) : document.body
    if (!target) {
      throw new Error(`__silkpulse_screenshot: idx=${idx} 对应的元素不存在`)
    }

    /** 合并默认选项 */
    const format = opts?.format ?? 'jpg'
    const quality = opts?.quality ?? 0.8
    const scale = opts?.scale ?? 1
    const backgroundColor = opts?.backgroundColor ?? '#ffffff'

    /** baseCSS 修复 flex/grid 容器内 truncate 文字溢出（详见 screen-capture.ts 注释） */
    const baseCSS = `* { min-width: 0 !important; }`

    /** 根据格式选择 SnapDOM 导出方法 */
    if (format === 'png') {
      const img = await snapdom.toPng(target, { scale, backgroundColor, fast: true, baseCSS })
      /** SnapDOM 返回 HTMLImageElement，从 src 取 dataURL */
      return img.src
    }
    if (format === 'webp') {
      const img = await snapdom.toWebp(target, { scale, backgroundColor, quality, fast: true, baseCSS })
      return img.src
    }
    /** 默认 jpg */
    const img = await snapdom.toJpg(target, { scale, backgroundColor, quality, fast: true, baseCSS })
    return img.src
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
  let resultValue: import('@silkpulse/shared').SerializedValue | undefined
  let error: string | undefined

  try {
    /**
     * 执行用户/server 代码，兼容两种写法：
     *
     * 1. 纯表达式（如 `location`、`document.title`）—— eval 直接返回值
     * 2. 带 return 的代码块（如 server 生成的 `return localStorage...`）—— 需要 new Function
     * 3. 多条语句（如 `const x = 1; x + 1`）—— eval 返回最后表达式值
     *
     * 策略：
     * - 先检查代码是否含 return 语句 → 有则用 new Function（函数体内 return 合法）
     * - 无 return → 用间接 eval（全局作用域，自动返回最后表达式值）
     * - 两种方式都支持 await（eval 返回 Promise 则 await；new Function 包 async 体）
     *
     * new Function 在全局作用域执行（和间接 eval 一致），能访问 window 所有全局变量。
     */
    const hasReturn = /\breturn\b/.test(code)
    /** 执行 promise，与超时竞争——异步永不 resolve 的代码不能无限挂起 */
    const execPromise = (async () => {
      if (hasReturn) {
        /** server 端生成的代码带 return —— new Function 函数体内合法 */
        const fn = new Function(`return (async () => {\n${code}\n})()`)
        return await fn()
      } else {
        /** 纯表达式 / 多条语句 —— 间接 eval 返回最后表达式值 */
        const syncRet = (0, eval)(code)
        return syncRet instanceof Promise ? await syncRet : syncRet
      }
    })()

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('SDK_EXEC_TIMEOUT')), SDK_EXEC_TIMEOUT)
    })

    const ret = await Promise.race([execPromise, timeoutPromise])
    /** 结构化序列化（可交互对象树） */
    resultValue = toSerializedValue(ret)
    /** 兼容旧消费方：JSON 字符串 */
    result = serializeResult(ret)
  } catch (e) {
    success = false
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

  resultSender?.(execId, { success, result, resultValue, error, logs, snapshotText })
}
