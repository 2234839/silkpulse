/**
 * Agent DevTools 辅助函数 —— 把 React/Vue DevTools 的组件树读取和 state 读写
 * 能力暴露给 agent 的 exec code（__silkpulse_devtools_*）
 *
 * 设计原则：
 * - 统一用 snapshot 的元素 idx 做锚定（与 __silkpulse_click 同一语言）：
 *   DOM 元素 → 最近框架组件 → 组件数据
 * - React：ensureReactBackendActive() 激活 backend（无控制台也可用），
 *   rendererInterface 本地直调（inspectElement 读 / overrideValueAtPath 写）
 * - Vue：devtools-core functions 本地直调（getInspectorTree/State、editInspectorState）
 * - 所有函数返回可 JSON 序列化的普通对象，异常转为 { error } 返回（不 throw，
 *   agent 拿到结构化错误信息比异常栈更有用）
 *
 * React id 体系说明：DevTools 内部为每个 fiber 分配递增数字 id，
 * getElementIDForHostInstance(dom) 返回 DOM 节点所属组件的 id。
 * 该 id 在 backend 生命周期内稳定，可跨多次调用复用。
 */

import { ensureReactBackendActive, getActiveReactHook } from './react-devtools-bridge.js'
import { getElement } from './snapshot.js'

/** React DevTools Agent 的最小形状（backend bundle 挂在 hook 上的实例） */
interface ReactAgent {
  overrideValueAtPath(params: {
    id: number
    path: string[]
    rendererID: number
    type: 'hooks' | 'props' | 'state' | 'context'
    value?: unknown
    hookID?: number
  }): void
  overrideHookState(params: { id: number; hookID: number; path: string[]; rendererID: number; value: unknown }): void
  overrideProps(params: { id: number; path: string[]; rendererID: number; value: unknown }): void
  overrideState(params: { id: number; path: string[]; rendererID: number; value: unknown }): void
  renamePath(params: { id: number; path: string[]; rendererID: number; type: string; oldPath: string[]; newPath: string[] }): void
  deletePath(params: { id: number; path: string[]; rendererID: number; type: string; hookID?: number }): void
}

/** rendererInterface 的最小形状（agent 侧读写用） */
interface ReactRendererInterface {
  inspectElement(requestID: number, id: number, path: string[] | null, forceFullData: boolean): unknown
  getElementIDForHostInstance(node: Node): number | null
  getDisplayNameForElementID(id: number): string | null
  hasElementWithId(id: number): boolean
  overrideValueAtPath(type: 'hooks' | 'props' | 'state' | 'context', id: number, hookID: number | null, path: string[], value: unknown): void
  /** react-dom inject 的 renderer 上存在（dev 构建有实现，prod 构建为 null） */
  overrideHookState?: ((fiber: object, hookID: number, path: string[], value: unknown) => void) | null
  overrideProps?: ((fiber: object, path: string[], value: unknown) => void) | null
}

/** React hook 上的 agent/rendererInterfaces 访问（真 hook 上才有） */
interface ReactHookWithAgent {
  reactDevtoolsAgent?: ReactAgent | null
  rendererInterfaces?: Map<number, ReactRendererInterface>
}

/** 错误转结构化对象（exec 里 throw 会中断整个 code，返回 error 字段更友好） */
function err(message: string): { error: string } {
  return { error: message }
}

/** idx → DOM 元素（不存在时报错） */
function resolveElement(idx: number): { el?: Element; error?: string } {
  const el = getElement(idx)
  if (!el) return { error: `元素 idx=${idx} 不存在，先调 __silkpulse_snapshot() 拿最新 idx` }
  return { el }
}

/**
 * 拿 React 单 renderer 环境（页面有一个 React 应用是压倒性场景）
 * 返回 { rendererID, renderer, agent } 或错误
 */
function getReactRenderer(): {
  rendererID?: number
  renderer?: ReactRendererInterface
  agent?: ReactAgent
  error?: string
} {
  const hook = getActiveReactHook() as unknown as ReactHookWithAgent | null
  if (!hook) return { error: 'React DevTools backend 未激活' }
  const interfaces = hook.rendererInterfaces
  if (!interfaces || interfaces.size === 0) return { error: '页面没有 React 应用（或 react-dom 未注册 renderer）' }
  /** 取第一个 renderer（多 renderer 并存极罕见，不为此增加 API 复杂度） */
  const [rendererID, renderer] = [...interfaces.entries()][0]
  return { rendererID, renderer, agent: hook.reactDevtoolsAgent ?? undefined }
}

/** 组件节点（树/定位共用的精简形状） */
export interface DevToolsComponentNode {
  /** 组件显示名（React: displayName；Vue: 组件 name） */
  name: string
  /** snapshot 的元素 idx（有对应 DOM 时才有） */
  idx?: number
  /** DevTools 内部组件 id（React 数字 id / Vue nodeId 字符串） */
  id: string | number
  /** 子组件 */
  children?: DevToolsComponentNode[]
}

/**
 * 安装 __silkpulse_devtools_* 全局辅助函数（exec code 中直接调用）
 */
export function installDevToolsHelpers(): void {
  const w = window as unknown as Record<string, unknown>

  /**
   * 探测目标页可用的 devtools 框架能力
   *
   * 返回 { react, vue }——agent 先调这个判断页面支持哪种。
   * react：hook.renderers 有注册（stub 装早了自然收到，装晚了由
   * recoverReactRoots 合成注册），或 DOM 上有 __reactContainer$（恢复
   * 尚未触发，树读取路径仍可从 fiber 根遍历）。
   * vue：hook.apps 有注册（正常时序 + 后注入 recoverExistingVueApps
   * 补注册），或 DOM 上有 __vue_app__（保底）。
   */
  w.__silkpulse_devtools_available = (): { react: boolean; vue: boolean } => {
    const reactHook = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: { renderers?: Map<unknown, unknown> } }
    const vueHook = window as unknown as { __VUE_DEVTOOLS_GLOBAL_HOOK__?: { apps?: unknown[] } }
    let react = (reactHook.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size ?? 0) > 0
    if (!react) {
      for (const el of document.querySelectorAll('#root, #app, #__next, body > div')) {
        if (Object.getOwnPropertyNames(el).some(k => k.startsWith('__reactContainer$'))) { react = true; break }
      }
    }
    let vue = (vueHook.__VUE_DEVTOOLS_GLOBAL_HOOK__?.apps?.length ?? 0) > 0
    if (!vue) {
      for (const el of document.querySelectorAll('#app, #root, body > div')) {
        if ((el as unknown as { __vue_app__?: unknown }).__vue_app__) { vue = true; break }
      }
    }
    return { react, vue }
  }

  /**
   * 读组件树（React 或 Vue，自动探测）
   *
   * React：从 fiber root 遍历（displayName + key + 对应 DOM idx）
   * Vue：直接遍历组件实例树（rootInstance → subTree）
   *
   * 返回 { framework, tree } 或 { error }
   */
  w.__silkpulse_devtools_tree = async (): Promise<{ framework?: string; tree?: DevToolsComponentNode[]; error?: string }> => {
    const avail = (w.__silkpulse_devtools_available as () => { react: boolean; vue: boolean })()
    if (avail.react) return await buildReactTree()
    if (avail.vue) return buildVueTree()
    return err('页面没有 React/Vue 应用')
  }

  /**
   * 读组件数据（props/state/hooks 全量）
   *
   * @param idx snapshot 元素 idx（组件本身或其内部任何 DOM 均可，自动取最近组件）
   * 返回 { framework, name, id, props, state, hooks? } 或 { error }
   */
  w.__silkpulse_devtools_inspect = async (idx: number): Promise<Record<string, unknown>> => {
    const { el, error } = resolveElement(idx)
    if (error) return err(error)
    const avail = (w.__silkpulse_devtools_available as () => { react: boolean; vue: boolean })()
    if (avail.react) return await inspectReact(el!)
    if (avail.vue) return inspectVue(el!)
    return err('页面没有 React/Vue 应用')
  }

  /**
   * 写组件数据（修改 state/props/hook 值，立即触发框架更新）
   *
   * @param idx    snapshot 元素 idx
   * @param type   写入目标：'state' | 'props' | 'hooks'
   * @param path   属性路径数组（相对目标容器的内部路径）：
   *               - state/props：如 ['count']、['user','name']；写整个对象用 []
   *               - hooks：hook 值**内部**的路径（useState 的值是数字/对象时，[] = 整个值，
   *                 对象 hook 用 ['name']；不包含 hook 序号本身）
   * @param value  新值（JSON 值）
   * @param hookID hooks 场景必传：hook 序号（inspect 结果 hooks 数组的下标）
   * 返回 { success, name, applied: {type, path} } 或 { error }
   *
   * React 写 state 走 overrideValueAtPath → scheduleUpdate（等效 setState）；
   * Vue 写 setup state 直接改实例的响应式对象（等效 devtools 的 editInspectorState）。
   */
  w.__silkpulse_devtools_set = async (
    idx: number,
    type: 'state' | 'props' | 'hooks',
    path: string[],
    value: unknown,
    hookID?: number,
  ): Promise<Record<string, unknown>> => {
    const { el, error } = resolveElement(idx)
    if (error) return err(error)
    const avail = (w.__silkpulse_devtools_available as () => { react: boolean; vue: boolean })()
    if (avail.react) return setReact(el!, type, path, value, hookID)
    if (avail.vue) return setVue(el!, type, path, value)
    return err('页面没有 React/Vue 应用')
  }

  /* ==================== React 实现 ==================== */

  /** DOM → 最近 React 组件 fiber（沿 __reactFiber$ 前缀属性向上找） */
  function getReactFiberFromDOM(el: Element): { fiber?: object; error?: string } {
    const key = Object.getOwnPropertyNames(el).find((k) => k.startsWith('__reactFiber$'))
    let node: object | null = key ? (el as unknown as Record<string, object>)[key] : null
    if (!node) {
      /** 元素本身不是 React 渲染的（如 body 直下），向上找 */
      let parent: Element | null = el.parentElement
      while (parent && !node) {
        const pkey = Object.getOwnPropertyNames(parent).find((k) => k.startsWith('__reactFiber$'))
        node = pkey ? (parent as unknown as Record<string, object>)[pkey] : null
        parent = parent.parentElement
      }
    }
    if (!node) return { error: '该元素不属于 React 渲染树' }
    return { fiber: node }
  }

  /** fiber → 显示名（函数/类组件取 displayName，宿主组件取 tagName） */
  function fiberDisplayName(fiber: Record<string, unknown>): string {
    const type = fiber.elementType ?? fiber.type
    if (typeof type === 'string') return type
    if (typeof type === 'function' || (type && typeof type === 'object')) {
      const t = type as { displayName?: string; name?: string }
      return t.displayName ?? t.name ?? 'Anonymous'
    }
    return 'Unknown'
  }

  /** fiber 链向上找最近的类/函数组件 fiber（跳过宿主组件） */
  function nearestComponentFiber(fiber: Record<string, unknown>): Record<string, unknown> | null {
    let cur: Record<string, unknown> | null = fiber
    while (cur) {
      const tag = cur.tag
      /** 0=FunctionComponent 1=ClassComponent 11=ForwardRef 10=MemoComponent 15=SimpleMemoComponent */
      if (tag === 0 || tag === 1 || tag === 11 || tag === 10 || tag === 15) return cur
      cur = (cur.return as Record<string, unknown>) ?? null
    }
    return null
  }

  /** React 树：从 fiber root 遍历（深度限制防爆栈，只列组件层不列 DOM 层） */
  async function buildReactTree(): Promise<{ framework: string; tree: DevToolsComponentNode[] }> {
    await ensureReactBackendActive()
    const hook = getActiveReactHook()
    if (!hook) return err('React backend 激活失败') as unknown as { framework: string; tree: DevToolsComponentNode[] }
    /** fiber root 来源：stubFiberRoots 已在激活时合并进真 hook 的 getFiberRoots(rendererID)；
     *  后注入场景由 recoverReactRoots 合成的 renderer + fiberRoots 覆盖 */
    const roots: object[] = []
    const { rendererID } = getReactRenderer()
    if (rendererID != null) {
      for (const root of hook.getFiberRoots(rendererID)) roots.push(root as object)
    }
    /** 兜底：DOM 容器上的 __reactContainer$（renderer 注册全失败时树仍可读，仅无 inspect id） */
    if (roots.length === 0) roots.push(...domBasedReactRoots())

    /** 0=FunctionComponent 1=ClassComponent 11=ForwardRef 10=MemoComponent 15=SimpleMemoComponent */
    const isComponentTag = (tag: unknown): boolean => tag === 0 || tag === 1 || tag === 11 || tag === 10 || tag === 15

    /** 组件 fiber → 树节点（函数组件 stateNode 为空，用 firstHostElement 锚定 DOM） */
    const makeNode = (fiber: Record<string, unknown>): DevToolsComponentNode => {
      const node: DevToolsComponentNode = { name: fiberDisplayName(fiber), id: 0 }
      const key = fiber.key as string | null
      if (key != null) node.name += ` key="${key}"`
      const stateNode = fiber.stateNode
      const hostEl = stateNode instanceof Element ? stateNode : firstHostElement(fiber)
      if (hostEl) {
        node.idx = ensureIdxSafe(hostEl)
        /** DevTools 数字 id（供 inspect/set 复用；无 DOM 的组件留 0） */
        const ri = getReactRenderer()
        if (ri.renderer && ri.rendererID != null) {
          const devId = ri.renderer.getElementIDForHostInstance(hostEl)
          if (devId != null) node.id = devId
        }
      }
      return node
    }

    /** 在 fiber 子树里收集「直接子组件」：沿 sibling 链完整扫一层层下沉，
     *  中途遇到组件即停（它内部的后代归它自己的 children）。
     *  fiber 树的兄弟只链在每层首节点上（first.child → sibling*），
     *  只沿 .child 下沉会丢掉所有后续兄弟——这是树只剩单节点的根因 */
    const collectChildren = (fiber: Record<string, unknown>, depth: number): DevToolsComponentNode[] => {
      const found: DevToolsComponentNode[] = []
      const walk = (first: Record<string, unknown> | null, d: number): void => {
        if (!first || d > 40) return
        for (let cur: Record<string, unknown> | null = first; cur; cur = cur.sibling as Record<string, unknown> | null) {
          if (isComponentTag(cur.tag)) {
            const node = makeNode(cur)
            const kids = collectChildren(cur, d + 1)
            if (kids.length > 0) node.children = kids
            found.push(node)
          } else {
            walk(cur.child as Record<string, unknown> | null, d + 1)
          }
        }
      }
      walk(fiber.child as Record<string, unknown> | null, depth)
      return found
    }

    /** HostRoot fiber（tag=3）当容器处理：收集它的直接子组件作为顶层 */
    const tree: DevToolsComponentNode[] = []
    for (const root of roots) {
      const rootFiber = (root as { current?: Record<string, unknown> }).current ?? (root as Record<string, unknown>)
      if (rootFiber) tree.push(...collectChildren(rootFiber, 0))
    }
    return { framework: 'react', tree }
  }

  /** DOM 兑底找 React root（fiber root map 为空时）。
   *  容器上挂的是 HostRoot fiber（tag=3）：stateNode 恒指向真实 FiberRoot
   *  （不能用 stateNode.current === fiber 校验，double buffering 下恒 false），
   *  缺失时才合成 { current: fiber } 包装 */
  function domBasedReactRoots(): object[] {
    const roots: object[] = []
    for (const el of document.querySelectorAll('#root, #app, [data-reactroot], body > div')) {
      const key = Object.getOwnPropertyNames(el).find((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'))
      if (key) {
        const container = (el as unknown as Record<string, object>)[key]
        if (!container) continue
        const fiber = container as { stateNode?: { current?: unknown } }
        const fiberRoot = fiber.stateNode && typeof fiber.stateNode === 'object' && 'current' in fiber.stateNode
          ? fiber.stateNode
          : { current: container }
        roots.push(fiberRoot as object)
      }
    }
    return roots
  }

  /** element → snapshot idx（不存在则注册） */
  function ensureIdxSafe(el: Element): number {
    const w2 = window as unknown as { __silkpulse_ensureIdx?: (el: Element) => number }
    if (typeof w2.__silkpulse_ensureIdx === 'function') return w2.__silkpulse_ensureIdx(el)
    return -1
  }

  /** React 检查：DOM → 组件 id → rendererInterface.inspectElement（全量数据） */
  async function inspectReact(el: Element): Promise<Record<string, unknown>> {
    await ensureReactBackendActive()
    const { rendererID, renderer, error } = getReactRenderer()
    if (error) return err(error)
    const { fiber, error: ferr } = getReactFiberFromDOM(el)
    if (ferr) return err(ferr)
    const compFiber = nearestComponentFiber(fiber as Record<string, unknown>)
    if (!compFiber) return err('未找到最近的 React 组件')

    /** DOM → id：优先 rendererInterface 的映射（含 filtered fiber 处理） */
    const hostEl = compFiber.stateNode instanceof Element ? compFiber.stateNode : firstHostElement(compFiber)
    if (!hostEl) return err('组件没有已挂载的 DOM 元素，无法定位 DevTools id')
    const id = renderer!.getElementIDForHostInstance(hostEl)
    if (id == null) return err('DevTools id 映射未建立（组件可能刚挂载），稍后重试')

    /** 本地直调 inspectElement：requestID 仅用于 bridge 回包关联，本地调用直接返回数据。
     *  返回是信封：{ type:'full-data', value: {...实际数据} }（fiber 版）或
     *  { type:'no-change'|'not-found'|'error', ... }——forceFullData=true 恒走 full-data */
    const inspected = renderer!.inspectElement(0, id, null, true) as Record<string, unknown>
    if (!inspected) return err('inspectElement 返回空')
    const data = (inspected.type === 'full-data' && inspected.value != null)
      ? inspected.value as Record<string, unknown>
      : inspected
    if (data.type === 'not-found') return err(`组件 id=${id} 不在 DevTools 注册表中`)
    if (data.type === 'error') return err(`检查组件失败: ${String(data.message ?? '未知错误')}`)
    const out: Record<string, unknown> = {
      framework: 'react',
      id,
      rendererID,
      name: renderer!.getDisplayNameForElementID(id) ?? fiberDisplayName(compFiber),
      idx: ensureIdxSafe(hostEl),
    }
    /** 透传核心数据字段（backend 返回的已是可序列化形状） */
    for (const k of ['props', 'state', 'hooks', 'context', 'owners', 'source', 'rendered_by', 'canEditHooks', 'canEditFunctionProps', 'canEditState', 'key']) {
      if (data[k] !== undefined) out[k] = data[k]
    }
    return out
  }

  /** fiber 子树第一个宿主 DOM 元素 */
  function firstHostElement(fiber: Record<string, unknown>): Element | null {
    if (fiber.stateNode instanceof Element) return fiber.stateNode
    for (let c = fiber.child as Record<string, unknown> | null; c; c = c.sibling as Record<string, unknown> | null) {
      const found = firstHostElement(c)
      if (found) return found
    }
    return null
  }

  /** React 写：DOM → id → agent.overrideValueAtPath（React 18 走 scheduleUpdate 自动重渲染） */
  async function setReact(
    el: Element,
    type: 'state' | 'props' | 'hooks',
    path: string[],
    value: unknown,
    hookID?: number,
  ): Promise<Record<string, unknown>> {
    await ensureReactBackendActive()
    const { rendererID, renderer, error } = getReactRenderer()
    if (error) return err(error)
    const { fiber, error: ferr } = getReactFiberFromDOM(el)
    if (ferr) return err(ferr)
    const compFiber = nearestComponentFiber(fiber as Record<string, unknown>)
    if (!compFiber) return err('未找到最近的 React 组件')
    const hostEl = compFiber.stateNode instanceof Element ? compFiber.stateNode : firstHostElement(compFiber)
    if (!hostEl) return err('组件没有已挂载的 DOM 元素')
    const id = renderer!.getElementIDForHostInstance(hostEl)
    if (id == null) return err('DevTools id 映射未建立')

    const { agent } = getReactRenderer()
    if (!agent) return err('DevTools agent 不可用')

    if (type === 'hooks') {
      if (!Number.isInteger(hookID)) return err('hooks 写入需要 hookID 参数（inspect 结果 hooks 数组的下标）')
      if (typeof renderer!.overrideHookState !== 'function') {
        return err('目标页 React 是生产构建（bundleType=0），react-dom 未提供 overrideHookState（仅 dev 构建可用），无法写 hooks')
      }
      agent.overrideHookState({ id, hookID: hookID!, path, rendererID: rendererID!, value })
    } else {
      if (type === 'props') {
        if (typeof renderer!.overrideProps !== 'function') return err('目标页 React 是生产构建，无法写 props')
        agent.overrideProps({ id, path, rendererID: rendererID!, value })
      } else {
        agent.overrideState({ id, path, rendererID: rendererID!, value })
      }
    }
    return { success: true, framework: 'react', type, path, name: fiberDisplayName(compFiber) }
  }

  /* ==================== Vue 实现 ==================== */

  /** Vue 组件实例的最小形状（只用公开稳定字段） */
  interface VueInstance {
    uid?: number
    type?: { name?: string; __name?: string }
    setupState?: Record<string, unknown>
    data?: Record<string, unknown>
    props?: Record<string, unknown>
    subTree?: Record<string, unknown> | null
    component?: VueInstance | null
    children?: unknown
    $forceUpdate?: () => void
  }

  /** 组件实例 → 树节点（递归收集子组件；跨过中间 DOM vnode 层） */
  function vueInstanceNode(instance: VueInstance, depth: number): DevToolsComponentNode {
    const node: DevToolsComponentNode = {
      name: instance.type?.name ?? instance.type?.__name ?? 'Anonymous',
      id: String(instance.uid ?? ''),
    }
    const hostEl = vueFirstHostEl(instance)
    if (hostEl) node.idx = ensureIdxSafe(hostEl)
    const children: DevToolsComponentNode[] = []
    /** 在 vnode 子树里收集直接子组件（组件即停，它内部归自己的 children） */
    const collect = (vnode: Record<string, unknown> | null | undefined, d: number): void => {
      if (!vnode || d > 40) return
      if (vnode.component) {
        children.push(vueInstanceNode(vnode.component as VueInstance, d + 1))
        return
      }
      const kids = vnode.children
      if (Array.isArray(kids)) {
        for (const k of kids) collect(k as Record<string, unknown>, d)
      }
      /** slot children（函数）拿不到展开内容，跳过——子组件会在自己 subTree 里出现 */
    }
    collect(instance.subTree, depth)
    if (children.length > 0) node.children = children
    return node
  }

  /** 组件 vnode 子树里第一个真实 DOM（组件根元素，用于 idx 锚定） */
  function vueFirstHostEl(instance: VueInstance): Element | null {
    const walk = (n: Record<string, unknown> | null | undefined, d: number): Element | null => {
      if (!n || d > 40) return null
      if (n.component) return walk((n.component as VueInstance).subTree, d + 1)
      const el = n.el
      if (el instanceof Element) return el
      const kids = n.children
      if (Array.isArray(kids)) {
        for (const k of kids) {
          const f = walk(k as Record<string, unknown>, d)
          if (f) return f
        }
      }
      return null
    }
    return walk(instance.subTree, 0)
  }

  /** Vue app → 根组件实例（devtools-kit 在 hook.apps 的 app 上挂的记录） */
  function vueRootInstances(): VueInstance[] {
    const hook = (window as unknown as {
      __VUE_DEVTOOLS_GLOBAL_HOOK__?: { apps?: Array<Record<string, unknown>> }
    }).__VUE_DEVTOOLS_GLOBAL_HOOK__
    const roots: VueInstance[] = []
    for (const app of hook?.apps ?? []) {
      const rec = (app as { __VUE_DEVTOOLS_NEXT_APP_RECORD__?: { rootInstance?: VueInstance } }).__VUE_DEVTOOLS_NEXT_APP_RECORD__
      if (rec?.rootInstance) roots.push(rec.rootInstance)
    }
    return roots
  }

  /** Vue 树：直接遍历组件实例树（不依赖 devtools RPC/控制台连接） */
  function buildVueTree(): { framework: string; tree: DevToolsComponentNode[] } {
    return { framework: 'vue', tree: vueRootInstances().map((r) => vueInstanceNode(r, 0)) }
  }

  /** DOM → 最近 Vue 组件实例。
   *  主路径：el.__vueParentComponent 向上——但这是 dev 构建专属标记，
   *  生产构建不挂。兜底：从各 app 的 rootInstance 沿 subTree 的 el 链
   *  下钻（DOM 包含关系 = 组件渲染范围），找到包含目标 el 的最深组件。 */
  function getVueComponentFromDOM(el: Element): { instance?: VueInstance; error?: string } {
    const rec = el as unknown as { __vueParentComponent?: VueInstance }
    if (rec.__vueParentComponent) return { instance: rec.__vueParentComponent }
    let parent: Element | null = el.parentElement
    while (parent) {
      const p = (parent as unknown as { __vueParentComponent?: VueInstance }).__vueParentComponent
      if (p) return { instance: p }
      parent = parent.parentElement
    }
    /** 生产构建兜底：subTree 下钻匹配（el 相等或 DOM 包含） */
    let deepest: { ins: VueInstance; d: number } | null = null
    const visit = (ins: VueInstance, d: number): void => {
      const host = vueFirstHostEl(ins)
      /** host 要么是 el 本人，要么是 el 的祖先（组件渲染范围覆盖 el） */
      if (host === el || (host && el.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_CONTAINS)) {
        if (!deepest || d > deepest.d) deepest = { ins, d }
      }
      /** 继续下钻子组件（与 vueInstanceNode 的 collect 同规则：组件即 recurse 自己的 subTree） */
      const collect = (vnode: Record<string, unknown> | null | undefined, cd: number): void => {
        if (!vnode || cd > 40) return
        if (vnode.component) { visit(vnode.component as VueInstance, d + 1); return }
        const kids = vnode.children
        if (Array.isArray(kids)) for (const k of kids) collect(k as Record<string, unknown>, cd)
      }
      collect(ins.subTree, 0)
    }
    for (const root of vueRootInstances()) visit(root, 0)
    if (deepest) return { instance: (deepest as { ins: VueInstance; d: number }).ins }
    return { error: '该元素不属于 Vue 渲染树' }
  }

  /** 组件实例的可编辑状态：setupState 优先（script setup 场景），兼容 data（options API） */
  function vueEditableState(instance: VueInstance): Record<string, unknown> | undefined {
    return (instance.setupState && Object.keys(instance.setupState).length > 0) ? instance.setupState : instance.data
  }

  /** Vue 检查：直接读组件实例的 setupState/data/props（原始响应式对象，无 RPC） */
  function inspectVue(el: Element): Record<string, unknown> {
    const { instance, error } = getVueComponentFromDOM(el)
    if (error) return err(error)
    const ins = instance!
    /** 浅拍一层：ref 自动解包（devtools 显示的也是解包后的值） */
    const simplify = (obj: Record<string, unknown> | undefined): Record<string, unknown> | null => {
      if (!obj) return null
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(obj)) {
        const v = obj[k]
        /** ref 形状：{ value } 且无其他字段 */
        if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>) && Object.keys(v as Record<string, unknown>).length === 1) {
          out[k] = (v as { value: unknown }).value
        } else {
          out[k] = v
        }
      }
      return out
    }
    return {
      framework: 'vue',
      id: String(ins.uid ?? ''),
      name: ins.type?.name ?? ins.type?.__name ?? 'Anonymous',
      idx: ensureIdxSafe(el),
      state: simplify(ins.setupState),
      data: simplify(ins.data),
      props: simplify(ins.props),
    }
  }

  /** Vue 写：直接改组件实例的 setupState/data/props（响应式对象，赋值即触发更新）。
   *  经 devtools 官方 editInspectorState 验证过的链路本质也是改这几个对象。 */
  function setVue(el: Element, type: 'state' | 'props' | 'hooks', path: string[], value: unknown): Record<string, unknown> {
    if (type === 'hooks') return err('Vue 没有 hooks，用 state（setup 返回的 ref/reactive 都在 state 里）')
    const { instance, error } = getVueComponentFromDOM(el)
    if (error) return err(error)
    const ins = instance!
    const container: Record<string, unknown> | undefined = type === 'props' ? ins.props : vueEditableState(ins)
    if (!container) return err(`组件没有可写的 ${type}（setupState/data 均为空）`)

    /** 沿 path 下沉到倒数第一层的容器，最后一段做赋值 */
    let cur: Record<string, unknown> = container
    for (const seg of path.slice(0, -1)) {
      const next = cur[seg]
      if (!next || typeof next !== 'object') return err(`路径 ${JSON.stringify(path)} 在 ${String(seg)} 处中断（值非对象）`)
      cur = next as Record<string, unknown>
    }
    const last = path.length > 0 ? path[path.length - 1] : ''
    if (path.length > 0 && !(last in cur)) {
      return err(`属性 ${last} 不存在（响应式对象不能凭空新增根级属性，请核对 inspect 输出的字段名）`)
    }
    /** 目标值是 ref 包装（{ value } 且仅此一键）时写 .value，否则直接赋值 */
    const target = path.length > 0 ? cur[last] : null
    if (path.length > 0 && target && typeof target === 'object' && 'value' in (target as Record<string, unknown>) && Object.keys(target as Record<string, unknown>).length === 1) {
      ;(target as { value: unknown }).value = value
    } else if (path.length > 0) {
      cur[last] = value
    }
    /** reactive 代理赋值已触发更新；保险起见强制刷新一次 */
    ins.$forceUpdate?.()
    return { success: true, framework: 'vue', type, path, name: ins.type?.name ?? ins.type?.__name ?? 'Anonymous' }
  }
}


