/**
 * 设备注册表 —— 管理所有在线设备、环形缓冲区、exec 请求映射
 *
 * 核心数据结构：
 * - devices: Map<deviceId, Device> 在线设备表
 * - 每个设备内置环形缓冲区（logs/network/errors），HTTP API 直接读，不打扰设备
 * - exec 等待映射：execId → resolve 回调，设备回传 exec-result 时 resolve
 */

import type { WebSocket } from 'ws'
import type {
  DeviceInfo,
  OfflineDeviceSummary,
  LogEntry,
  NetworkEntry,
  ErrorEntry,
  ExecResult,
} from '@clarosight/shared'

/** 环形缓冲区大小常量 */
const MAX_LOGS = 500
const MAX_NETWORK = 100
const MAX_ERRORS = 50

/**
 * 环形缓冲区：固定容量，写满后覆盖最旧条目
 * 支持 since 游标查询（返回序号 > since 的所有条目）
 *
 * 序号由缓冲区内部维护，不污染条目本身 —— 条目保持 protocol 定义的纯净形态。
 * seq 与 items 索引一一对应：第 N 条数据的序号 = baseSeq + N。
 */
class RingBuffer<T> {
  /** 已被 shift 掉的条目数，即当前 items[0] 的全局序号 */
  private baseSeq = 0

  constructor(
    private readonly capacity: number,
    private items: T[] = [],
  ) {}

  /** 下一项将获得的全局序号 */
  nextSeq(): number {
    return this.baseSeq + this.items.length
  }

  /** 写入一条（序号自动递增） */
  push(item: T): T {
    this.items.push(item)
    if (this.items.length > this.capacity) {
      this.items.shift()
      this.baseSeq++
    }
    return item
  }

  /** 取最后一条（无数据返回 undefined）—— 连续重复日志聚合用 */
  last(): T | undefined {
    return this.items[this.items.length - 1]
  }

  /** 按 seq 查找条目（WS 帧追加/状态更新用，找不到返回 undefined） */
  findBySeq(seq: number): T | undefined {
    return this.items.find((it) => (it as { seq?: number }).seq === seq)
  }

  /** 返回序号 > since 的所有条目 */
  since(since: number): T[] {
    if (!since) return this.all()
    /** since+1 起算，换算成 items 内偏移 */
    const offset = since + 1 - this.baseSeq
    if (offset <= 0) return this.all()
    if (offset >= this.items.length) return []
    return this.items.slice(offset)
  }

  /** 全部条目 */
  all(): T[] {
    return this.items.slice()
  }

  /** 当前最大序号（客户端用它作为下次查询的 since 游标） */
  latestSeq(): number {
    return this.nextSeq()
  }
}

/** LogEntry 不含 seq，缓冲区内部跟踪序号 */
class LogBuffer extends RingBuffer<LogEntry> {
  constructor() {
    super(MAX_LOGS)
  }
}

class NetworkBuffer extends RingBuffer<NetworkEntry> {
  constructor() {
    super(MAX_NETWORK)
  }
}

class ErrorBuffer extends RingBuffer<ErrorEntry> {
  constructor() {
    super(MAX_ERRORS)
  }
}

/** 单个在线设备的全部状态 */
export interface Device {
  /** 设备元信息 */
  info: DeviceInfo
  /** 设备的 WebSocket 连接 */
  ws: WebSocket
  /** console 日志环形缓冲区 */
  logs: LogBuffer
  /** network 请求环形缓冲区 */
  network: NetworkBuffer
  /** 错误环形缓冲区 */
  errors: ErrorBuffer
  /**
   * exec 等待映射：execId → { resolve 回调, 超时定时器句柄 }
   *
   * 存 timer 是为了设备掉线时能 clearTimeout，否则 unregister 遍历 resolve 后，
   * 10s 定时器仍会触发（Promise 二次 resolve 无害但句柄泄漏 + 操作已下线设备的 Map）。
   */
  pendingExecs: Map<string, { resolve: (result: ExecResult) => void; timer: ReturnType<typeof setTimeout> }>
}

/**
 * 设备注册表
 * 管理设备上下线、缓冲区读写、exec 请求路由
 */
export class DeviceRegistry {
  private devices = new Map<string, Device>()
  /**
   * 最近下线设备摘要（环形缓冲，上限 10 个）
   *
   * 设备下线后从 devices 删除，但保留一份摘要在此，让 AI 能区分
   * "从未接入"和"接入过但掉了"。设备重连时移除其旧摘要（已恢复在线）。
   */
  private offlineHistory: OfflineDeviceSummary[] = []
  private static readonly MAX_OFFLINE_HISTORY = 10
  /** 设备上线/下线时的监听器（供 ws-relay 推送给控制台） */
  private listeners: Array<(event: DeviceListEvent) => void> = []

  /** 注册监听器，返回取消注册函数 */
  onChange(listener: (event: DeviceListEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  private emit(event: DeviceListEvent) {
    for (const l of this.listeners) l(event)
  }

  /** 设备上线（含重连：同 id 复用缓冲区，只更新 ws，不丢历史数据） */
  register(info: DeviceInfo, ws: WebSocket): Device {
    /** 设备恢复在线，从下线历史移除（不再算"最近下线"） */
    this.offlineHistory = this.offlineHistory.filter((o) => o.id !== info.id)
    const existing = this.devices.get(info.id)
    if (existing) {
      /** 重连：保留 logs/network/errors 历史，只换连接和元信息。
       *  tags/note 以 server 侧为准（可能被控制台/API 修改过），不被 SDK 上报覆盖。
       *  icon 同理：SDK register 时只带 URL，已有的 data URL icon 不被覆盖。
       *  仅当 SDK 上报了非空 tags/note 且 server 侧为空时才采纳（首次带标签接入） */
      const mergedTags = existing.info.tags.length > 0
        ? existing.info.tags
        : (info.tags ?? [])
      const mergedNote = existing.info.note || info.note
      /** icon：优先保留已有的 data URL（更可靠），否则用新上报的 */
      const mergedIcon = existing.info.icon?.startsWith('data:')
        ? existing.info.icon
        : info.icon
      existing.ws = ws
      existing.info = {
        ...info,
        icon: mergedIcon,
        onlineAt: existing.info.onlineAt,
        tags: mergedTags,
        note: mergedNote,
      }
      this.emit({ type: 'online', device: existing.info })
      return existing
    }
    const device: Device = {
      info,
      ws,
      logs: new LogBuffer(),
      network: new NetworkBuffer(),
      errors: new ErrorBuffer(),
      pendingExecs: new Map(),
    }
    this.devices.set(info.id, device)
    this.emit({ type: 'online', device: info })
    return device
  }

  /** 设备下线 */
  unregister(deviceId: string) {
    const device = this.devices.get(deviceId)
    if (!device) return
    /** 设备掉线时，reject 所有未完成的 exec + 清理超时定时器（防泄漏） */
    for (const [, entry] of device.pendingExecs) {
      clearTimeout(entry.timer)
      entry.resolve({
        success: false,
        error: '设备已断开连接',
      })
    }
    device.pendingExecs.clear()
    /** 记录下线摘要（供 AI 判断"接入过但掉了"），环形缓冲防膨胀 */
    this.offlineHistory.push({
      id: device.info.id,
      projectId: device.info.projectId,
      url: device.info.url,
      title: device.info.title,
      deviceType: device.info.deviceType,
      offlineAt: Date.now(),
      onlineAt: device.info.onlineAt,
      errorCount: device.info.errorCount,
      tags: device.info.tags,
    })
    if (this.offlineHistory.length > DeviceRegistry.MAX_OFFLINE_HISTORY) {
      this.offlineHistory.shift()
    }
    this.devices.delete(deviceId)
    this.emit({ type: 'offline', deviceId })
  }

  /** 获取单个设备 */
  get(deviceId: string): Device | undefined {
    return this.devices.get(deviceId)
  }

  /** 所有在线设备信息（用于 HTTP API /api/devices） */
  list(): DeviceInfo[] {
    return Array.from(this.devices.values()).map((d) => d.info)
  }

  /**
   * 按项目过滤的在线设备信息（鉴权模式下，控制台只能看自己项目的设备）
   *
   * @param projectId 项目 ID（undefined=超管，看全部）
   */
  listByProject(projectId?: string): DeviceInfo[] {
    return Array.from(this.devices.values())
      .filter((d) => projectId === undefined || d.info.projectId === projectId)
      .map((d) => d.info)
  }

  /**
   * 按项目过滤的最近下线设备摘要
   *
   * @param projectId 项目 ID（undefined=超管，看全部）
   */
  listOfflineByProject(projectId?: string): OfflineDeviceSummary[] {
    return this.offlineHistory.filter((o) => projectId === undefined || o.projectId === projectId)
  }

  /** 最近下线设备摘要（用于 AI 判断"接入过但掉了"） */
  listOffline(): OfflineDeviceSummary[] {
    return [...this.offlineHistory]
  }

  /** 更新设备元信息（页面导航、错误数变化时） */
  updateInfo(deviceId: string, patch: Partial<DeviceInfo>) {
    const device = this.devices.get(deviceId)
    if (!device) return
    /** 过滤 undefined 值（SDK 分多条 update-info 上报不同字段，未带的字段不应覆盖已有值） */
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        ;(device.info as unknown as Record<string, unknown>)[key] = value
      }
    }
  }
}

/** 设备上下线事件 */
export type DeviceListEvent =
  | { type: 'online'; device: DeviceInfo }
  | { type: 'offline'; deviceId: string }
