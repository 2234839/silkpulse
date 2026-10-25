/**
 * 旁路统计上报 —— silkpulse-stats 对接
 *
 * 设计约束：主链路零依赖。未配置 SILKPULSE_STATS_URL 时整个模块为 no-op；
 * 已配置时 fire-and-forget（批量队列 + AbortSignal.timeout），统计服务挂了只丢事件，
 * 绝不阻塞设备/控制台/exec 路径。
 */

/** 统计服务地址（如 http://stats:8300），未设置 = 上报关闭 */
const STATS_URL = process.env.SILKPULSE_STATS_URL;
/** 上报口令 */
const STATS_TOKEN = process.env.SILKPULSE_STATS_TOKEN;

const ENABLED = Boolean(STATS_URL && STATS_TOKEN);

/** 批量队列：攒批减少请求数（生命周期事件本身低频，5s/50条 足够） */
const queue: Array<{ type: string; service: string; ts: number; [k: string]: unknown }> = [];
let flushTimer: NodeJS.Timeout | undefined;

/** 队列非空时安排一次 flush（幂等） */
function scheduleFlush() {
  if (flushTimer || !ENABLED) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flush();
  }, 5000);
  flushTimer.unref();
}

/** 把队列 POST 给统计服务；任何失败静默丢弃（旁路语义） */
async function flush() {
  if (!ENABLED || queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  try {
    await fetch(`${STATS_URL}/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${STATS_TOKEN}`,
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /** 统计服务不可达：丢事件不重试（重试会在服务长时间宕机时积压内存） */
  }
}

/**
 * 上报一条事件（入队即返回，不等待网络）
 *
 * @param type 事件类型（device-online / device-offline / console-open / console-close / exec）
 * @param fields 事件字段
 */
export function reportEvent(type: string, fields: Record<string, unknown>) {
  if (!ENABLED) return;
  queue.push({ type, service: "silkpulse", ts: Date.now(), ...fields });
  scheduleFlush();
  if (queue.length >= 50) void flush();
}

/** 设备当前在线周期起点（进程内视角：deviceId → 首次 online 时刻） */
const deviceOnlineSince = new Map<string, number>();

/** 设备上线打点（同设备多连接/重连只在首次 online 时记起点） */
export function trackDeviceOnline(deviceId: string, projectId?: string) {
  if (!deviceOnlineSince.has(deviceId)) {
    deviceOnlineSince.set(deviceId, Date.now());
    reportEvent("device-online", { deviceId, projectId });
  }
}

/** 设备下线打点（附本次在线时长；设备不在跟踪表时跳过——server 重启前的会话无从计时） */
export function trackDeviceOffline(deviceId: string) {
  const since = deviceOnlineSince.get(deviceId);
  if (since === undefined) return;
  deviceOnlineSince.delete(deviceId);
  reportEvent("device-offline", { deviceId, durationMs: Date.now() - since });
}

/**
 * 控制台会话打点：用户身份由调用方传入（projectId = 项目密钥持有者，跨刷新/多标签页稳定）。
 * 返回结束会话时调用的函数。
 *
 * @param user 稳定用户标识（projectId 或 "admin"）
 */
export function trackConsoleSession(user: string): () => void {
  if (!ENABLED) return () => {};
  const clientId = `${user}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();
  reportEvent("console-open", { clientId, user });
  return () => {
    reportEvent("console-close", { clientId, user, durationMs: Date.now() - start });
  };
}

/**
 * exec 动作归类：从生成代码的特征识别语义动作，未知代码归为 eval
 *
 * @param code 下发给设备的 JS 代码
 */
function classifyExec(code: string): string {
  if (code.includes("__silkpulse_snapshot")) return "snapshot";
  if (code.includes("__silkpulse_ensureIdx")) return "element-tree";
  if (code.includes("clickElement") || code.includes("dispatchEvent")) return "interact";
  return "eval";
}

/** exec 打点（在 execOnDevice 漏斗处调用，t0=开始时刻） */
export function trackExec(deviceId: string, code: string, ok: boolean, t0: number) {
  reportEvent("exec", {
    deviceId,
    action: classifyExec(code),
    ok,
    ms: Date.now() - t0,
    codeLen: code.length,
  });
}
