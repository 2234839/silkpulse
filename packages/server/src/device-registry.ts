/**
 * 设备注册表 —— 管理所有在线设备、环形缓冲区、exec 请求映射
 *
 * 核心数据结构：
 * - devices: Map<deviceId, Device> 在线设备表
 * - 每个设备内置环形缓冲区（logs/network/errors），HTTP API 直接读，不打扰设备
 * - exec 等待映射：execId → resolve 回调，设备回传 exec-result 时 resolve
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DeviceConn } from "./device-conn.js";
import type {
  DeviceInfo,
  OfflineDeviceSummary,
  LogEntry,
  NetworkEntry,
  ErrorEntry,
  ExecResult,
} from "@silkpulse/shared";

/** 环形缓冲区大小常量 */
const MAX_LOGS = 500;
const MAX_NETWORK = 300;
const MAX_ERRORS = 100;

/**
 * 日志落盘防抖间隔（ms）：日志风暴下每条都同步写盘会拖垮吞吐，
 * 合并短窗口内的写入，最坏丢窗口内的最后几条（服务被 kill -9 时）。
 */
const LOG_FLUSH_DEBOUNCE_MS = 2000;

/**
 * 环形缓冲区：固定容量，写满后覆盖最旧条目
 * 支持 since 游标查询（返回序号 > since 的所有条目）
 *
 * 序号由缓冲区内部维护，不污染条目本身 —— 条目保持 protocol 定义的纯净形态。
 * seq 与 items 索引一一对应：第 N 条数据的序号 = baseSeq + N。
 */
class RingBuffer<T> {
  /** 已被 shift 掉的条目数，即当前 items[0] 的全局序号 */
  private baseSeq = 0;

  constructor(
    private readonly capacity: number,
    private items: T[] = [],
  ) {}

  /** 下一项将获得的全局序号 */
  nextSeq(): number {
    return this.baseSeq + this.items.length;
  }

  /** 写入一条（序号自动递增） */
  push(item: T): T {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.baseSeq++;
    }
    return item;
  }

  /** 取最后一条（无数据返回 undefined）—— 连续重复日志聚合用 */
  last(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /** 按 seq 查找条目（WS 帧追加/状态更新用，找不到返回 undefined） */
  findBySeq(seq: number): T | undefined {
    return this.items.find((it) => (it as { seq?: number }).seq === seq);
  }

  /** 返回序号 > since 的所有条目 */
  since(since: number): T[] {
    if (!since) return this.all();
    /** since+1 起算，换算成 items 内偏移 */
    const offset = since + 1 - this.baseSeq;
    if (offset <= 0) return this.all();
    if (offset >= this.items.length) return [];
    return this.items.slice(offset);
  }

  /** 全部条目 */
  all(): T[] {
    return this.items.slice();
  }

  /** 当前最大序号（客户端用它作为下次查询的 since 游标） */
  latestSeq(): number {
    return this.nextSeq();
  }
}

/** LogEntry 不含 seq，缓冲区内部跟踪序号 */
class LogBuffer extends RingBuffer<LogEntry> {
  constructor() {
    super(MAX_LOGS);
  }
}

class NetworkBuffer extends RingBuffer<NetworkEntry> {
  constructor() {
    super(MAX_NETWORK);
  }
}

class ErrorBuffer extends RingBuffer<ErrorEntry> {
  constructor() {
    super(MAX_ERRORS);
  }
}

/** 单个在线设备的全部状态 */
export interface Device {
  /** 设备元信息 */
  info: DeviceInfo;
  /**
   * 设备的 WebSocket 连接池（同一 deviceId 可同时存在多条活连接）
   *
   * 场景：reload 时新旧连接短暂共存；Web Locks 不可用的浏览器里
   * 复制标签页也会共享 id。数据上行（log/network/...）任意连接都可写入；
   * 指令下行（exec/屏幕共享）走 latestSocket（最后一次 register 的连接）。
   */
  sockets: Set<DeviceConn>;
  /** 最后一次 register 的连接（指令下发的首选目标） */
  latestSocket: DeviceConn;
  /** 每条连接的 sessionToken（页面加载唯一，reload 变 / WS 重连不变） */
  sessionTokens: Map<DeviceConn, string>;
  /** console 日志环形缓冲区 */
  logs: LogBuffer;
  /** network 请求环形缓冲区 */
  network: NetworkBuffer;
  /** 错误环形缓冲区 */
  errors: ErrorBuffer;
  /**
   * exec 等待映射：execId → { resolve 回调, 超时定时器句柄 }
   *
   * 存 timer 是为了设备掉线时能 clearTimeout，否则 unregister 遍历 resolve 后，
   * 10s 定时器仍会触发（Promise 二次 resolve 无害但句柄泄漏 + 操作已下线设备的 Map）。
   */
  pendingExecs: Map<
    string,
    { resolve: (result: ExecResult) => void; timer: ReturnType<typeof setTimeout> }
  >;
}

/**
 * 设备下线宽限期（ms）
 *
 * reload 时旧连接断开 → 新连接 register 之间有一个空窗（典型 < 1s）。
 * 立即 unregister 会让控制台设备列表闪烁、历史缓冲丢失。
 * 最后一条连接断开后等待宽限期，期内重新 register 则无缝续接。
 */
const OFFLINE_GRACE_MS = 5000;

/**
 * 设备注册表
 * 管理设备上下线、缓冲区读写、exec 请求路由
 */
export class DeviceRegistry {
  private devices = new Map<string, Device>();
  /** 宽限期定时器：deviceId → timer（期内重新 register 则取消） */
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 最近下线设备摘要（环形缓冲，上限 10 个）
   *
   * 设备下线后在 devices 中保留（标记 offlineAt，缓存数据仍可查看），此处另留一份
   * 摘要供 AI 区分"从未接入"和"接入过但掉了"。设备重连时移除其旧摘要（已恢复在线）。
   */
  private offlineHistory: OfflineDeviceSummary[] = [];
  private static readonly MAX_OFFLINE_HISTORY = 10;
  /** 设备上线/下线时的监听器（供 ws-relay 推送给控制台） */
  private listeners: Array<(event: DeviceListEvent) => void> = [];
  /** 设备被强制踢除（项目销毁）时的监听器，返回取消函数 */
  private evictListeners: Array<() => void> = [];

  /** 日志落盘文件路径（空 = 不持久化，测试/内存模式） */
  private logStorePath: string | null = null;
  /** 防抖定时器：合并短窗口内多次写入 */
  private logFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 开启日志落盘（server 启动时调用，传 SILKPULSE_DATA_DIR 下的路径）
   *
   * 日志是诊断的真相源，服务重启（部署 docker restart / 崩溃）不应清空历史；
   * 启动时恢复上次落盘的各设备日志缓冲，断点续看。
   */
  enableLogPersistence(filePath: string): void {
    this.logStorePath = filePath;
    this.loadPersistedLogs();
  }

  /** 启动时从磁盘恢复各设备日志缓冲 */
  private loadPersistedLogs(): void {
    if (!this.logStorePath || !existsSync(this.logStorePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.logStorePath, "utf-8")) as Record<
        string,
        LogEntry[]
      >;
      for (const [deviceId, entries] of Object.entries(raw)) {
        if (!Array.isArray(entries) || entries.length === 0) continue;
        const device = this.devices.get(deviceId);
        if (!device) continue;
        /** 恢复的条目超过容量时只留尾部（与环形缓冲语义一致） */
        for (const entry of entries.slice(-MAX_LOGS)) device.logs.push(entry);
      }
    } catch {
      /** 文件损坏时从空开始，不阻听启动 */
    }
  }

  /**
   * 追加一条日志到设备缓冲（含落盘钩子）
   *
   * device-channel 收到 SDK log 帧时调用；log-repeat 只改 repeat 不走这里
   * （repeat 修改同一条目，不新增数据，落盘由下一次 appendLog 顺带带走）。
   */
  appendLog(deviceId: string, log: LogEntry): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.logs.push(log);
    this.scheduleLogFlush();
  }

  /** 防抖落盘：合并窗口内的多次写入，一次同步写 */
  private scheduleLogFlush(): void {
    if (!this.logStorePath) return;
    if (this.logFlushTimer) return;
    this.logFlushTimer = setTimeout(() => {
      this.logFlushTimer = null;
      this.flushLogsNow();
    }, LOG_FLUSH_DEBOUNCE_MS);
    /** 进程退出前把窗口内的日志刷出去（否则 kill 时丢最后 2s） */
    this.logFlushTimer.unref?.();
  }

  /** 立即把全部设备的日志缓冲写到磁盘 */
  private flushLogsNow(): void {
    if (!this.logStorePath) return;
    try {
      const dir = dirname(this.logStorePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const snapshot: Record<string, LogEntry[]> = {};
      for (const [id, device] of this.devices) {
        const logs = device.logs.all();
        if (logs.length > 0) snapshot[id] = logs;
      }
      writeFileSync(this.logStorePath, JSON.stringify(snapshot), "utf-8");
    } catch {
      /** 磁盘写失败不影响内存缓冲：日志功能降级为重启丢失 */
    }
  }

  /** 注册 evict 监听（项目销毁踢设备后，控制台需要刷新列表） */
  onEvict(listener: () => void): () => void {
    this.evictListeners.push(listener);
    return () => {
      const i = this.evictListeners.indexOf(listener);
      if (i >= 0) this.evictListeners.splice(i, 1);
    };
  }

  /**
   * 强制踢除某项目的全部设备（项目销毁时用）
   *
   * 不走离线保留：项目已销毁，设备无家可归，断开连接并彻底移除。
   */
  evictDevicesOfProject(projectId: string): number {
    const targets: Device[] = [];
    for (const d of this.devices.values()) {
      if (d.info.projectId === projectId) targets.push(d);
    }
    for (const d of targets) {
      /** 断开所有活连接（close 回调里的清理是幂等的，不会重复 unregister 出问题） */
      for (const ws of d.sockets) ws.close();
      this.deleteDevice(d.info.id);
    }
    if (targets.length > 0) {
      for (const l of this.evictListeners) l();
    }
    return targets.length;
  }

  /** 注册监听器，返回取消注册函数 */
  onChange(listener: (event: DeviceListEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(event: DeviceListEvent) {
    for (const l of this.listeners) l(event);
  }

  /** 设备上线（含重连/多连接：同 id 复用缓冲区，只加连接，不丢历史数据）
   *
   * 返回 null = 检测到复制标签页冲突：deviceId 已被另一个页面（不同 sessionToken）
   * 持有，调用方应告知设备换 id 重新注册（Web Locks 不可用环境的 server 端仲裁）。
   */
  register(info: DeviceInfo, ws: DeviceConn, sessionToken = ""): Device | null {
    const existing = this.devices.get(info.id);
    if (existing && sessionToken) {
      /** 同 id 下已有不同 token 的活连接 → 复制标签页（sessionStorage 快照被复制）
       * 原页面继续用原 id；新页面将被要求换 id（首个连接未上报 token 的旧 SDK 除外） */
      for (const [sock, tok] of existing.sessionTokens) {
        if (tok && tok !== sessionToken && sock.readyState === sock.OPEN) {
          return null;
        }
      }
    }
    const result = this.registerInner(info, ws, sessionToken);
    if (result?.reconnected) {
      /** 页面 reload 重连：额外的 reconnect 事件让控制台重载 devtools 面板（backend 已随页面销毁重建） */
      this.emit({ type: "reconnect", device: result.device.info });
    }
    return result?.device ?? null;
  }

  /**
   * register 的内部实现
   *
   * 返回 { device, reconnected }：reconnected = 检测到页面 reload（同 id 新 sessionToken）。
   * 冲突时返回 null（与 register 对外行为一致）。
   */
  private registerInner(
    info: DeviceInfo,
    ws: DeviceConn,
    sessionToken = "",
  ): { device: Device; reconnected: boolean } | null {
    const existing = this.devices.get(info.id);
    /** 恢复在线：取消宽限期下线（reload 窗口内重连的核心路径） */
    const graceTimer = this.graceTimers.get(info.id);
    if (graceTimer) {
      clearTimeout(graceTimer);
      this.graceTimers.delete(info.id);
    }
    /** 同 id 且上报了 token，但所有旧连接的 token 都与新 token 不同 → 页面 reload
     *  （新页面加载必然生成新 sessionToken；旧 token 集合里没有任何匹配）。
     *  宽限期内旧连接还没断开时也成立：reload 后旧 socket 尚在 CLOSE_WAIT。
     *  多标签页（Web Locks 各持不同 id）不会误报——它们 id 各不相同。 */
    let reconnected = false;
    if (existing && sessionToken) {
      reconnected = Array.from(existing.sessionTokens.values()).every(
        (tok) => tok !== sessionToken,
      );
    }
    /** 从下线历史移除（不再算"最近下线"） */
    this.offlineHistory = this.offlineHistory.filter((o) => o.id !== info.id);
    if (!existing) {
      /** 首次上线（复制标签页换 id 重连到这里时 existing 为 undefined，是全新设备） */
      const device: Device = {
        info,
        sockets: new Set([ws]),
        latestSocket: ws,
        sessionTokens: sessionToken ? new Map([[ws, sessionToken]]) : new Map(),
        logs: new LogBuffer(),
        network: new NetworkBuffer(),
        errors: new ErrorBuffer(),
        pendingExecs: new Map(),
      };
      this.devices.set(info.id, device);
      this.emit({ type: "online", device: info });
      return { device, reconnected: false };
    }
    {
      /** 重连/新连接：保留 logs/network/errors 历史，只追加连接和更新元信息。
       *  tags/note 以 server 侧为准（可能被控制台/API 修改过），不被 SDK 上报覆盖。
       *  icon 同理：SDK register 时只带 URL，已有的 data URL icon 不被覆盖。
       *  仅当 SDK 上报了非空 tags/note 且 server 侧为空时才采纳（首次带标签接入） */
      const mergedTags = existing.info.tags.length > 0 ? existing.info.tags : (info.tags ?? []);
      const mergedNote = existing.info.note || info.note;
      /** icon：优先保留已有的 data URL（更可靠），否则用新上报的 */
      const mergedIcon = existing.info.icon?.startsWith("data:") ? existing.info.icon : info.icon;
      existing.sockets.add(ws);
      existing.latestSocket = ws;
      if (sessionToken) existing.sessionTokens.set(ws, sessionToken);
      existing.info = {
        ...info,
        icon: mergedIcon,
        onlineAt: existing.info.onlineAt,
        tags: mergedTags,
        note: mergedNote,
        /** 恢复在线：清掉离线标记（离线保留的设备重连回这条路径） */
        offlineAt: undefined,
      };
      this.emit({ type: "online", device: existing.info });
      return { device: existing, reconnected };
    }
  }

  /**
   * 摘除一条连接（reload / 标签页关闭）
   *
   * 还有其他活连接 → 设备仍在线（多标签页共享一台设备）。
   * 这是最后一条 → 不立即下线，进宽限期等 reload 重连；超时才真正 unregister。
   */
  detachSocket(deviceId: string, ws: DeviceConn): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.sockets.delete(ws);
    device.sessionTokens.delete(ws);
    if (device.sockets.size > 0) {
      /** 指令连接若恰好是摘除的这条，切到池里任意存活连接 */
      if (device.latestSocket === ws) {
        device.latestSocket = device.sockets.values().next().value as DeviceConn;
      }
      return;
    }
    /** 最后一条连接断开 → 宽限期后才真正下线 */
    const timer = setTimeout(() => {
      this.graceTimers.delete(deviceId);
      this.unregister(deviceId);
    }, OFFLINE_GRACE_MS);
    this.graceTimers.set(deviceId, timer);
    /**
     * pending exec 不等宽限期：连接全断时指令通道已死，
     * 挂起的 exec 应立即失败（AI 侧重试），而非傻等 5s 宽限 + 让调用方超时。
     * reload 场景 exec 也会失败——但 exec 语义本来就是"对当前页面快照操作"，reload 后上下文已变，失败更正确。
     */
    for (const [execId, entry] of device.pendingExecs) {
      clearTimeout(entry.timer);
      entry.resolve({
        success: false,
        error: "设备已断开连接",
      });
      device.pendingExecs.delete(execId);
    }
  }

  /**
   * 设备下线：标记 offlineAt 保留在注册表中
   *
   * 不再删除设备：logs/network/errors 历史缓冲保留，控制台设备列表保留该设备
   * 并标记离线，用户仍可查看离线前的缓存数据。设备重连时（registerInner）
   * 清掉 offlineAt 无缝恢复。项目销毁走 deleteDevice 硬删。
   */
  unregister(deviceId: string) {
    const graceTimer = this.graceTimers.get(deviceId);
    if (graceTimer) {
      clearTimeout(graceTimer);
      this.graceTimers.delete(deviceId);
    }
    const device = this.devices.get(deviceId);
    if (!device) return;
    /** 设备掉线时，reject 所有未完成的 exec + 清理超时定时器（防泄漏） */
    for (const [, entry] of device.pendingExecs) {
      clearTimeout(entry.timer);
      entry.resolve({
        success: false,
        error: "设备已断开连接",
      });
    }
    device.pendingExecs.clear();
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
    });
    if (this.offlineHistory.length > DeviceRegistry.MAX_OFFLINE_HISTORY) {
      this.offlineHistory.shift();
    }
    /** 连接池已空，清掉残留映射（防下次 register 前误用死连接） */
    device.sockets.clear();
    device.sessionTokens.clear();
    device.info.offlineAt = Date.now();
    this.emit({ type: "offline", deviceId });
  }

  /** 硬删设备（项目销毁等场景）：设备与全部缓冲数据一并移除 */
  deleteDevice(deviceId: string) {
    const graceTimer = this.graceTimers.get(deviceId);
    if (graceTimer) {
      clearTimeout(graceTimer);
      this.graceTimers.delete(deviceId);
    }
    const device = this.devices.get(deviceId);
    if (!device) return;
    for (const [, entry] of device.pendingExecs) {
      clearTimeout(entry.timer);
      entry.resolve({ success: false, error: "设备已断开连接" });
    }
    device.pendingExecs.clear();
    this.offlineHistory = this.offlineHistory.filter((o) => o.id !== deviceId);
    this.devices.delete(deviceId);
    /** 硬删后立即刷盘：落盘快照里不再包含该设备的日志（项目销毁语义 = 数据一并移除） */
    this.flushLogsNow();
    this.emit({ type: "offline", deviceId });
  }

  /** 获取单个设备 */
  get(deviceId: string): Device | undefined {
    return this.devices.get(deviceId);
  }

  /** 所有在线设备信息（用于 HTTP API /api/devices） */
  list(): DeviceInfo[] {
    return Array.from(this.devices.values()).map((d) => d.info);
  }

  /**
   * 按项目过滤的在线设备信息（鉴权模式下，控制台只能看自己项目的设备）
   *
   * @param projectId 项目 ID（undefined=超管，看全部）
   */
  listByProject(projectId?: string): DeviceInfo[] {
    return Array.from(this.devices.values())
      .filter((d) => projectId === undefined || d.info.projectId === projectId)
      .map((d) => d.info);
  }

  /**
   * 按项目过滤的最近下线设备摘要
   *
   * @param projectId 项目 ID（undefined=超管，看全部）
   */
  listOfflineByProject(projectId?: string): OfflineDeviceSummary[] {
    return this.offlineHistory.filter((o) => projectId === undefined || o.projectId === projectId);
  }

  /** 最近下线设备摘要（用于 AI 判断"接入过但掉了"） */
  listOffline(): OfflineDeviceSummary[] {
    return [...this.offlineHistory];
  }

  /**
   * 一键清理离线设备（硬删，含历史缓冲数据），在线设备不受影响
   *
   * @param projectId 项目 ID（undefined=全部项目；""=仅未分组设备）
   * @returns 删除的设备数
   */
  clearOfflineDevices(projectId?: string): number {
    const targets: Device[] = [];
    for (const d of this.devices.values()) {
      if (d.info.offlineAt === undefined) continue;
      if (projectId === undefined) {
        targets.push(d);
      } else if (projectId === "") {
        if (d.info.projectId === undefined) targets.push(d);
      } else if (d.info.projectId === projectId) {
        targets.push(d);
      }
    }
    for (const d of targets) this.deleteDevice(d.info.id);
    return targets.length;
  }

  /** 按 ID 查离线摘要（注册表里已查不到时兜底用，硬删鉴权场景） */
  getOffline(deviceId: string): OfflineDeviceSummary | undefined {
    return this.offlineHistory.find((o) => o.id === deviceId);
  }

  /** 更新设备元信息（页面导航、错误数变化时） */
  updateInfo(deviceId: string, patch: Partial<DeviceInfo>) {
    const device = this.devices.get(deviceId);
    if (!device) return;
    /** 过滤 undefined 值（SDK 分多条 update-info 上报不同字段，未带的字段不应覆盖已有值） */
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        (device.info as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
}

/** 设备上下线事件 */
export type DeviceListEvent =
  | { type: "online"; device: DeviceInfo }
  | { type: "offline"; deviceId: string }
  /** 页面 reload 重连（同 id 新 sessionToken）：devtools backend 已随页面销毁重建，控制台需重新握手 */
  | { type: "reconnect"; device: DeviceInfo };
