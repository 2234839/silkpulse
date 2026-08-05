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
  | { type: 'error'; error: ErrorEntry }
  | { type: 'snapshot'; snapshot: SnapshotData }
  | { type: 'exec-result'; execId: string; result: ExecResult }

/** server → 设备 的消息类型 */
export type ServerToDeviceMessage =
  | { type: 'exec'; execId: string; code: string }

/** server → 控制台 的消息类型（转发设备的实时数据 + 上下线事件） */
export type ServerToConsoleMessage =
  | { type: 'device-online'; device: DeviceInfo }
  | { type: 'device-offline'; deviceId: string }
  | { type: 'device-list'; devices: DeviceInfo[] }
  | { type: 'log'; deviceId: string; log: LogEntry }
  | { type: 'log-repeat'; deviceId: string }
  | { type: 'network'; deviceId: string; entry: NetworkEntry }
  | { type: 'error'; deviceId: string; error: ErrorEntry }

/** 控制台 → server 的消息类型 */
export type ConsoleMessage =
  | { type: 'subscribe'; deviceId: string }
  | { type: 'unsubscribe'; deviceId: string }

/** 设备元信息 */
export interface DeviceInfo {
  /** 设备唯一标识（sdk 端生成，sessionStorage 持久化，保证同 tab 刷新不变） */
  id: string
  /** 当前页面 URL */
  url: string
  /** 页面标题 */
  title: string
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
  /** 日志级别 */
  type: 'info' | 'warn' | 'error' | 'debug'
  /** 序列化后的消息文本 */
  message: string
  /**
   * 连续重复次数（仅当 >1 时存在）
   *
   * 页面循环/spam 同一条日志时，SDK 聚合为一条 + repeat 计数，
   * 避免重复日志占满环形缓冲区、挤掉有价值的诊断日志。
   * 与 Chrome DevTools 的重复日志 ⓧN 行为一致。
   */
  repeat?: number
}

/** network 请求条目（HAR 风格，借鉴 PageSpy） */
export interface NetworkEntry {
  /** 内部递增序号（环形缓冲区定位用） */
  seq: number
  /** ISO 时间戳 */
  timestamp: string
  /** 请求 URL */
  url: string
  /** HTTP 方法 */
  method: string
  /** 响应状态码（请求未完成时为 0） */
  status: number
  /** 请求头（截断） */
  reqHeaders?: Record<string, string>
  /** 请求体（截断到 500 字符） */
  reqBody?: string
  /** 响应头（截断） */
  resHeaders?: Record<string, string>
  /** 响应体（截断到 1000 字符） */
  resBody?: string
  /** 耗时（ms） */
  duration: number
  /** 是否出错 */
  error?: string
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

/** exec 在远程设备执行 JS 的结果 */
export interface ExecResult {
  /** 是否执行成功 */
  success: boolean
  /** 序列化后的返回值 */
  result?: string
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
