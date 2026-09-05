/**
 * 全局错误捕获 —— 捕获运行时错误和未处理的 Promise rejection
 *
 * 三类来源区分处理：
 * 1. window 'error' 事件（JS 运行时错误）—— 上报为 error，计入 errorCount
 * 2. 资源加载失败（img/script/css 404 等）—— 不计入 errorCount，避免
 *    一个 404 图片就让设备亮红条、误导 AI 诊断。降级记入 recentErrors 供快照附带
 * 3. window 'unhandledrejection' —— 上报为 error，计入 errorCount
 *
 * 若错误带 source/line/col，会异步尝试 source map 解析（2s 超时），
 * 解析成功则 entry.mapped 填充原始源码位置，再上报。
 * 解析失败/超时则立即上报原始 entry，绝不阻塞错误采集。
 *
 * 错误去重（防错误风暴）：循环错误（rAF/setInterval 里持续抛同一个错）
 * 会在瞬间产生海量相同错误打爆 WS/server。与 log 限流不同，错误本身都重要，
 * 所以策略是"相同错误连续重复时聚合"——只上报第一条，后续相同错误聚合计数，
 * 在错误停止重复（2s 无新错误）或出现不同错误时 flush 汇总。
 */

import type { ErrorEntry } from "@silkpulse/shared";
import { resolveOriginalPosition } from "./source-map-helper.js";

type ErrorSink = (entry: ErrorEntry) => void;

/** 全局错误计数（仅 JS 运行时错误 + Promise rejection，不含资源加载失败） */
let errorCount = 0;

/** 取当前错误总数（register 时上报，之后随 error 事件递增） */
export function getErrorCount(): number {
  return errorCount;
}

/**
 * 尝试解析 source map，有 2s 超时兜底
 * 解析成功返回带 mapped 的 entry，失败/超时返回原始 entry
 */
async function tryResolveMap(entry: ErrorEntry): Promise<ErrorEntry> {
  if (!entry.source || !entry.line || !entry.col) return entry;
  try {
    const mapped = await Promise.race([
      resolveOriginalPosition(entry.source, entry.line, entry.col),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);
    return mapped ? { ...entry, mapped } : entry;
  } catch {
    return entry;
  }
}

/**
 * 错误指纹（用于判断"同一错误"）
 *
 * message + source + line 三者相同即视为同一错误（col 精度过高，压缩代码同行不同列
 * 往往是同一语句，忽略）。资源加载失败不走去重（本就不计入 errorCount）。
 */
function errorFingerprint(entry: ErrorEntry): string {
  return `${entry.message}@${entry.source ?? ""}:${entry.line ?? 0}`;
}

/**
 * 重复错误聚合窗口（ms）
 *
 * 连续相同错误在此窗口内不再逐条上报，窗口结束（2s 无新错误）时 flush
 * 一条汇总。2s 足够覆盖 rAF（16ms）/setInterval 常见间隔，又不会让诊断者等太久。
 */
const DEDUP_WINDOW = 2000;

/**
 * 错误去重器 —— 包装 sink，对连续相同错误聚合后再转发
 *
 * 策略（兼顾实时性 + 防风暴）：
 * - 第一条错误立即上报（错误首现实时，诊断工具不能延迟首现）
 * - 连续相同错误：聚合计数，不立即上报，重置 2s 窗口
 * - 窗口结束（2s 无新错误）：若 repeatCount > 0，上报一条"重复 N 次"汇总
 * - 出现不同错误：立即 flush 上一条的重复汇总（若有），新错误立即上报
 *
 * 这样循环错误（rAF/setInterval 持续抛同一个错）首现秒到、后续被聚合，
 * 不同错误全量实时上报。errorCount 在 deduper 之前递增，始终反映真实总数。
 */
class ErrorDeduper {
  /** 实际上报回调 */
  private readonly sink: ErrorSink;
  /** 上一个已上报错误的指纹（用于判断"连续相同"） */
  private lastKey = "";
  /** 上一个已上报错误后，连续重复但尚未发汇总的次数 */
  private repeatCount = 0;
  /** 重复汇总 flush 定时器（跟踪以清理，防泄漏） */
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(sink: ErrorSink) {
    this.sink = sink;
  }

  /** 写入一条错误（去重聚合后转发给 sink） */
  push(entry: ErrorEntry): void {
    const key = errorFingerprint(entry);
    if (key === this.lastKey) {
      /** 连续相同错误：聚合，重置窗口等下一波 */
      this.repeatCount++;
      this.rescheduleFlush();
      return;
    }
    /** 不同错误：先 flush 上一条的重复汇总（若有），新错误立即上报 */
    this.flush();
    this.lastKey = key;
    this.sink(entry);
  }

  /** 重置 flush 定时器（每次相同错误到来都延期汇总） */
  private rescheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), DEDUP_WINDOW);
  }

  /** flush 重复汇总（若有），清空重复计数 */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.repeatCount > 0) {
      /** 发一条汇总（message 仅标注重复次数，AI 看到 errorCount 与 errors 条数不符时能理解） */
      this.sink({
        timestamp: new Date().toISOString(),
        message: `（上一条错误重复 ${this.repeatCount} 次）`,
      });
      this.repeatCount = 0;
    }
  }
}

/**
 * 判断 error 事件是否为资源加载失败（而非 JS 运行时错误）
 *
 * 资源加载失败（img/script/css 404 等）的特征：
 * - event.error 为 null（JS 错误时是 Error 实例）
 * - event.target 是元素（img/link/script），event.message 常为空或 "Error loading ..."
 *
 * 这类"错误"不应计入 errorCount（会误导诊断：一个 404 图片就让设备亮红条），
 * 但仍需记录，让 AI 知道有资源没加载到。
 */
function isResourceError(e: ErrorEvent): boolean {
  /** event.error 为 null 且 message 缺失 → 资源加载失败 */
  if (e.error == null && !e.message) return true;
  /** event.target 是资源元素（非 document/window） */
  const target = e.target;
  if (target && target instanceof Element) {
    const tag = target.tagName;
    if (
      tag === "IMG" ||
      tag === "LINK" ||
      tag === "SCRIPT" ||
      tag === "SOURCE" ||
      tag === "AUDIO" ||
      tag === "VIDEO"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 安装全局错误捕获
 *
 * 去重 + source map 解析的协作顺序：
 * 错误先入 deduper 去重（同步），deduper flush 时才触发 source map 解析（异步）。
 * 这样连续重复错误只解析一次 source map，不浪费 fetch，也不会异步乱序。
 */
export function installErrorCatcher(sink: ErrorSink): void {
  /** flush 时：有 source 位置则解析 source map，否则直接上报 */
  const deduper = new ErrorDeduper((entry) => {
    if (entry.source && entry.line && entry.col) {
      tryResolveMap(entry).then(sink);
    } else {
      sink(entry);
    }
  });

  window.addEventListener(
    "error",
    (e: ErrorEvent) => {
      /** 资源加载失败：降级处理，不计入 errorCount，不上报为 error（避免噪音） */
      if (isResourceError(e)) {
        const src = e.target as Element | null;
        const url =
          src instanceof Element
            ? src.getAttribute("src") || src.getAttribute("href") || src.tagName.toLowerCase()
            : "unknown";
        /** 资源失败只进 recentErrors（快照附带），不进 error 流，不污染 errorCount */
        pushResourceError?.(`资源加载失败: ${url}`);
        return;
      }

      errorCount++;
      const entry: ErrorEntry = {
        timestamp: new Date().toISOString(),
        message: e.message || "Unknown error",
        stack: e.error instanceof Error ? e.error.stack : undefined,
        source: e.filename,
        line: e.lineno,
        col: e.colno,
      };
      /** 入去重器：连续相同错误聚合计数，flush 时才解析 source map + 上报 */
      deduper.push(entry);
    },
    true,
  ); /** 使用捕获阶段：资源加载失败的 error 事件不冒泡，必须捕获阶段才能收到 */

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    errorCount++;
    const reason = e.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const entry: ErrorEntry = {
      timestamp: new Date().toISOString(),
      message: `Unhandled rejection: ${message}`,
      stack: reason instanceof Error ? reason.stack : undefined,
    };
    deduper.push(entry);
  });
}

/**
 * 资源加载失败回调（由 index 注入，转发给 snapshot 的 recentErrors）
 *
 * 默认空实现：只有 index 把 pushRecentError 注入进来才生效。
 * 这样 error-catcher 不直接依赖 snapshot，保持模块边界清晰。
 */
let pushResourceError: ((msg: string) => void) | null = null;

/** 注入资源错误转发回调（index 初始化时调用） */
export function setResourceErrorHandler(handler: (msg: string) => void): void {
  pushResourceError = handler;
}
