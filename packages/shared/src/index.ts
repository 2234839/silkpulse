/**
 * clarosight 核心协议类型 —— server / sdk / 控制台 / skill 共用的消息契约
 *
 * 通信架构：
 * - 设备 ↔ server：单一 WebSocket，设备上报采集数据，server 下发指令（exec）
 * - 控制台 ↔ server：WebSocket，订阅设备实时数据
 * - AI/skill ↔ server：HTTP API（同步请求-响应）
 */

/** 设备 → server 的消息类型 */
export type DeviceMessage =
  | { type: 'register'; device: DeviceInfo }
  | { type: 'update-info'; device: Partial<DeviceInfo> & Pick<DeviceInfo, 'id'> }
  | { type: 'log'; log: LogEntry }
  | { type: 'log-repeat' }
  | { type: 'network'; entry: NetworkEntry }
  | { type: 'ws-frame'; seq: number; frame: WsFrame }
  | { type: 'ws-state'; seq: number; wsState: number }
  | { type: 'sse-event'; seq: number; event: SseEvent }
  | { type: 'error'; error: ErrorEntry }
  | { type: 'snapshot'; snapshot: SnapshotData }
  | { type: 'exec-result'; execId: string; result: ExecResult }
  | { type: 'storage-change'; storageType: 'local' | 'session'; key?: string; timestamp?: number }
  | { type: 'dom-change'; changes: DomChangeData }

/**
 * DOM 变化数据（MutationObserver 采集，Element 面板实时刷新用）
 *
 * 每条变化只含最精简信息：哪些父节点的子树发生了变化 + 变化类型。
 * 控制台收到后只刷新受影响的已展开节点，不重拉整棵树。
 */
export interface DomChangeData {
  /** 变化的父元素 idx 列表（去重），控制台据此决定刷新哪些节点 */
  parentIdxs: number[]
  /** 本次变化的类型汇总（added/removed/attributes/text） */
  kinds: Array<'added' | 'removed' | 'attributes' | 'text'>
  /** 变化的时间戳 */
  timestamp: number
}

/** server → 设备 的消息类型 */
export type ServerToDeviceMessage =
  | { type: 'exec'; execId: string; code: string }
  /** 按需启停采集器：控制台打开对应面板时启用，关闭时停止，减少不必要的数据传输 */
  | { type: 'set-watchers'; watchers: WatcherType[] }

/** server → 控制台 的消息类型（转发设备的实时数据 + 上下线事件） */
export type ServerToConsoleMessage =
  | { type: 'device-online'; device: DeviceInfo }
  | { type: 'device-offline'; deviceId: string }
  | { type: 'device-list'; devices: DeviceInfo[] }
  | { type: 'log'; deviceId: string; log: LogEntry }
  | { type: 'log-repeat'; deviceId: string }
  | { type: 'network'; deviceId: string; entry: NetworkEntry }
  | { type: 'ws-frame'; deviceId: string; seq: number; frame: WsFrame }
  | { type: 'ws-state'; deviceId: string; seq: number; wsState: number }
  | { type: 'sse-event'; deviceId: string; seq: number; event: SseEvent }
  | { type: 'error'; deviceId: string; error: ErrorEntry }
  | { type: 'storage-change'; deviceId: string; storageType: 'local' | 'session'; key?: string; timestamp?: number }
  | { type: 'dom-change'; deviceId: string; changes: DomChangeData }

/** 控制台 → server 的消息类型 */
export type ConsoleMessage =
  | { type: 'subscribe'; deviceId: string }
  | { type: 'unsubscribe'; deviceId: string }
  /** 控制台通知 server 当前启用的 watcher（按需采集，减少不必要的数据传输） */
  | { type: 'set-watchers'; deviceId: string; watchers: WatcherType[] }

/**
 * 可按需启停的采集器类型
 *
 * 控制台打开对应面板时启用，关闭面板时停止。
 * - storage：Storage 面板打开时启用 storage-watcher
 * - dom：Element 面板打开时启用 dom-watcher
 */
export type WatcherType = 'storage' | 'dom'

/** 设备元信息 */
export interface DeviceInfo {
  /** 设备唯一标识（sdk 端生成，sessionStorage 持久化，保证同 tab 刷新不变） */
  id: string
  /** 所属项目 ID（鉴权模式下由 server 在连接时分配） */
  projectId?: string
  /** 当前页面 URL */
  url: string
  /** 页面标题 */
  title: string
  /** 页面图标 URL（SDK 从 <link rel="icon"> 采集，兜底 /favicon.ico） */
  icon?: string
  /** User-Agent */
  userAgent: string
  /** 视口宽度（移动端识别） */
  viewportWidth: number
  /** 视口高度 */
  viewportHeight: number
  /** 设备类型（mobile/tablet/desktop，基于 UA + 视口推断） */
  deviceType: 'mobile' | 'tablet' | 'desktop'
  /** 最近一次上报的错误数 */
  errorCount: number
  /** 上线时间戳（ms） */
  onlineAt: number
  /** 自定义标签（多设备场景区分用，如 "生产环境" / "用户A"） */
  tags: string[]
  /** 自定义备注（一句话描述这台设备的身份） */
  note?: string
}

/**
 * 最近下线设备摘要（供 AI 判断"设备接入过但掉了" vs "从未接入"）
 *
 * 诊断间歇性问题时，AI 连上 server 发现无在线设备，若无此历史，
 * 无法区分"用户没接入"和"接入过但刚掉线"，导致诊断方向错误。
 */
export interface OfflineDeviceSummary {
  /** 设备 id */
  id: string
  /** 所属项目 ID */
  projectId?: string
  /** 最后的页面 URL */
  url: string
  /** 最后的页面标题 */
  title: string
  /** 设备类型 */
  deviceType: 'mobile' | 'tablet' | 'desktop'
  /** 下线时刻的时间戳（ms） */
  offlineAt: number
  /** 上线时刻的时间戳（ms） */
  onlineAt: number
  /** 累计错误数（下线时的快照） */
  errorCount: number
  /** 标签 */
  tags: string[]
}

/** console 日志条目 */
export interface LogEntry {
  /** ISO 时间戳 */
  timestamp: string
  /**
   * 日志级别/类型
   *
   * - info/warn/error/debug：常规级别（console.log 归并到 info）
   * - table：console.table（message 是表格数据的序列化文本）
   * - trace：console.trace（message 含堆栈）
   * - group/groupEnd：分组开始/结束（console.groupCollapsed 归并到 group），前端据此维护缩进层级
   * - count：console.count/countReset（SDK 端维护计数器，message 含计数值）
   * - time：console.time/timeEnd/timeLog（SDK 端维护计时器，message 含耗时）
   * - assert：console.assert 失败（断言成功不上报，与 DevTools 行为一致）
   * - dir：console.dir/dirxml（对象结构预览）
   * - clear：console.clear（前端收到后清空日志视图）
   */
  type: 'info' | 'warn' | 'error' | 'debug' | 'table' | 'trace' | 'group' | 'groupEnd' | 'count' | 'time' | 'assert' | 'dir' | 'clear'
  /** 序列化后的消息文本（纯文本，不含样式信息，作为搜索/复制/AI 上下文的事实标准） */
  message: string
  /**
   * 带样式的文本段（仅当 console.log 使用了 %c 占位符时存在）
   *
   * DevTools 的 %c 语义：每个 %c 消费一个后续参数作为 CSS 字符串，
   * 该 CSS 作用于 %c 之后直到下一个 %c（或行尾）的所有文本。
   * 多个 %c 叠加时，后面的样式覆盖前面的同名属性。
   *
   * 前端渲染时有 styledSegments 则渲染 <span style>，否则降级纯文本 message。
   */
  styledSegments?: { text: string; style?: string }[]
  /**
   * 连续重复次数（仅当 >1 时存在）
   *
   * 页面循环/spam 同一条日志时，SDK 聚合为一条 + repeat 计数，
   * 避免重复日志占满环形缓冲区、挤掉有价值的诊断日志。
   * 与 Chrome DevTools 的重复日志 ⓧN 行为一致。
   */
  repeat?: number
}

/** WebSocket 帧（send/recv/event） */
export interface WsFrame {
  /** ISO 时间戳 */
  timestamp: string
  /** 方向：send 发出 / recv 收到 / event 连接事件（close/error） */
  dir: 'send' | 'recv' | 'event'
  /** 帧数据（截断到 500 字符，二进制标记类型+大小） */
  data: string
}

/** SSE 事件（Server-Sent Events 流式推送的单条事件） */
export interface SseEvent {
  /** ISO 时间戳 */
  timestamp: string
  /** 事件类型（event: 字段的值，默认 'message'） */
  event: string
  /** 事件 ID（id: 字段的值，断线重连用） */
  id?: string
  /** 事件数据（data: 字段的值，多行合并，截断到 500 字符） */
  data: string
}

/** network 请求条目（HAR 风格，借鉴 PageSpy） */
export interface NetworkEntry {
  /** 内部递增序号（环形缓冲区定位用） */
  seq: number
  /** ISO 时间戳 */
  timestamp: string
  /** 请求 URL */
  url: string
  /** HTTP 方法（WS 连接用 'WS'/'WSS'） */
  method: string
  /** 响应状态码（请求未完成时为 0；WS 连接用 readyState 0-3） */
  status: number
  /** 请求头（截断） */
  reqHeaders?: Record<string, string>
  /** 请求体（截断到 500 字符） */
  reqBody?: string
  /** 响应头（截断） */
  resHeaders?: Record<string, string>
  /** 响应体（截断到 1000 字符） */
  resBody?: string
  /**
   * 响应体编码方式
   * - undefined：默认文本（resBody 是原始文本）
   * - 'base64'：二进制数据经 base64 编码（resBody 是 base64 字符串，用 resBodyMime 判断具体类型）
   * - 'info'：二进制但未读取内容（resBody 是描述信息如 "[Blob image/png 1234b]"）
   */
  resBodyEncoding?: 'base64' | 'info'
  /** 响应体 MIME 类型（resBodyEncoding='base64' 时有值，如 image/png） */
  resBodyMime?: string
  /** 耗时（ms） */
  duration: number
  /** 是否出错 */
  error?: string
  /** 标识这是 WebSocket 连接条目（普通 HTTP 请求无此字段） */
  protocol?: 'ws'
  /** 请求类型：fetch（fetch API）/ xhr（XMLHttpRequest）/ ws（WebSocket）/ resource（<script>/<link>/等静态资源） */
  kind?: 'fetch' | 'xhr' | 'ws' | 'resource'
  /** 资源 MIME 类型（仅 resource 类型，如 text/css/application/javascript） */
  mimeType?: string
  /** 资源体积（字节，仅 resource 类型） */
  size?: number
  /** WebSocket readyState（0=CONNECTING/1=OPEN/2=CLOSING/3=CLOSED），仅 WS 条目 */
  wsState?: number
  /** 帧时间线（send/recv/event），仅 WS 条目，上限 50 帧 FIFO */
  frames?: WsFrame[]
  /**
   * 标识这是 SSE 连接条目（text/event-stream 流式响应）
   * SSE 连接在 fetch hook 中检测到后走流式 reader 路径
   */
  sseState?: 'open' | 'closed'
  /** SSE 事件时间线，仅 SSE 条目，上限 50 条 FIFO */
  events?: SseEvent[]
}

/** 全局错误条目 */
export interface ErrorEntry {
  /** ISO 时间戳 */
  timestamp: string
  /** 错误消息 */
  message: string
  /** 错误堆栈 */
  stack?: string
  /** 来源文件（压缩后） */
  source?: string
  /** 行号（压缩后） */
  line?: number
  /** 列号（压缩后） */
  col?: number
  /** source map 解析后的原始位置（若有） */
  mapped?: SourceMapPosition
}

/** source map 解析结果：压缩位置 → 原始源码位置 */
export interface SourceMapPosition {
  /** 原始源文件路径 */
  source: string
  /** 原始行号（1-based） */
  line: number
  /** 原始列号（0-based） */
  column: number
  /** 符号名（若有） */
  name?: string
}

/**
 * 结构化序列化值 —— 用于 exec / console 返回值的可交互对象树展示
 *
 * 把任意 JS 值递归序列化为扁平的节点树：
 * - 基本类型（string/number/boolean/null/undefined）直接存值
 * - 对象/数组存为 { type, properties/elements }，每个属性值又是 SerializedValue
 * - 特殊类型（Date/RegExp/Error/Map/Set/Function）有专属 type + preview
 * - 循环引用用 refId 标记，避免无限递归
 *
 * 前端递归渲染为可展开/折叠的对象树（类似 DevTools console）。
 */
export interface SerializedValue {
  /** 值的类型标签 */
  type:
    | 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'bigint'
    | 'symbol' | 'function'
    | 'array' | 'object'
    | 'date' | 'regexp' | 'error' | 'map' | 'set'
    | 'weakmap' | 'weakset' | 'promise'
    | 'element' | 'textnode' | 'event'
    | 'unknown'
  /** 预览文本（一行摘要，如 Object { a: 1 }、Array(3)、Error: msg） */
  preview: string
  /** 原始值（string/number/boolean/bigint 直接用） */
  value?: string | number | boolean
  /** 对象/Map 的属性列表（展开时渲染） */
  properties?: SerializedProperty[]
  /** 数组的元素列表（展开时渲染） */
  elements?: SerializedValue[]
  /** 元素数量（数组/Map/Set，用于 preview 中显示长度） */
  length?: number
  /** 构造函数名（如 HTMLDivElement、Headers、URL 等） */
  constructorName?: string
  /** 循环引用标记（同一对象多次出现时，第二次起用 { type:'object', refId:N } 替代完整展开） */
  refId?: number
}

/** 对象的一个属性 */
export interface SerializedProperty {
  /** 属性名 */
  key: string
  /** 属性值 */
  value: SerializedValue
  /** 是否是 getter（影响是否能深入展开） */
  isGetter?: boolean
  /** 是否是 Symbol key */
  isSymbol?: boolean
}

/** exec 在远程设备执行 JS 的结果 */
export interface ExecResult {
  /** 是否执行成功 */
  success: boolean
  /** 序列化后的返回值（JSON 字符串，兼容旧消费方） */
  result?: string
  /** 结构化序列化返回值（可交互对象树用） */
  resultValue?: SerializedValue
  /** 错误信息 */
  error?: string
  /** exec 期间产生的 console 日志（紧凑格式：[TYPE] message） */
  logs?: string[]
  /** exec 后自动采集的页面快照文本 */
  snapshotText?: string
}

/** 页面快照数据（compact 格式的结构化形态，移植 pilot snapshot） */
export interface SnapshotData {
  /** ISO 时间戳 */
  t: string
  /** 页面 URL */
  url: string
  /** 页面标题 */
  title: string
  /** 视口宽度（px），诊断响应式/布局问题时让 AI 知道当前可视区域尺寸 */
  viewportWidth: number
  /** 视口高度（px） */
  viewportHeight: number
  /** 采集到的可见元素列表（已压缩） */
  els: SnapshotElement[]
  /** 当前错误数 */
  errors: number
  /** 最近几条错误消息 */
  lastErrors?: string[]
}

/** 快照中的单个元素 */
export interface SnapshotElement {
  /** 标签名（小写） */
  tag: string
  /** 稳定索引（跨快照复用，AI 可用它引用元素） */
  idx: number
  /** id 属性 */
  id?: string
  /** 文本内容 */
  text?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 是否为当前聚焦元素（document.activeElement） */
  focused?: boolean
  /** 是否只读（input/textarea，值不可编辑但可聚焦） */
  readOnly?: boolean
  /** 是否必填（表单校验失败时 AI 据此判断缺哪个字段） */
  required?: boolean
  /** checkbox 半选状态（全选列表的中间态） */
  indeterminate?: boolean
  /** 是否选中（checkbox/radio） */
  checked?: boolean
  /** aria-disabled（自定义组件常用，按钮可能用此而非 disabled） */
  ariaDisabled?: boolean
  /** aria-expanded（折叠/展开状态，菜单/手风琴等自定义组件） */
  ariaExpanded?: boolean
  /** input 的值 */
  value?: string
  /** placeholder */
  placeholder?: string
  /** select 的选项 */
  options?: string[]
  /** 状态标记（active/selected/checked 等，从 class 提取） */
  state?: string
  /** aria-label */
  aria?: string
  /** 链接 href（相对路径） */
  href?: string
  /** 元素所在的 iframe 标识（src 或 name，主文档元素无此字段） */
  frame?: string
  [k: string]: unknown
}
