/**
 * React DevTools backend 桥接 —— 在目标页安装 react-devtools hook + 按需激活 Agent
 *
 * 架构：
 *   目标页（本文件）                SilkPulse server           控制台 iframe
 *   ┌────────────────────┐         ┌────────────┐         ┌──────────────────┐
 *   │ hook stub（同步）   │         │            │         │ frontend.bundle  │
 *   │ + backend bundle   │ devtools-relay        │ devtools-relay │ initialize() │
 *   │   （按需 fetch）    │◄───────►│  透传      │◄───────►│ <DevTools />     │
 *   │ Agent + Wall       │   (WS)  │            │   (WS)  │ custom Wall      │
 *   └────────────────────┘         └────────────┘         └──────────────────┘
 *
 * React 时序约束（与 Vue 不同，React 没有 replay 机制）：
 *   react-dom 模块执行时同步调 hook.inject(internals) 并缓存 hook 引用，
 *   所以 __REACT_DEVTOOLS_GLOBAL_HOOK__ 必须在 react-dom 加载前同步存在。
 *   而 backend bundle（700KB）异步 fetch 太慢，所以：
 *
 *   1. SDK 顶层同步装「委托式 hook stub」—— 收集 renderer（inject 调用）
 *      + fiberRoots（onCommitFiberRoot 调用）+ 事件订阅
 *   2. 控制台打开 React DevTools → WS 请求 activate
 *   3. SDK fetch backend.bundle.js → 在 shadow target 上 installHook 装真 hook
 *   4. replay 收集的 renderer 到真 hook（attachRenderer 重建 rendererInterface）
 *   5. 激活 Agent（createBridge(wall) + activate）→ initBackend 读 hook 上已
 *      注册的 rendererInterfaces → flushInitialOperations → 全量树推给前端
 *   6. stub 的所有方法从激活起委托给真 hook（react-dom 持有的引用不变，
 *      因为 stub 对象本身一直是 window.__REACT_DEVTOOLS_GLOBAL_HOOK__）
 *
 * 消息协议（Wall）：
 *   { event: string, payload: unknown, fromBackend?: boolean }
 *   fromBackend 标记方向，避免 SDK 把自己发出的消息又转发回 backend
 */

import { send } from "./ws-client.js";
import { registerServerMessageHandler } from "./message-router.js";

/** backend bundle 加载后的全局名（IIFE global-name） */
const BACKEND_GLOBAL = "ReactDevToolsBackend";

/** backend bundle URL（server 静态服务，SDK 与目标页同源时直接用相对路径） */
const BACKEND_URL = "/plugins/react-devtools/assets/backend.bundle.js";

/** backend bundle 模块形状（react-devtools-inline/backend 的导出） */
interface BackendModule {
  initialize: (target: Window) => unknown;
  activate: (target: Window, opts?: { bridge?: unknown }) => void;
  createBridge: (target: Window, wall?: unknown) => unknown;
}

/** hook 上的事件订阅回调 */
type HookListener = (data: unknown) => void;

/** react-dom 通过 inject 传入的 renderer internals */
interface RendererInternals {
  version?: string;
  bundleType?: number;
  [key: string]: unknown;
}

/** rendererInterfaces 里 interface 的形状（backend attachRenderer 的返回物，
 *  reactivate 时要调 flushInitialOperations） */
interface RendererInterface {
  flushInitialOperations: () => void;
  [key: string]: unknown;
}

/** 真 hook 的形状（installHook 装上的完整对象） */
interface RealHook {
  rendererInterfaces: Map<number, RendererInterface>;
  renderers: Map<number, RendererInternals>;
  hasUnsupportedRendererAttached: boolean;
  emit: (event: string, data?: unknown) => void;
  on: (event: string, fn: HookListener) => void;
  off: (event: string, fn: HookListener) => void;
  sub: (event: string, fn: HookListener) => () => void;
  inject: (renderer: RendererInternals) => number;
  getFiberRoots: (rendererID: number) => Set<unknown>;
  onCommitFiberRoot: (rendererID: number, root: unknown, priorityLevel?: unknown) => void;
  onCommitFiberUnmount: (rendererID: number, fiber: unknown) => void;
  onPostCommitFiberRoot?: (rendererID: number, root: unknown) => void;
  setStrictMode?: (isStrictMode: boolean) => void;
  checkDCE: (fn: unknown) => void;
  supportsFiber: boolean;
  supportsFlight: boolean;
  settings?: unknown;
  reactDevtoolsAgent?: unknown;
  [key: string]: unknown;
}

/** 真 hook（backend bundle 加载后赋值，之前为 null） */
let realHook: RealHook | null = null;

/** stub 阶段收集的 renderer（inject 被调用时存起来，激活时 replay） */
const pendingRenderers: Array<{ id: number; renderer: RendererInternals }> = [];

/** stub 阶段的 uid 计数器（与官方 installHook 一致，从 0 自增） */
let stubUid = 0;

/** stub 阶段收集的 fiberRoots（rendererID → Set<root>） */
const stubFiberRoots: Record<number, Set<unknown>> = {};

/** stub 阶段的事件监听器（激活后合并进真 hook） */
const stubListeners: Record<string, HookListener[]> = {};

/**
 * 委托式 hook stub —— 同步装到 window，react-dom 加载时调 inject 注册
 *
 * 职责：
 * - inject(renderer)：暂存 renderer（真 hook 就绪前 react-dom 就会调）
 * - onCommitFiberRoot：暂存 root（commit 时 react-dom 持续调用，终身有效）
 * - on/off/emit/sub：事件订阅暂存，激活后转发给真 hook
 * - 其余属性（checkDCE 等）在激活后委托真 hook，激活前为安全 no-op
 *
 * 关键：这个对象终身是 window.__REACT_DEVTOOLS_GLOBAL_HOOK__（不可替换，
 * 因为 react-dom 已缓存引用），所有方法在激活后内部转发到 realHook。
 */
function installDelegatingHookStub(): void {
  const target = window as unknown as Record<string, unknown>;

  /** 已有 hook（别的 devtools 扩展或重复注入）就不动 */
  if (target.__REACT_DEVTOOLS_GLOBAL_HOOK__ != null) return;

  const stub = {
    _isSilkPulseStub: true,
    rendererInterfaces: new Map<number, unknown>(),
    renderers: new Map<number, RendererInternals>(),
    backends: new Map<number, unknown>(),
    listeners: stubListeners,
    hasUnsupportedRendererAttached: false,
    supportsFiber: true,
    supportsFlight: true,
    checkDCE: (_fn: unknown) => {},
    settings: {
      appendComponentStack: true,
      breakOnConsoleErrors: false,
      showInlineWarningsAndErrors: true,
      hideConsoleLogsInStrictMode: false,
    },

    emit(event: string, data?: unknown) {
      /** 激活后直接走真 hook 的 emit；激活前广播给 stub 订阅者 */
      if (realHook) {
        realHook.emit(event, data);
        return;
      }
      for (const fn of stubListeners[event] ?? []) fn(data);
    },

    on(event: string, fn: HookListener) {
      if (realHook) {
        realHook.on(event, fn);
        return;
      }
      (stubListeners[event] ??= []).push(fn);
    },

    off(event: string, fn: HookListener) {
      if (realHook) {
        realHook.off(event, fn);
        return;
      }
      const arr = stubListeners[event];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },

    sub(event: string, fn: HookListener) {
      stub.on(event, fn);
      return () => stub.off(event, fn);
    },

    inject(renderer: RendererInternals): number {
      if (realHook) return realHook.inject(renderer) as number;
      /** stub 阶段：暂存，等真 hook 就绪后 replay */
      const id = ++stubUid;
      pendingRenderers.push({ id, renderer });
      stub.renderers.set(id, renderer);
      return id;
    },

    getFiberRoots(rendererID: number): Set<unknown> {
      if (realHook) return realHook.getFiberRoots(rendererID);
      return (stubFiberRoots[rendererID] ??= new Set());
    },

    onCommitFiberRoot(rendererID: number, root: unknown, priorityLevel?: unknown) {
      if (realHook) {
        realHook.onCommitFiberRoot(rendererID, root, priorityLevel);
        return;
      }
      /** stub 阶段把 root 记下来（react-dom 每次 commit 都会调，天然增量收集） */
      stub.getFiberRoots(rendererID).add(root);
    },

    onCommitFiberUnmount(rendererID: number, fiber: unknown) {
      if (realHook) realHook.onCommitFiberUnmount(rendererID, fiber);
      /** stub 阶段无法处理 unmount 增量（没有 rendererInterface），激活后全量重建 */
    },

    onPostCommitFiberRoot(rendererID: number, root: unknown) {
      if (realHook) realHook.onPostCommitFiberRoot?.(rendererID, root);
    },

    setStrictMode(isStrictMode: boolean) {
      if (realHook) realHook.setStrictMode?.(isStrictMode);
    },
  };

  Object.defineProperty(target, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    configurable: false,
    enumerable: false,
    get() {
      return stub;
    },
  });
}

/** backend bundle 加载 Promise（防重复 fetch） */
let backendLoadPromise: Promise<BackendModule> | null = null;

/**
 * 后注入恢复：DOM 扫描已存在的 React root，合成 renderer 注册进 stub
 *
 * 场景：SDK 在 react-dom 之后才注入。react-dom 模块求值时同步调
 * hook.inject(internals) 并缓存 hook 引用——我们 stub 装晚了收不到
 * inject，pendingRenderers 为空，激活后 backend 无 renderer 可 attach。
 *
 * 恢复路径：React 18+ 在每个 root 容器上挂 `__reactContainer$<random>`，
 * **挂的是 HostRoot fiber 本身**（不是 FiberRoot！fiber.stateNode 才指向
 * FiberRoot，官方 backend 的 getFiberRoots 存的是 FiberRoot——
 * `{ current: HostRootFiber }`）。扫出来后合成 renderer 对象（backend 的
 * attachRenderer 只要求 version/bundleType + findFiberByHostInstance
 * 或 currentDispatcherRef 走 fiber 分支），激活时与真实 inject 一样
 * replay 进真 hook。fiberRoots 也一并注入，flushInitialOperations
 * 会从 getFiberRoots 建全量树；后续 commit 走 stub.onCommitFiberRoot
 * （react-dom 持有的是 stub 引用）持续增量。
 *
 * findFiberByHostInstance 用 hostInstance 上的 __reactFiber$ 回溯实现
 * （官方 renderer 是从 fiber 树反查，我们正查等价）。version 优先取
 * React 全局版本（__SECRET_INTERNALS 或 18 的 React.__VERSION 不在
 * 页面全局时兜底 '18.0.0'——fiber 常量表按版本分支，18+ 的 tag 体系
 * 18/19 一致，19 专属 tag（Activity 31 等）在旧常量表里是 -1 会被
 * 当未知类型跳过显示，树仍可用）。
 */
function recoverReactRoots(): void {
  const target = window as unknown as Record<string, unknown>;
  /** stub 已有 renderer（react-dom 在 stub 之后加载，inject 走到了）则无需恢复 */
  if (stubRenderersRecovered) return;
  if (pendingRenderers.length > 0) return;

  const roots = new Set<unknown>();
  for (const el of document.querySelectorAll("*")) {
    for (const key of Object.getOwnPropertyNames(el)) {
      if (!key.startsWith("__reactContainer$")) continue;
      const container = (el as unknown as Record<string, unknown>)[key];
      if (!container) continue;
      /** 容器上挂的是 HostRoot fiber（tag=3）：其 stateNode 恒指向真实 FiberRoot
       *  （alternate fiber 克隆时 stateNode 一并复制，不受 double buffering 影响）。
       *  注意不能用 `stateNode.current === fiber` 做身份校验——commit 后 root.current
       *  切到 alternate，容器标记仍是初始 fiber，恒 false。backend 的 recordMount
       *  按 fiber.stateNode 做 map key，必须注册真实 FiberRoot 而非合成包装 */
      const fiber = container as { stateNode?: { current?: unknown } };
      const fiberRoot =
        fiber.stateNode && typeof fiber.stateNode === "object" && "current" in fiber.stateNode
          ? fiber.stateNode
          : { current: container };
      if ((fiberRoot as { current?: unknown }).current) roots.add(fiberRoot);
    }
  }
  if (roots.size === 0) return;

  /** 探测 React 版本（页面全局可能有 React 挂载信息） */
  const reactGlobal = (target.React ?? target.__REACT__) as
    | (Record<string, unknown> & { version?: string })
    | undefined;
  const version = reactGlobal?.version ?? "18.0.0";

  /** hooks 重放需要页面 react 的 ReactCurrentDispatcher：inspect 时 backend 会把
   *  它的 H 换成 DispatcherProxy 后重放组件函数。UMD 页面拿得到（挂 window）；
   *  vite ESM 页面拿不到（undefined）——此时 backend 退回内置副本重放会 #321，
   *  但 bundleType: 0 下 inspectHooks 不走重放，此字段无效但保留（未来若
   *  能拿到可安全升级 bundleType）。React 18 UMD:
   *  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED；React 19:
   *  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE */
  const internals =
    reactGlobal?.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ??
    reactGlobal?.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const dispatcherRef = (internals as { ReactCurrentDispatcher?: object } | undefined)
    ?.ReactCurrentDispatcher;

  const syntheticRenderer: RendererInternals = {
    version,
    reconcilerVersion: version,
    /** 0 = production build。fiber 上没有 _debugSource，backend 跳过源码定位；
     *  更关键的是 hooks 检查/重放（inspectHooks）按 bundleType 分支——
     *  声称 dev 会触发组件函数重放，而 vite ESM 页面拿不到页面 react 的
     *  currentDispatcherRef（renderer.currentDispatcherRef 为 undefined），
     *  backend 退回内置副本重放 → 页面 useState 报 #321 Invalid hook call，
     *  InspectedElementContextController 崩溃、右侧面板白屏。
     *  bundleType: 0 = 不重放，直接读 fiber.memoizedState 链展示 hooks 值 */
    bundleType: 0,
    rendererPackageName: "react-dom",
    /** 真实 inject 时 react-dom 会传这个字段；hooks 检查/改写全靠它 */
    currentDispatcherRef: dispatcherRef,
    findFiberByHostInstance(instance: unknown) {
      /** hostInstance 上的 __reactFiber$ 属性即所属 fiber（React 17+ 恒有） */
      if (!instance || typeof instance !== "object") return null;
      for (const key of Object.getOwnPropertyNames(instance)) {
        if (key.startsWith("__reactFiber$")) {
          return (instance as Record<string, unknown>)[key] ?? null;
        }
      }
      return null;
    },
  };

  /** 注入 stub（与 react-dom 主动 inject 同路径），fiberRoots 一并登记 */
  const rendererID = stubInjectForRecovery(syntheticRenderer);
  if (rendererID == null) return;
  const fiberRoots = (stubFiberRoots[rendererID] ??= new Set());
  for (const root of roots) fiberRoots.add(root);
  stubRenderersRecovered = true;
}

/** 恢复是否已执行过（一个页面生命周期只做一次 DOM 全扫） */
let stubRenderersRecovered = false;

/**
 * 恢复路径专用 inject：绕过 realHook 判断（恢复可能发生在激活之后）
 *
 * 返回分配的 rendererID，hook 不可用时返回 null。
 */
function stubInjectForRecovery(renderer: RendererInternals): number | null {
  /** 激活后直接走真 hook（backend 立即 attachRenderer + 从 fiberRoots 建树） */
  if (realHook) return realHook.inject(renderer);
  const stub = (
    window as unknown as {
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: { inject?: (r: RendererInternals) => number };
    }
  ).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!stub?.inject) return null;
  const id = stub.inject(renderer);
  pendingRenderers.push({ id, renderer });
  return id;
}

/**
 * 推导 server origin（backend bundle 的下载地址）
 *
 * 优先级：
 * 1. window.__SILKPULSE_SERVER__（init 时写入，最可靠）
 * 2. 当前 SDK script 标签的 src origin（data-server 未指定时）
 * 3. 空字符串（同源部署，直接用相对路径 /plugins/...）
 */
function resolveServerOrigin(): string {
  const target = window as unknown as Record<string, unknown>;
  const fromInit = target.__SILKPULSE_SERVER__;
  if (typeof fromInit === "string" && fromInit) return fromInit;
  try {
    const script = document.currentScript as HTMLScriptElement | null;
    if (script?.src) return new URL(script.src).origin;
  } catch {
    /** script.src 解析失败忽略 */
  }
  return "";
}

/**
 * 动态加载 react-devtools-inline backend bundle
 *
 * fetch + new Function 执行 IIFE。注意：bundle 用 `var ReactDevToolsBackend = (...)()`
 * 导出，var 在 Function 体内是局部作用域（.call(window) 也救不了 var），必须在
 * 函数尾部 return 出来再手动挂 window。
 * 失败静默（React devtools 是可选功能，不阻塞 SDK），但打 error 日志方便排查。
 */
function loadBackendBundle(): Promise<BackendModule> {
  if (backendLoadPromise) return backendLoadPromise;
  backendLoadPromise = (async () => {
    const target = window as unknown as Record<string, unknown>;
    const existing = target[BACKEND_GLOBAL];
    if (existing) return existing as BackendModule;

    const url = resolveServerOrigin() + BACKEND_URL;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`React DevTools backend 加载失败: HTTP ${resp.status}`);
    const code = await resp.text();

    const mod = new Function(
      `${code}\n;return typeof ReactDevToolsBackend !== 'undefined' ? ReactDevToolsBackend : undefined`,
    ).call(window);
    if (!mod) throw new Error("React DevTools backend bundle 未导出全局");
    target[BACKEND_GLOBAL] = mod;
    return mod as BackendModule;
  })();
  return backendLoadPromise;
}

/** backend 是否已激活（Agent 只启动一次） */
let backendActivated = false;

/** 激活后绑定的「控制台消息 → backend Wall」转发函数 */
let frontendToBackend: ((msg: { event: string; payload: unknown }) => void) | null = null;

/** 当前活跃的 Bridge（reactivate 时 shutdown 旧的，避免双 agent 重复发消息） */
let activeBridge: { shutdown: () => void } | null = null;

/** 当前活跃 wall 的静音函数（reactivate 时先吞掉旧 bridge 的 shutdown 广播） */
let muteActiveWall: (() => void) | null = null;

/**
 * 自定义 Relay Wall：backend Bridge ↔ SilkPulse WS
 *
 * 可静音（mute）：reactivate 关闭旧 bridge 前必须先静音——
 * bridge.shutdown() 会向 wall 广播 `shutdown` 事件，而此时控制台侧已换成新重载的
 * frontend，其 Store 收到 `shutdown` 会摘掉 operations 等全部监听，之后即使重新
 * 握手成功、初始树也永远无人处理（组件树卡 Loading）。静音后 shutdown 广播被
 * 吞掉，旧 agent 的本地清理（摘 hook 监听防双发）不受影响。
 */
function createRelayWall() {
  let muted = false;
  const wallListeners: Array<(msg: { event: string; payload: unknown }) => void> = [];
  const wall = {
    listen(fn: (msg: { event: string; payload: unknown }) => void) {
      wallListeners.push(fn);
      return () => {
        const i = wallListeners.indexOf(fn);
        if (i >= 0) wallListeners.splice(i, 1);
      };
    },
    send(event: string, payload: unknown) {
      /** 静音后丢弃（旧 agent 的残余消息不再到达任何 frontend） */
      if (muted) return;
      send({
        type: "devtools-relay",
        plugin: "react",
        payload: { event, payload, fromBackend: true },
      });
    },
  };
  return {
    wall,
    /** 控制台 frontend → backend：把路由层消息分发给当前 wall 的 listeners */
    dispatch(msg: { event: string; payload: unknown }) {
      for (const fn of wallListeners) fn(msg);
    },
    /** 后续 send 全部丢弃（listen 不动，bridge.shutdown 会自己 removeAllListeners） */
    mute() {
      muted = true;
    },
  };
}

/**
 * 合成 savedPreferences 握手回包
 *
 * activate → startActivation 会发 getSavedPreferences 并等 frontend 回 savedPreferences
 * 才 finishActivation（建 Agent + flush 初始树）。真实回包链路依赖：新 frontend 的
 * 一次性监听还在 + WS 往返不丢 + iframe 未处于重载中途——任一环错位即死锁（树永久
 * Loading）。这里在 activate 后同步补一帧合成回包，让握手确定性完成；frontend 稍后
 * 到达的真实回包因监听已被消耗而被忽略，无副作用（过滤项后续可通过
 * overrideComponentFilters 动态更新）。
 */
function completeActivationHandshake(
  dispatch: (msg: { event: string; payload: unknown }) => void,
): void {
  dispatch({
    event: "savedPreferences",
    payload: {
      appendComponentStack: true,
      breakOnConsoleErrors: false,
      /** 空过滤器 = 不隐藏任何组件（默认最大可见性） */
      componentFilters: [],
      showInlineWarningsAndErrors: true,
      hideConsoleLogsInStrictMode: false,
    },
  });
}

/** reactivate 防抖（多次 activate 请求合并为一次重建） */
let reactivatePromise: Promise<void> | null = null;

/**
 * reactivate 的 renderer id 映射（oldId → newId）
 *
 * 每次 reactivate 重新 inject 会分配新 id，而 react-dom 终身持有最老 id。
 * rendererInterfaces 只保留 newId 单 entry（防 initBackend 的 forEach 双 flush），
 * oldId 的 commit 调用由 hook 方法包装层转发到 newId。
 */
const rendererIdRemap = new Map<number, number>();

/**
 * 包装 realHook 的按 rendererID 寻址的方法：oldId 调用透明转发到 newId
 *
 * 覆盖 onCommitFiberRoot / onCommitFiberUnmount / onPostCommitFiberRoot /
 * getFiberRoots——bundle 内部（onCommitFiberRoot 查 mountedRoots）与
 * react-dom（经 stub 委托）都通过属性访问调用，包装稳定生效。
 * 映射未命中时透传原 id（首次激活路径无映射，零开销）。
 * 幂等：重复安装会叠加包装但语义不变（remap 查两次同结果）。
 */
function installRendererIdRemap(hook: RealHook, remap: Map<number, number>): void {
  /** 单个 id 重写（映射未命中时透传原 id） */
  const rewrite = (id: number): number => remap.get(id) ?? id;

  const origCommitRoot = hook.onCommitFiberRoot.bind(hook);
  hook.onCommitFiberRoot = (id, root, priorityLevel) =>
    origCommitRoot(rewrite(id), root, priorityLevel);

  const origCommitUnmount = hook.onCommitFiberUnmount.bind(hook);
  hook.onCommitFiberUnmount = (id, fiber) => origCommitUnmount(rewrite(id), fiber);

  if (hook.onPostCommitFiberRoot) {
    const origPostCommit = hook.onPostCommitFiberRoot.bind(hook);
    hook.onPostCommitFiberRoot = (id, root) => origPostCommit(rewrite(id), root);
  }

  const origGetRoots = hook.getFiberRoots.bind(hook);
  hook.getFiberRoots = (id) => origGetRoots(rewrite(id));
}

/**
 * 激活 React DevTools backend
 *
 * 1. fetch backend bundle
 * 2. 在 shadow 对象上 installHook（拿真 hook，不动 window 上的 stub）
 * 3. replay stub 收集的 renderer → 真 hook.inject
 * 4. 合并 stub 阶段的 fiberRoots 到真 hook
 * 5. createBridge(自定义 Wall) + activate → initBackend → flushInitialOperations
 */
async function activateBackend(): Promise<void> {
  if (backendActivated) {
    /** 已激活：控制台重载了 frontend（切设备/插件页重开），需要重新握手——
     * 旧 agent 的初始 operations 只发给旧 frontend，新 frontend 收不到，树会永远 Loading。
     * 重建 bridge+agent → initBackend → flushInitialOperations 重发初始树。 */
    if (!reactivatePromise) {
      reactivatePromise = reactivateBackend().finally(() => {
        reactivatePromise = null;
      });
    }
    return reactivatePromise;
  }
  backendActivated = true;
  try {
    /** 后注入兜底：react-dom 早于 SDK 加载时（stub 没收到 inject），
     *  DOM 扫描合成 renderer——必须在 loadBackendBundle 之前，
     *  让 replay 与真实 inject 走同一条路 */
    recoverReactRoots();
    const backend = await loadBackendBundle();

    /** shadow target：一个空对象，installHook 会把真 hook defineProperty 到它上面 */
    const shadowTarget: Record<string, unknown> = {};
    backend.initialize(shadowTarget as unknown as Window);
    const hook = shadowTarget.__REACT_DEVTOOLS_GLOBAL_HOOK__ as RealHook | undefined;
    if (!hook) throw new Error("installHook 未在 shadow target 上创建 hook");

    /** replay stub 阶段的 renderer 注册（react-dom 早已调过 stub.inject） */
    for (const { renderer } of pendingRenderers) {
      hook.inject(renderer);
    }

    /** 合并 stub 收集的 fiberRoots（真 hook 的 attachRenderer 会读它们重建树） */
    for (const [rendererID, roots] of Object.entries(stubFiberRoots)) {
      const realRoots = hook.getFiberRoots(Number(rendererID));
      for (const root of roots) realRoots.add(root);
    }

    /** 合并 stub 阶段的事件订阅（若有） */
    for (const [event, fns] of Object.entries(stubListeners)) {
      for (const fn of fns) hook.on(event, fn);
    }

    /** 自定义 Wall：backend ↔ SilkPulse WS（dispatch 即「控制台消息 → backend」路由） */
    const { wall, dispatch, mute } = createRelayWall();
    muteActiveWall = mute;
    frontendToBackend = dispatch;

    /** 激活：Agent 创建 + initBackend（读 hook.rendererInterfaces → flushInitialOperations） */
    const bridge = backend.createBridge(shadowTarget as unknown as Window, wall);
    backend.activate(shadowTarget as unknown as Window, { bridge });
    activeBridge = bridge as unknown as { shutdown: () => void };
    completeActivationHandshake(dispatch);

    /** stub 从此委托给真 hook（window 上的 stub 对象引用不变） */
    realHook = hook;
  } catch (e) {
    backendActivated = false;
    /** React devtools 是可选增强功能，激活失败不阻塞 SDK 其他能力；
     *  打日志方便线上排查（catch 静默会让后注入问题难定位） */
    console.error("[silkpulse] React backend 激活失败:", e);
  }
}

/**
 * 重新握手：为重载后的 frontend 重建 bridge + agent
 *
 * shutdown 旧 bridge（agent 会摘掉自己的 hook 监听）→ 重建 rendererInterfaces
 * → 重新 createBridge/activate。
 *
 * rendererInterfaces 必须重建（不能复用）：interface 闭包内的
 * rootToFiberInstanceMap / rootPseudoKeys 等状态属于旧 agent 生命周期。
 * 复用时新 agent 的 handleCommitFiberRoot 走 update 分支（旧 map 非空），
 * 永远不写新 agent 的 rootPseudoKeys（那个 Map 在 agent 闭包里），
 * inspectElement 轮询 getPathForElement 抛
 * "Expected mounted root to have known pseudo key"，选中节点的 state 冻结。
 * 清空后重新 inject：attachRenderer 造全新 interface，flushInitialOperations
 * 重走 mount 分支，pseudo key 重新建立。
 */
async function reactivateBackend(): Promise<void> {
  try {
    if (!realHook) return;
    const backend = await loadBackendBundle();

    /** 旧 agent 停摆：先静音 wall（吞掉 shutdown 广播，防新 frontend 的 Store 摘监听），
     * 再 shutdown（agent 本地清理：摘 hook 监听防双发） */
    muteActiveWall?.();
    try {
      activeBridge?.shutdown();
    } catch {
      /** 已关闭忽略 */
    }
    activeBridge = null;

    /** 旧 renderer 的 [id, internals]（inject 分配的 id 被 react-dom 终身持有，
     *  commit 时用它查 rendererInterfaces）。
     *  按 renderer 对象去重并保留最老 entry：历史 reactivate 会往 renderers 累积
     *  同一 renderer 的多个 id 条目（inject 每次分配新 id），不去重会指数级重复
     *  注入（树 ×2^n）；而 react-dom 终身持有的恰是 Map 保序的第一个（最老）id，
     *  保留它才能让 onCommitFiberRoot(oldId) 继续命中新 interface。
     *  renderers 本身无读者（仅 inject 写入），累积无害，故不 clear */
    const seenRenderers = new Set<RendererInternals>();
    const oldRenderers = [...realHook.renderers.entries()].filter(([, renderer]) =>
      seenRenderers.has(renderer) ? false : (seenRenderers.add(renderer), true),
    );

    /** 清旧 interface：新 agent initBackend 的 rendererInterfaces.forEach 才不会
     *  复用旧闭包状态（pseudo key 冻结的根因） */
    realHook.rendererInterfaces.clear();

    const { wall, dispatch, mute } = createRelayWall();
    muteActiveWall = mute;
    frontendToBackend = dispatch;

    const shadowTarget = { __REACT_DEVTOOLS_GLOBAL_HOOK__: realHook } as Record<string, unknown>;
    const bridge = backend.createBridge(shadowTarget as unknown as Window, wall);
    backend.activate(shadowTarget as unknown as Window, { bridge });

    /** 重新 attach：inject → attachRenderer 造全新 interface → emit
     *  renderer-attached → agent 注册回调自动 flushInitialOperations（官方
     *  时序，与扩展 reload 场景一致）。
     *
     *  ⚠️ 不手动 flush、不往 rendererInterfaces 塞 oldId 别名 entry：
     *  initBackend 的 rendererInterfaces.forEach 会对每个 entry 各跑一次
     *  registerRendererInterface（内含 flushInitialOperations），双 entry =
     *  同一 interface flush 两次 = 全量树 operations 双发 = frontend Store
     *  mount 两棵树（树 ×2 的直接根因）。
     *  react-dom 持有的 oldId 增量路由改由下方 hook 级 id 映射转发兜住 */
    for (const [oldId, renderer] of oldRenderers) {
      const newId = realHook.inject(renderer);
      const newInterface = realHook.rendererInterfaces.get(newId);
      if (newInterface == null) continue;

      /** fiberRoots 迁移 oldId → newId：flushInitialOperations 按 interface 闭包
       *  固化的 newId 读 getFiberRoots(newId)，不迁移则初始树为空 */
      const oldRoots = realHook.getFiberRoots(oldId);
      const newRoots = realHook.getFiberRoots(newId);
      for (const root of oldRoots) newRoots.add(root);

      /** oldId → newId 映射：react-dom 终身持有 oldId（inject 返回值已缓存），
       *  onCommitFiberRoot(oldId) 等 hook 方法必须重写到 newId 才能命中
       *  rendererInterfaces 里唯一的 newId entry，否则增量永久丢失 */
      rendererIdRemap.set(oldId, newId);
    }

    /** hook 级 id 映射转发：包装 realHook 的四个按 rendererID 寻址的方法，
     *  oldId 调用透明转发到 newId（bundle 内部与 react-dom 都通过属性访问
     *  调这些方法，包装稳定生效）。幂等：多次 reactivate 只重包一次
     *  （包装函数检查映射未命中时透传原 id） */
    installRendererIdRemap(realHook, rendererIdRemap);

    activeBridge = bridge as unknown as { shutdown: () => void };
    completeActivationHandshake(dispatch);
  } catch {
    /** 重建失败保留旧状态（下次 activate 再试） */
  }
}

/**
 * Agent DevTools 能力用：确保 backend 已激活（幂等）
 *
 * 无控制台 frontend 时也可激活——本地直调 rendererInterface/agent 不依赖 bridge 对端，
 * bridge 发出的消息经 WS 透传无人接收，无副作用。
 */
export async function ensureReactBackendActive(): Promise<void> {
  if (backendActivated && realHook) return;
  await activateBackend();
}

/** Agent DevTools 能力用：拿激活后的真 hook（含 rendererInterfaces / reactDevtoolsAgent） */
export function getActiveReactHook(): RealHook | null {
  return realHook;
}

/**
 * 初始化 React DevTools bridge（SDK 顶层同步调用）
 *
 * 同步装 hook stub（react-dom 加载前），异步注册 server 消息处理。
 */
export function initReactDevToolsBridge(): void {
  installDelegatingHookStub();

  /** 后注入兜底：react-dom 已加载（inject 已飞走）时立即恢复一次。
   *  react-dom 在 SDK 之后加载的场景由 stub.inject 自然覆盖 */
  recoverReactRoots();

  registerServerMessageHandler((msg) => {
    if (msg.type !== "devtools-relay" || msg.plugin !== "react") return;
    const data = msg.payload as {
      event?: string;
      payload?: unknown;
      activate?: boolean;
      refresh?: boolean;
      fromBackend?: boolean;
    };

    /** 控制台打开面板时请求激活（幂等，backendActivated 守卫）
     *
     * payload 可能是 SuperJSON 信封字符串（vue 串扰）或普通对象，只认对象形态 */
    if (typeof data === "object" && data?.activate === true) {
      void activateBackend();
      return;
    }

    /** 控制台「刷新」指令：reactivate 重建 bridge → flushInitialOperations
     *  重发全量树事件 → frontend 原地更新（保留选中/展开状态，不重载 iframe）。
     *  生产构建无 onCommitFiberRoot 推送，这是官方等价的「拉新」路径 */
    if (typeof data === "object" && data?.refresh === true) {
      void reactivateBackend();
      return;
    }

    /** 控制台 frontend 发来的消息 → 转给 backend 的 Wall listener */
    if (
      frontendToBackend &&
      typeof data === "object" &&
      data?.fromBackend !== true &&
      typeof data?.event === "string"
    ) {
      frontendToBackend({ event: data.event, payload: data.payload });
    }
  });
}
