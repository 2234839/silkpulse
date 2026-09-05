<script setup lang="ts">
/**
 * NetworkPanel —— 网络请求面板
 *
 * 展示远程设备的网络请求（HTTP + WebSocket），支持关键词搜索、状态筛选（全部/成功/失败）、
 * 耗时排序（定位慢请求）。点击单条请求展开详情（URL/方法/状态/耗时/请求头/响应头/请求体/响应体/WS 帧），
 * 支持复制为 cURL 命令在本地复现。
 *
 * 数据由 App.vue 通过 useConsoleSocket() 单源传入。
 */
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import type { NetworkEntry } from "@silkpulse/shared";
import { copyText } from "../utils/clipboard";
import { apiFetch } from "../utils/api";
import { useResizable } from "../composables/useResizable";
import ObjectInspector from "./ObjectInspector.vue";

/** 请求列表宽度可拖拽 */
const { width: listWidth, onDragStart: onListResize } = useResizable({
  initial: 400,
  min: 240,
  max: 700,
  direction: "right",
  storageKey: "silkpulse.network-list-width",
});

/**
 * 每秒刷新的 tick，驱动 SSE open 状态下耗时/大小的动态计算
 *
 * SSE 连接持续时间 = 当前时间 - 建连时间，需要持续刷新。
 * SSE 累积大小 = events 数据总和，随事件到达实时增长。
 */
const now = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  tickTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
});

/**
 * 格式化字节数为人类可读（B/KB/MB）
 *
 * 响应大小从几字节到几 MB 不等，统一格式化。
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 资源类型分类：根据 initiatorType (mimeType) 和 URL 后缀推断资源大类
 *
 * PerformanceObserver 的 initiatorType 值如 'link'/'script'/'img'/'css'，
 * 映射到用户可理解的分类标签和图标。
 */
type ResourceCategory = "css" | "js" | "img" | "font" | "media" | "other";

/**
 * 根据 initiatorType + URL 扩展名推断资源大类
 */
function getResourceCategory(n: NetworkEntry): ResourceCategory {
  const initType = n.mimeType ?? "";
  const url = n.url.toLowerCase();
  const ext = url.split("?")[0].split(".").pop() ?? "";

  if (initType === "css" || ext === "css") return "css";
  if (initType === "script" || ext === "js" || ext === "mjs") return "js";
  if (
    initType === "img" ||
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"].includes(ext)
  )
    return "img";
  if (["woff", "woff2", "ttf", "otf", "eot"].includes(ext)) return "font";
  if (["mp4", "webm", "mp3", "wav", "ogg"].includes(ext)) return "media";
  return "other";
}

/** 资源分类 → 图标映射 */
const RESOURCE_ICONS: Record<ResourceCategory, string> = {
  css: "🎨",
  js: "📜",
  img: "🖼️",
  font: "🔤",
  media: "🎬",
  other: "📦",
};

/** 资源分类 → 中文标签 */
const RESOURCE_LABELS: Record<ResourceCategory, string> = {
  css: "CSS",
  js: "JS",
  img: "Img",
  font: "Font",
  media: "Media",
  other: "Other",
};

/**
 * 获取网络条目的显示图标
 *
 * 资源类型用分类图标，SSE/WS 用协议标签，其余不显示。
 */
function getEntryIcon(n: NetworkEntry): string | null {
  if (n.kind === "resource") return RESOURCE_ICONS[getResourceCategory(n)];
  return null;
}

/**
 * 计算单条网络请求的响应大小（字节）
 *
 * - SSE：累积所有 events 的 data + event/id 字段开销
 * - 普通 HTTP：resBody 字节长度（base64 近似）
 * - resource：size 字段
 * - WS：无静态大小（显示 -）
 */
function calcResSize(n: NetworkEntry): number {
  if (n.sseState && n.events) {
    let total = 0;
    for (const ev of n.events) {
      if (ev.event && ev.event !== "__closed__") total += ev.event.length + 7; /* "event: \n" */
      if (ev.id) total += String(ev.id).length + 4; /* "id: \n" */
      if (ev.retry != null) total += String(ev.retry).length + 8; /* "retry: \n" */
      total += (ev.data?.length ?? 0) + 6; /* "data: \n\n" */
    }
    return total;
  }
  if (n.protocol === "ws") return 0;
  if (n.kind === "resource" && n.size) return n.size;
  if (n.resBody) return n.resBody.length;
  return 0;
}

/**
 * 计算单条网络请求的动态耗时（ms）
 *
 * - SSE open：当前时间 - 建连时间（持续增长直到关闭）
 * - SSE closed：最后一条事件时间 - 建连时间
 * - 其他：直接用 n.duration
 */
function calcDuration(n: NetworkEntry): number {
  if (n.sseState === "open" || (n.sseState === "closed" && n.events?.length)) {
    const start = new Date(n.timestamp).getTime();
    if (n.sseState === "open") {
      /** 依赖 now tick 驱动每秒刷新 */
      void now.value;
      return Math.max(0, Date.now() - start);
    }
    /** closed：最后一条事件时间 - start */
    const lastEv = n.events![n.events!.length - 1];
    if (lastEv) return Math.max(0, new Date(lastEv.timestamp).getTime() - start);
  }
  return n.duration;
}

const props = defineProps<{
  /** 远程设备网络请求列表 */
  network: NetworkEntry[];
  /** 当前选中设备 id（用于 exec 通道重新请求资源） */
  deviceId?: string;
  /** 懒加载完整 body（bodyTruncated=true 的 entry 按需拉取） */
  requestBody?: (deviceId: string, bodySeq: number) => Promise<string | null>;
}>();

/** 选中的请求 seq（点击展开详情，用 seq 追踪避免数组替换后引用丢失） */
const selectedSeq = ref<number | null>(null);

/** 从列表中按 seq 查找当前选中的条目 */
const selectedNetwork = computed(() => {
  if (selectedSeq.value === null) return null;
  return props.network.find((n) => n.seq === selectedSeq.value) ?? null;
});

/** cURL 复制状态（用于按钮反馈） */
const curlCopyState = ref<"idle" | "copied">("idle");

/** 格式化 headers 对象为 "k: v" 多行文本 */
function formatHeaders(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/**
 * 格式化请求体/响应体：JSON 则美化缩进，否则原样返回。
 *
 * 调试时点击网络请求看详情，压缩 JSON（如 {"code":0,"data":[...]）可读性极差。
 * 尝试 JSON.parse 成功则 2 空格缩进美化；非 JSON（FormData 文本、纯字符串）原样返回。
 * 这里设计上就需要 try-catch —— 输入"可能不是 JSON"是正常的，不是异常情况。
 */
function formatBody(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return body;
  }
}

/**
 * 判断响应体是否为 base64 图片（可预览）
 *
 * SDK 对 image/* 响应会用 FileReader.readAsDataURL 编码为 data URL，
 * resBodyEncoding='base64' 标识。
 */
function isImagePreview(n: NetworkEntry): boolean {
  return n.resBodyEncoding === "base64" && !!n.resBodyMime?.startsWith("image/");
}

/**
 * 判断响应体是否为二进制信息（只读类型+大小，无内容）
 *
 * 字体/wasm/大图片等用 resBodyEncoding='info' 标识。
 */
function isBinaryInfo(n: NetworkEntry): boolean {
  return n.resBodyEncoding === "info";
}

/**
 * 响应体展示模式：'preview'（智能预览）/ 'raw'（原始文本）
 *
 * 图片默认预览，可切到 raw 看完整 base64 字符串。
 */
const resBodyViewMode = ref<"preview" | "raw">("preview");

/** 响应体展示模式重置：切换请求时回到默认 preview */
watch(selectedSeq, () => {
  resBodyViewMode.value = "preview";
});

/** 懒加载状态 */
const bodyLoading = ref(false);
const fullBodyCache = ref<string | null>(null);

/** 懒加载完整 body（bodyTruncated=true 时使用） */
async function loadFullBody() {
  if (!props.deviceId || !selectedNetwork.value || !props.requestBody) return;
  bodyLoading.value = true;
  try {
    fullBodyCache.value = await props.requestBody(props.deviceId, selectedNetwork.value.seq);
  } finally {
    bodyLoading.value = false;
  }
}

/** 切换请求时重置懒加载缓存 */
watch(selectedSeq, () => {
  fullBodyCache.value = null;
  bodyLoading.value = false;
});

/**
 * ─── SSE/WS 流 Filter + Parser ───
 *
 * Filter：对事件/帧的 data 做关键词过滤（大小写不敏感）。
 * Parser：输入 JS 函数体代码，参数为 data 字符串，返回值替换原始 data 展示。
 *   例如 parser = "return JSON.parse(data).msg" 会只展示 JSON 里的 msg 字段。
 *   编译失败或运行时错误会展示在错误提示行，不影响 Filter 功能。
 */
const streamFilter = ref("");
const streamParser = ref("");
const streamParserError = ref("");
/** parser 展示开关（默认折叠，点击展开） */
const streamParserOpen = ref(false);

/**
 * Parser 历史记录：按域名存储，localStorage 持久化
 *
 * 用户编辑 parser 代码后（失焦或切换请求时），自动保存到当前请求域名的历史列表。
 * 下次同域名打开 parser 时，从历史下拉中可快速选择之前的代码。
 */
const STORAGE_KEY = "silkpulse:parser-history";
/** 当前域名的历史 parser 列表 */
const parserHistory = ref<string[]>([]);
/** 历史下拉是否展开 */
const parserHistoryOpen = ref(false);

/** 从 localStorage 读取所有域名的 parser 历史 */
function loadParserHistory(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

/** 根据当前选中请求的 URL 提取域名 */
const currentDomain = computed(() => {
  const url = selectedNetwork.value?.url ?? "";
  try {
    return new URL(url, location.href).hostname;
  } catch {
    return "";
  }
});

/** 切换域名时加载对应历史 */
watch(
  currentDomain,
  (domain) => {
    if (!domain) {
      parserHistory.value = [];
      return;
    }
    const all = loadParserHistory();
    parserHistory.value = all[domain] ?? [];
  },
  { immediate: true },
);

/** 保存当前 parser 代码到域名历史（去重，最新放最前，上限 10 条） */
function saveParserToHistory() {
  const code = streamParser.value.trim();
  if (!code) return;
  const domain = currentDomain.value;
  if (!domain) return;
  const all = loadParserHistory();
  const list = all[domain] ?? [];
  /** 去重：移除已有的相同代码 */
  const filtered = list.filter((c) => c !== code);
  filtered.unshift(code);
  /** 上限 10 条 */
  all[domain] = filtered.slice(0, 10);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  parserHistory.value = all[domain];
}

/**
 * 已编译的 parser 函数（由 runParser 编译）
 */
let compiledParser: ((data: string) => unknown) | null = null;

/**
 * 执行 parser：编译代码 + 保存到历史
 *
 * 用户点击 ▶ 执行 按钮时调用。编译成功则保存到当前域名历史，
 * 编译失败则在编辑区显示错误（历史不保存）。
 */
function runParser() {
  const code = streamParser.value.trim();
  if (!code) {
    compiledParser = null;
    streamParserError.value = "";
    return;
  }
  try {
    compiledParser = new Function("data", code) as (data: string) => unknown;
    streamParserError.value = "";
    /** 编译成功才保存历史 */
    saveParserToHistory();
  } catch (e) {
    compiledParser = null;
    streamParserError.value = e instanceof Error ? e.message : String(e);
  }
}

/** 切换请求时清空状态 */
watch(selectedSeq, () => {
  streamParserError.value = "";
});

/** 从历史中选择一条代码 */
function selectParserHistory(code: string) {
  streamParser.value = code;
  parserHistoryOpen.value = false;
}

/** 删除一条历史 */
function deleteParserHistory(code: string) {
  const domain = currentDomain.value;
  if (!domain) return;
  const all = loadParserHistory();
  all[domain] = (all[domain] ?? []).filter((c) => c !== code);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  parserHistory.value = all[domain] ?? [];
}

/**
 * 对单条 data 执行 parser，返回展示文本
 *
 * 运行时错误不中断流展示，逐条捕获后在当前条目标注错误。
 */
function applyParser(data: string): { ok: true; result: string } | { ok: false; error: string } {
  if (!compiledParser) return { ok: true, result: data };
  try {
    const result = compiledParser(data);
    return {
      ok: true,
      result: typeof result === "string" ? result : JSON.stringify(result, null, 2),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 处理后的 SSE 事件列表（filter + parser）
 *
 * 过滤 __closed__ 事件，然后对 data 做 filter 关键词匹配 + parser 变换。
 */
const processedSseEvents = computed(() => {
  void now.value;
  const events = selectedNetwork.value?.events ?? [];
  const q = streamFilter.value.trim().toLowerCase();
  const result: Array<{
    timestamp: string;
    event: string;
    id?: string;
    retry?: number;
    display: string;
    parseError?: string;
  }> = [];
  for (const e of events) {
    if (e.event === "__closed__") continue;
    if (q && !e.data.toLowerCase().includes(q) && !e.event.toLowerCase().includes(q)) continue;
    const parsed = applyParser(e.data);
    result.push({
      timestamp: e.timestamp,
      event: e.event,
      id: e.id,
      retry: e.retry,
      display: parsed.ok ? parsed.result : e.data,
      parseError: parsed.ok ? undefined : parsed.error,
    });
  }
  return result;
});

/**
 * 处理后的 WS 帧列表（filter + parser）
 *
 * 连接事件帧（dir=event）不受 filter/parser 影响，始终展示。
 */
const processedWsFrames = computed(() => {
  void now.value;
  const frames = selectedNetwork.value?.frames ?? [];
  const q = streamFilter.value.trim().toLowerCase();
  const result: Array<{
    timestamp: string;
    dir: string;
    display: string;
    isEvent: boolean;
    parseError?: string;
  }> = [];
  for (const f of frames) {
    /** 连接事件帧（close/error）始终展示 */
    if (f.dir === "event") {
      result.push({ timestamp: f.timestamp, dir: f.dir, display: f.data, isEvent: true });
      continue;
    }
    if (q && !f.data.toLowerCase().includes(q)) continue;
    const parsed = applyParser(f.data);
    result.push({
      timestamp: f.timestamp,
      dir: f.dir,
      display: parsed.ok ? parsed.result : f.data,
      isEvent: false,
      parseError: parsed.ok ? undefined : parsed.error,
    });
  }
  return result;
});

/**
 * 清空阈值：只展示此时间戳之后的网络请求。
 * 与 Console 面板清空语义一致——前端视图层隐藏，不影响 server 缓冲。
 */
const clearedBeforeTs = ref(0);

/** 清空当前网络面板视图 */
function clearNetwork() {
  clearedBeforeTs.value = Date.now();
  selectedSeq.value = null;
}

/**
 * 把 NetworkEntry 转成 cURL 命令
 *
 * 让 AI/开发者能直接在本地复现远程设备的请求。
 * 单引号转义：shell 单引号内用 '\'' 闭合再开。
 */
function toCurl(n: NetworkEntry): string {
  const parts: string[] = [`curl -X ${n.method}`];
  if (n.reqHeaders) {
    for (const [k, v] of Object.entries(n.reqHeaders)) {
      const esc = v.replaceAll("'", "'\"'\"'");
      parts.push(`-H '${k}: ${esc}'`);
    }
  }
  if (n.reqBody) {
    const esc = n.reqBody.replaceAll("'", "'\"'\"'");
    parts.push(`--data '${esc}'`);
  }
  const urlEsc = n.url.replaceAll("'", "'\"'\"'");
  parts.push(`'${urlEsc}'`);
  return parts.join(" \\\n  ");
}

/** 复制选中请求的 cURL 命令到剪贴板 */
async function copyCurl() {
  if (!selectedNetwork.value) return;
  const cmd = toCurl(selectedNetwork.value);
  await copyText(cmd);
  curlCopyState.value = "copied";
  setTimeout(() => {
    curlCopyState.value = "idle";
  }, 1500);
}

/** 关键词搜索（按 URL / 方法 / 状态码） */
const networkSearch = ref("");
/**
 * 状态筛选：all 全部 / success 成功（2xx-3xx）/ error 失败（4xx-5xx 或未完成 status=0）
 *
 * 调试网络问题时最常用的维度 —— 失败请求和成功请求混在一起时，
 * 用户需要快速过滤出"哪些请求挂了"。status=0（请求未完成/网络中断）归入失败。
 */
const networkStatusFilter = ref<"all" | "success" | "error">("all");
/**
 * 类型筛选：all 全部 / fetch / xhr / ws / resource
 *
 * 诊断时需要区分"API 请求"和"静态资源加载"——页面白屏查 resource，接口报错查 fetch/xhr。
 */
const networkKindFilter = ref<"all" | "fetch" | "xhr" | "ws" | "resource">("all");
/**
 * 耗时排序：time（默认时间正序）/ desc（耗时降序，慢请求在最上）/ asc（耗时升序）
 *
 * 诊断"页面慢/卡"时，失败请求往往不是根因——真正的瓶颈是那些 status 200
 * 但耗时 2-3s 的慢请求。点"耗时"表头切到降序即可一眼定位，与 inspect CLI 的慢请求 Top 对齐。
 */
const networkDurationSort = ref<"time" | "desc" | "asc">("time");
/** 慢请求阈值（ms），与 skill CLI inspect 的 SLOW_THRESHOLD 保持一致 */
const SLOW_THRESHOLD = 500;
function toggleDurationSort() {
  if (networkDurationSort.value === "time") networkDurationSort.value = "desc";
  else if (networkDurationSort.value === "desc") networkDurationSort.value = "asc";
  else networkDurationSort.value = "time";
}
const filteredNetwork = computed(() => {
  let result = props.network;
  /** 清空阈值：隐藏"清空"之前的请求 */
  if (clearedBeforeTs.value > 0) {
    result = result.filter((n) => new Date(n.timestamp).getTime() >= clearedBeforeTs.value);
  }
  /** 类型筛选 */
  if (networkKindFilter.value !== "all") {
    result = result.filter((n) => n.kind === networkKindFilter.value);
  }
  if (networkStatusFilter.value === "success") {
    result = result.filter((n) => n.status >= 200 && n.status < 400);
  } else if (networkStatusFilter.value === "error") {
    /** status=0 表示请求未完成（网络中断/CORS 失败），诊断时视为失败 */
    result = result.filter((n) => n.status === 0 || n.status >= 400);
  }
  const q = networkSearch.value.trim().toLowerCase();
  if (q) {
    result = result.filter(
      (n) =>
        n.url.toLowerCase().includes(q) ||
        n.method.toLowerCase().includes(q) ||
        String(n.status).includes(q),
    );
  }
  /** 耗时排序：默认 time 不排（保持时间正序），desc/asc 按 duration 排 */
  if (networkDurationSort.value === "desc") {
    result = [...result].sort((a, b) => b.duration - a.duration);
  } else if (networkDurationSort.value === "asc") {
    result = [...result].sort((a, b) => a.duration - b.duration);
  }
  return result;
});

/**
 * ─── 重新请求（仅 resource 类型）───
 *
 * PerformanceObserver 只能拿到资源加载的时序和大小，拿不到请求/响应头和响应体。
 * 但 SDK 运行在页面上下文，可以用 fetch(url) 重新请求该资源，
 * 通过 exec 通道在设备上执行，拿到完整的头和体。
 */

/** 重新请求的完整结果 */
interface RefetchResult {
  /** HTTP 状态码 */
  status: number;
  /** 响应头 */
  headers: Record<string, string>;
  /** 响应体（文本或 base64） */
  body: string;
  /** 响应体 MIME 类型 */
  mime: string;
  /** 响应体编码：text | base64 */
  encoding: "text" | "base64";
}

/** 重新请求状态 */
const refetchLoading = ref(false);
/** 重新请求结果（点击后填充，切换请求时清空） */
const refetchResult = ref<RefetchResult | null>(null);
/** 重新请求错误 */
const refetchError = ref("");

/** 切换请求时清空重新请求结果 */
watch(selectedSeq, () => {
  refetchResult.value = null;
  refetchError.value = "";
});

/**
 * 通过 exec 通道在远程设备上重新 fetch 资源 URL
 *
 * 生成一段 JS 代码：fetch(url) → 读状态/头 → 按 content-type 决定 text/base64 → return JSON。
 * 图片/字体等二进制走 base64，JSON/text 走文本读取。
 */
async function refetchResource() {
  const n = selectedNetwork.value;
  if (!n || !props.deviceId || refetchLoading.value) return;

  refetchLoading.value = true;
  refetchError.value = "";
  refetchResult.value = null;

  try {
    /** 用 JSON.stringify(url) 安全转义 URL，防注入 */
    const code = `const url = ${JSON.stringify(n.url)}
    try {
      const res = await fetch(url, { credentials: 'include' })
      const headers = {}
      res.headers.forEach((v, k) => { headers[k] = v })
      const ct = (headers['content-type'] || '').toLowerCase()
      let body = ''
      let encoding = 'text'
      /** 图片/字体/音频等二进制 → base64 */
      if (ct.startsWith('image/') || ct.startsWith('font/') || ct.startsWith('audio/') || ct.startsWith('video/') || ct.startsWith('application/octet-stream')) {
        const blob = await res.blob()
        if (blob.size < 512 * 1024) {
          body = await new Promise(resolve => {
            const r = new FileReader()
            r.onloadend = () => resolve(r.result)
            r.readAsDataURL(blob)
          })
          encoding = 'base64'
        } else {
          body = '[Binary ' + (blob.type || 'unknown') + ' ' + blob.size + ' bytes — 超过 512KB 限制]'
        }
      } else {
        /** 文本类（含 JSON/HTML/CSS/JS）→ 纯文本完整读取（exec 通道支持 500KB） */
        body = await res.text()
      }
      return JSON.stringify({ status: res.status, headers, body, mime: ct, encoding })
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
    }`;

    const res = await apiFetch(`/api/devices/${props.deviceId}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();

    if (!data.success) {
      refetchError.value = data.error || "exec 执行失败";
    } else {
      /**
       * exec result 经过 serializeResult(JSON.stringify) 双重序列化：
       * 内层 JSON.stringify({"status":200,...}) → '{"status":200,...}'
       * 外层 serializeResult 把字符串再 stringify → '"{\\"status\\":200,...}"'
       * 所以前端需要 parse 两次：第一次得到内层 JSON 字符串，第二次得到对象
       */
      const raw = data.result ?? "";
      if (!raw || raw === "undefined") {
        refetchError.value = "exec 返回空结果";
      } else {
        try {
          const innerJson = JSON.parse(raw);
          const parsed = JSON.parse(innerJson);
          if (parsed.error) {
            refetchError.value = parsed.error;
          } else {
            refetchResult.value = {
              status: parsed.status,
              headers: parsed.headers,
              body: parsed.body,
              mime: parsed.mime,
              encoding: parsed.encoding,
            };
          }
        } catch {
          refetchError.value = `结果解析失败: ${raw.slice(0, 200)}`;
        }
      }
    }
  } catch (e) {
    refetchError.value = e instanceof Error ? e.message : String(e);
  } finally {
    refetchLoading.value = false;
  }
}

/** 重新请求结果是否为可预览图片 */
function isRefetchImage(r: RefetchResult): boolean {
  return r.encoding === "base64" && r.mime.startsWith("image/");
}

/** 格式化重新请求的响应头 */
function formatRefetchHeaders(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
</script>

<template>
  <div class="flex-1 flex overflow-hidden bg-base">
    <!-- 请求列表 -->
    <div
      class="flex flex-col border-r border-base flex-shrink-0"
      :style="{ width: listWidth + 'px' }"
    >
      <!-- 搜索 + 状态筛选栏 -->
      <div class="p-2 border-b border-light bg-surface space-y-2">
        <input
          v-model="networkSearch"
          placeholder="搜索请求（URL / 方法 / 状态码）"
          class="w-full text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
        />
        <!-- 类型筛选：全部 / Fetch / XHR / WS / 资源 -->
        <div class="flex items-center gap-1">
          <button
            v-for="kf in ['all', 'fetch', 'xhr', 'ws', 'resource'] as const"
            :key="kf"
            @click="networkKindFilter = kf"
            class="px-2 py-0.5 text-xs rounded font-medium"
            :class="
              networkKindFilter === kf
                ? 'bg-blue-500 text-white'
                : 'bg-elevated text-secondary bg-elevated-hover'
            "
          >
            {{
              kf === "all"
                ? "全部"
                : kf === "resource"
                  ? "资源"
                  : kf === "ws"
                    ? "WS"
                    : kf.toUpperCase()
            }}
          </button>
        </div>
        <!-- 状态筛选：全部 / 成功 / 失败 -->
        <div class="flex items-center gap-1">
          <button
            v-for="sf in ['all', 'success', 'error'] as const"
            :key="sf"
            @click="networkStatusFilter = sf"
            class="px-2 py-0.5 text-xs rounded font-medium"
            :class="
              networkStatusFilter === sf
                ? sf === 'error'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-800 text-white'
                : 'bg-elevated text-secondary bg-elevated-hover'
            "
          >
            {{ sf === "all" ? "全部" : sf === "success" ? "成功" : "失败" }}
          </button>
          <button
            @click="clearNetwork"
            class="ml-auto px-2 py-0.5 text-xs rounded bg-elevated text-secondary bg-elevated-hover"
            title="清空当前视图（不影响服务端缓冲）"
          >
            🚫 清空
          </button>
          <span class="text-xs text-faint"
            >{{ filteredNetwork.length }}/{{ props.network.length }}</span
          >
        </div>
      </div>
      <div class="flex-1 overflow-y-auto">
        <table class="w-full text-sm">
          <thead class="bg-elevated text-secondary text-xs uppercase sticky top-0">
            <tr>
              <th class="text-left px-3 py-2">时间</th>
              <th class="text-left px-3 py-2">方法</th>
              <th class="text-left px-3 py-2">状态</th>
              <th class="text-left px-3 py-2">URL</th>
              <th class="text-right px-3 py-2">大小</th>
              <th class="text-right px-3 py-2">
                <button
                  @click="toggleDurationSort"
                  class="inline-flex items-center gap-0.5 hover:text-primary transition-colors"
                  :class="networkDurationSort !== 'time' ? 'text-primary' : ''"
                  :title="
                    networkDurationSort === 'time'
                      ? '点击按耗时降序'
                      : networkDurationSort === 'desc'
                        ? '当前：耗时降序（慢请求在上）'
                        : '当前：耗时升序'
                  "
                >
                  耗时<span class="text-[10px]">{{
                    networkDurationSort === "desc" ? "▼" : networkDurationSort === "asc" ? "▲" : "↕"
                  }}</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(n, i) in filteredNetwork"
              :key="i"
              @click="selectedSeq = n.seq"
              class="border-b border-light cursor-pointer hover:bg-blue-soft"
              :class="selectedSeq === n.seq ? 'bg-blue-soft' : ''"
            >
              <td class="px-3 py-2 text-faint text-xs font-mono whitespace-nowrap">
                {{ new Date(n.timestamp).toLocaleTimeString() }}
              </td>
              <td class="px-3 py-2 text-secondary font-mono text-xs">{{ n.method }}</td>
              <td
                class="px-3 py-2 font-mono text-xs"
                :class="
                  n.status >= 400
                    ? 'text-red-500'
                    : n.status >= 200
                      ? 'text-green-600'
                      : 'text-faint'
                "
              >
                <template v-if="n.kind === 'resource' && n.status === 0">—</template>
                <template v-else>{{ n.status || "…" }}</template>
              </td>
              <td class="px-3 py-2 text-primary truncate max-w-[160px] text-xs">
                <span
                  v-if="n.sseState"
                  class="inline-block px-1 mr-1 text-[10px] rounded bg-purple-key/20 text-purple-key align-middle"
                  >SSE</span
                >
                <span
                  v-if="n.protocol === 'ws'"
                  class="inline-block px-1 mr-1 text-[10px] rounded bg-blue-key/20 text-blue-key align-middle"
                  >WS</span
                >
                <span
                  v-if="n.kind === 'resource'"
                  class="inline-block px-1 mr-1 text-[10px] rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 align-middle"
                  >{{ RESOURCE_LABELS[getResourceCategory(n)] }}</span
                >
                <span v-if="getEntryIcon(n)" class="mr-0.5">{{ getEntryIcon(n) }}</span>
                {{ n.url.split("/").pop() || n.url }}
              </td>
              <td class="px-3 py-2 text-right text-xs font-mono text-muted whitespace-nowrap">
                {{ n.protocol === "ws" ? "—" : formatSize(calcResSize(n)) }}
              </td>
              <td
                class="px-3 py-2 text-right text-xs font-mono"
                :class="
                  calcDuration(n) > SLOW_THRESHOLD ? 'text-amber-500 font-semibold' : 'text-muted'
                "
                :title="calcDuration(n) > SLOW_THRESHOLD ? `慢请求（> ${SLOW_THRESHOLD}ms）` : ''"
              >
                {{ calcDuration(n) }}ms
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="filteredNetwork.length === 0" class="text-faint text-center py-8 text-sm">
          {{ props.network.length === 0 ? "暂无网络请求" : "无匹配请求" }}
        </div>
      </div>
    </div>

    <!-- 拖拽手柄 -->
    <div
      class="w-1 cursor-col-resize bg-base hover:bg-blue-400/40 active:bg-blue-500 transition-colors flex-shrink-0"
      @mousedown="onListResize"
    />

    <!-- 详情面板 -->
    <div class="flex-1 overflow-y-auto p-4">
      <template v-if="selectedNetwork">
        <div class="space-y-4">
          <!-- 工具栏：复制为 cURL -->
          <div class="flex justify-end">
            <button
              @click="copyCurl"
              class="px-3 py-1.5 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary transition-colors"
            >
              {{ curlCopyState === "copied" ? "✓ 已复制" : "复制为 cURL" }}
            </button>
          </div>
          <!-- 基本信息 -->
          <div>
            <div class="text-xs text-faint mb-1">URL</div>
            <div
              class="text-sm font-mono text-primary break-all bg-surface p-2 rounded border border-base"
            >
              {{ selectedNetwork.url }}
            </div>
          </div>
          <div class="flex gap-6 text-sm flex-wrap">
            <div>
              <span class="text-faint">时间：</span
              ><span class="font-mono text-primary">{{
                new Date(selectedNetwork.timestamp).toLocaleString()
              }}</span>
            </div>
            <div>
              <span class="text-faint">方法：</span
              ><span class="font-mono text-primary">{{ selectedNetwork.method }}</span>
            </div>
            <div>
              <span class="text-faint">状态：</span>
              <span
                v-if="selectedNetwork.kind === 'resource' && selectedNetwork.status === 0"
                class="font-mono text-faint"
                >未知</span
              >
              <span
                v-else
                class="font-mono"
                :class="selectedNetwork.status >= 400 ? 'text-red-500' : 'text-green-600'"
                >{{ selectedNetwork.status || "—" }}</span
              >
            </div>
            <div>
              <span class="text-faint">大小：</span>
              <span class="font-mono text-primary">{{
                selectedNetwork.protocol === "ws" ? "—" : formatSize(calcResSize(selectedNetwork))
              }}</span>
            </div>
            <div>
              <span class="text-faint">耗时：</span
              ><span class="font-mono text-primary">{{ calcDuration(selectedNetwork) }}ms</span>
            </div>
            <div v-if="selectedNetwork.kind === 'resource'">
              <span class="text-faint">类型：</span>
              <span class="font-mono text-primary"
                >{{ getEntryIcon(selectedNetwork) }}
                {{ RESOURCE_LABELS[getResourceCategory(selectedNetwork)] }}</span
              >
            </div>
          </div>

          <!-- 资源类型说明 + 重新请求（仅 resource 类型） -->
          <div v-if="selectedNetwork.kind === 'resource'" class="space-y-3">
            <div
              class="bg-amber-50 border border-amber-200 dark:bg-amber-900/10 dark:border-amber-800 rounded p-3"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="text-xs text-amber-700 dark:text-amber-400 flex-1">
                  <span class="font-semibold">📦 静态资源加载</span>
                  <p class="mt-1 text-amber-600 dark:text-amber-500">
                    SilkPulse 无法直接采集静态资源请求的请求头和响应体。点击右侧按钮可让设备重新
                    fetch 该 URL，获取完整的响应头和响应体。
                  </p>
                </div>
                <button
                  v-if="deviceId"
                  @click="refetchResource"
                  :disabled="refetchLoading"
                  class="shrink-0 px-3 py-1.5 text-xs rounded border border-blue-400 bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {{ refetchLoading ? "请求中..." : "🔄 重新请求" }}
                </button>
              </div>
            </div>

            <!-- 重新请求错误 -->
            <div v-if="refetchError" class="bg-red-soft border border-red-soft rounded p-3">
              <div class="text-xs text-red-400 mb-1">重新请求失败</div>
              <div class="text-sm text-red-key font-mono break-all">{{ refetchError }}</div>
            </div>

            <!-- 重新请求结果 -->
            <template v-if="refetchResult">
              <!-- 响应头 -->
              <div>
                <div class="text-xs text-faint mb-1">响应头（重新请求）</div>
                <pre
                  class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all"
                  >{{ formatRefetchHeaders(refetchResult.headers) }}</pre>
              </div>
              <!-- 响应体 -->
              <div>
                <div class="flex items-center justify-between mb-1">
                  <div class="text-xs text-faint">响应体（重新请求）</div>
                  <span class="text-xs text-faint font-mono"
                    >{{ refetchResult.status }} · {{ refetchResult.mime }}</span
                  >
                </div>
                <div class="bg-surface p-3 rounded border border-base">
                  <!-- 图片预览 -->
                  <template v-if="isRefetchImage(refetchResult)">
                    <img
                      :src="refetchResult.body"
                      alt="资源预览"
                      class="max-w-full rounded border border-light"
                      style="max-height: 300px"
                    />
                  </template>
                  <!-- 文本/JSON/CSS/JS：pre + 滚动，完整不截断 -->
                  <template v-else>
                    <pre
                      class="text-xs font-mono text-primary whitespace-pre-wrap break-all max-h-96 overflow-y-auto"
                      >{{ refetchResult.body }}</pre>
                  </template>
                </div>
              </div>
            </template>
          </div>

          <!-- 错误 -->
          <div v-if="selectedNetwork.error" class="bg-red-soft border border-red-soft rounded p-3">
            <div class="text-xs text-red-400 mb-1">错误</div>
            <div class="text-sm text-red-key font-mono">{{ selectedNetwork.error }}</div>
          </div>

          <!-- WebSocket 帧时间线（仅 WS 连接条目，对齐 DevTools 的 Messages 面板） -->
          <div v-if="selectedNetwork.protocol === 'ws'">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs text-faint">帧时间线</span>
              <span class="text-xs text-faint"
                >({{ processedWsFrames.length }} /
                {{ selectedNetwork.frames?.length ?? 0 }} 帧)</span
              >
            </div>
            <!-- Filter + Parser 工具栏 -->
            <div class="flex items-center gap-1 mb-2 flex-wrap">
              <input
                v-model="streamFilter"
                placeholder="🔍 过滤帧内容..."
                class="flex-1 min-w-[120px] text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
              />
              <button
                @click="streamParserOpen = !streamParserOpen"
                class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
                :class="streamParserOpen || streamParser ? 'text-blue-key border-blue-400' : ''"
              >
                ⚡ Parser
              </button>
            </div>
            <!-- Parser 代码编辑区 -->
            <div v-if="streamParserOpen" class="mb-2">
              <div class="flex gap-1">
                <textarea
                  v-model="streamParser"
                  rows="2"
                  placeholder="// 输入 JS 函数体，参数 data 是帧内容字符串&#10;// 例: return JSON.parse(data).msg"
                  class="flex-1 text-xs font-mono px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400 resize-y"
                  spellcheck="false"
                ></textarea>
                <button
                  @click="
                    streamParser = 'try { return JSON.parse(data).msg } catch { return data }'
                  "
                  class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
                >
                  📋 模板
                </button>
                <button
                  v-if="parserHistory.length"
                  @click="parserHistoryOpen = !parserHistoryOpen"
                  class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
                  :class="parserHistoryOpen ? 'text-blue-key border-blue-400' : ''"
                >
                  📚 历史
                </button>
                <button
                  @click="runParser"
                  class="px-2 py-1 text-xs rounded border border-blue-400 bg-blue-500 hover:bg-blue-600 text-white whitespace-nowrap"
                >
                  ▶ 执行
                </button>
              </div>
              <!-- 历史下拉列表 -->
              <div
                v-if="parserHistoryOpen && parserHistory.length"
                class="mt-1 border border-base rounded divide-y divide-base"
              >
                <div
                  v-for="(code, hi) in parserHistory"
                  :key="hi"
                  class="flex items-center gap-1 px-2 py-1 hover:bg-elevated cursor-pointer group"
                  @click="
                    selectParserHistory(code);
                    runParser();
                  "
                >
                  <code class="flex-1 text-xs font-mono text-secondary truncate">{{ code }}</code>
                  <button
                    class="text-xs text-red-400 opacity-0 group-hover:opacity-100 shrink-0"
                    @click.stop="deleteParserHistory(code)"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div v-if="streamParserError" class="text-xs text-red-500 mt-0.5">
                ⚠ {{ streamParserError }}
              </div>
            </div>
            <div
              class="bg-surface border border-base rounded p-2 space-y-0.5 max-h-80 overflow-y-auto"
            >
              <div
                v-for="(f, fi) in processedWsFrames"
                :key="fi"
                class="text-xs font-mono flex gap-2"
              >
                <span class="text-faint shrink-0">{{
                  new Date(f.timestamp).toLocaleTimeString()
                }}</span>
                <span
                  class="shrink-0"
                  :class="
                    f.dir === 'send'
                      ? 'text-blue-key'
                      : f.dir === 'recv'
                        ? 'text-green-600'
                        : 'text-red-500'
                  "
                  >{{
                    f.dir === "send" ? "↑ send" : f.dir === "recv" ? "↓ recv" : "⚠ " + f.display
                  }}</span
                >
                <span v-if="!f.isEvent" class="text-primary break-all whitespace-pre-wrap">{{
                  f.display
                }}</span>
                <span v-if="f.parseError" class="text-red-500 text-[10px]"
                  >⚠ {{ f.parseError }}</span
                >
              </div>
              <div
                v-if="!selectedNetwork.frames?.length"
                class="text-faint text-center py-4 text-xs"
              >
                暂无帧（连接已建立，等待收发消息）
              </div>
              <div
                v-else-if="!processedWsFrames.length"
                class="text-faint text-center py-4 text-xs"
              >
                无匹配帧
              </div>
            </div>
          </div>

          <!-- SSE 事件时间线（仅 SSE 连接条目，对齐 DevTools 的 EventStream 面板） -->
          <div v-if="selectedNetwork.sseState">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs text-faint">SSE 事件流</span>
              <span
                class="text-xs"
                :class="selectedNetwork.sseState === 'open' ? 'text-green-600' : 'text-faint'"
              >
                {{ selectedNetwork.sseState === "open" ? "● 连接中" : "○ 已关闭" }}
              </span>
              <span class="text-xs text-faint"
                >({{ processedSseEvents.length }} /
                {{ selectedNetwork.events?.filter((e) => e.event !== "__closed__").length ?? 0 }}
                事件)</span
              >
            </div>
            <!-- Filter + Parser 工具栏 -->
            <div class="flex items-center gap-1 mb-2 flex-wrap">
              <input
                v-model="streamFilter"
                placeholder="🔍 过滤事件内容/类型..."
                class="flex-1 min-w-[120px] text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
              />
              <button
                @click="streamParserOpen = !streamParserOpen"
                class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
                :class="streamParserOpen || streamParser ? 'text-blue-key border-blue-400' : ''"
              >
                ⚡ Parser
              </button>
            </div>
            <!-- Parser 代码编辑区 -->
            <div v-if="streamParserOpen" class="mb-2">
              <div class="flex gap-1">
                <textarea
                  v-model="streamParser"
                  rows="2"
                  placeholder="// 输入 JS 函数体，参数 data 是事件 data 字符串&#10;// 例: return JSON.parse(data).msg"
                  class="flex-1 text-xs font-mono px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400 resize-y"
                  spellcheck="false"
                ></textarea>
                <button
                  @click="
                    streamParser = 'try { return JSON.parse(data).msg } catch { return data }'
                  "
                  class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
                >
                  📋 模板
                </button>
                <button
                  v-if="parserHistory.length"
                  @click="parserHistoryOpen = !parserHistoryOpen"
                  class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary whitespace-nowrap"
                  :class="parserHistoryOpen ? 'text-blue-key border-blue-400' : ''"
                >
                  📚 历史
                </button>
                <button
                  @click="runParser"
                  class="px-2 py-1 text-xs rounded border border-blue-400 bg-blue-500 hover:bg-blue-600 text-white whitespace-nowrap"
                >
                  ▶ 执行
                </button>
              </div>
              <!-- 历史下拉列表 -->
              <div
                v-if="parserHistoryOpen && parserHistory.length"
                class="mt-1 border border-base rounded divide-y divide-base"
              >
                <div
                  v-for="(code, hi) in parserHistory"
                  :key="hi"
                  class="flex items-center gap-1 px-2 py-1 hover:bg-elevated cursor-pointer group"
                  @click="
                    selectParserHistory(code);
                    runParser();
                  "
                >
                  <code class="flex-1 text-xs font-mono text-secondary truncate">{{ code }}</code>
                  <button
                    class="text-xs text-red-400 opacity-0 group-hover:opacity-100 shrink-0"
                    @click.stop="deleteParserHistory(code)"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div v-if="streamParserError" class="text-xs text-red-500 mt-0.5">
                ⚠ {{ streamParserError }}
              </div>
            </div>
            <div class="bg-surface border border-base rounded p-2 space-y-1">
              <div v-for="(e, ei) in processedSseEvents" :key="ei" class="text-xs font-mono">
                <div class="flex gap-2 items-baseline flex-wrap">
                  <span class="text-faint shrink-0">{{
                    new Date(e.timestamp).toLocaleTimeString()
                  }}</span>
                  <span class="shrink-0 text-purple-key">event: {{ e.event }}</span>
                  <span v-if="e.id" class="shrink-0 text-faint">id: {{ e.id }}</span>
                  <span v-if="e.retry != null" class="shrink-0 text-amber-500"
                    >retry: {{ e.retry }}</span
                  >
                </div>
                <div class="pl-2 mt-0.5">
                  <span class="text-blue-key">data:</span>
                  <span v-if="e.parseError" class="text-red-500 ml-1">⚠ {{ e.parseError }}</span>
                  <span class="text-primary whitespace-pre-wrap break-all ml-1">{{
                    e.display
                  }}</span>
                </div>
              </div>
              <div
                v-if="!selectedNetwork.events?.filter((e) => e.event !== '__closed__').length"
                class="text-faint text-center py-4 text-xs"
              >
                暂无事件（连接已建立，等待服务端推送）
              </div>
              <div
                v-else-if="!processedSseEvents.length"
                class="text-faint text-center py-4 text-xs"
              >
                无匹配事件
              </div>
            </div>
          </div>

          <!-- 请求头 -->
          <div v-if="selectedNetwork.reqHeaders">
            <div class="text-xs text-faint mb-1">请求头</div>
            <pre
              class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all"
              >{{ formatHeaders(selectedNetwork.reqHeaders) }}</pre>
          </div>

          <!-- 响应头 -->
          <div v-if="selectedNetwork.resHeaders">
            <div class="text-xs text-faint mb-1">响应头</div>
            <pre
              class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all"
              >{{ formatHeaders(selectedNetwork.resHeaders) }}</pre>
          </div>

          <!-- 请求体 -->
          <div v-if="selectedNetwork.reqBody">
            <div class="text-xs text-faint mb-1">请求体</div>
            <div class="bg-surface p-3 rounded border border-base">
              <ObjectInspector :json="fullBodyCache ?? selectedNetwork.reqBody" />
            </div>
            <!-- 懒加载提示：body 被截断时显示 -->
            <div
              v-if="selectedNetwork.bodyTruncated && !fullBodyCache"
              class="mt-1 flex items-center gap-2"
            >
              <span class="text-xs text-amber-500"
                >⚠ 请求体过大已截断（{{ formatSize(selectedNetwork.reqBody.length) }} /
                完整内容需懒加载）</span
              >
              <button
                @click="loadFullBody"
                :disabled="bodyLoading"
                class="px-2 py-0.5 text-xs rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {{ bodyLoading ? "加载中..." : "📥 加载完整内容" }}
              </button>
            </div>
          </div>

          <!-- 响应体 -->
          <div v-if="selectedNetwork.resBody">
            <div class="flex items-center justify-between mb-1">
              <div class="text-xs text-faint">响应体</div>
              <!-- 视图切换：只在 base64 图片和文本之间切换 -->
              <div
                v-if="isImagePreview(selectedNetwork) || isBinaryInfo(selectedNetwork)"
                class="flex items-center gap-1"
              >
                <button
                  @click="resBodyViewMode = 'preview'"
                  class="px-2 py-0.5 text-xs rounded font-medium transition-colors"
                  :class="
                    resBodyViewMode === 'preview'
                      ? 'bg-blue-500 text-white'
                      : 'bg-elevated text-secondary bg-elevated-hover'
                  "
                >
                  预览
                </button>
                <button
                  @click="resBodyViewMode = 'raw'"
                  class="px-2 py-0.5 text-xs rounded font-medium transition-colors"
                  :class="
                    resBodyViewMode === 'raw'
                      ? 'bg-blue-500 text-white'
                      : 'bg-elevated text-secondary bg-elevated-hover'
                  "
                >
                  原始
                </button>
              </div>
            </div>
            <div class="bg-surface p-3 rounded border border-base">
              <!-- 图片预览模式 -->
              <template v-if="isImagePreview(selectedNetwork) && resBodyViewMode === 'preview'">
                <div class="space-y-2">
                  <img
                    :src="selectedNetwork.resBody"
                    alt="响应预览"
                    class="max-w-full rounded border border-light"
                    style="max-height: 300px"
                  />
                  <div class="text-xs text-faint font-mono">
                    {{ selectedNetwork.resBodyMime }} · {{ selectedNetwork.resBody!.length }} chars
                    (base64)
                  </div>
                </div>
              </template>
              <!-- 二进制信息模式 -->
              <template v-else-if="isBinaryInfo(selectedNetwork) && resBodyViewMode === 'preview'">
                <div class="text-sm text-secondary font-mono">{{ selectedNetwork.resBody }}</div>
              </template>
              <!-- 原始文本 / JSON 文本 -->
              <template v-else-if="!isBinaryInfo(selectedNetwork)">
                <ObjectInspector
                  :json="
                    resBodyViewMode === 'raw' && isImagePreview(selectedNetwork)
                      ? selectedNetwork.resBody!.substring(0, 200) + '...'
                      : (fullBodyCache ?? selectedNetwork.resBody)
                  "
                />
              </template>
              <!-- info 模式的原始视图（无内容可显示） -->
              <template v-else>
                <div class="text-xs text-faint">无原始内容（二进制未读取）</div>
              </template>
            </div>
            <!-- 懒加载提示：响应体被截断时显示 -->
            <div
              v-if="selectedNetwork.bodyTruncated && !fullBodyCache"
              class="mt-1 flex items-center gap-2"
            >
              <span class="text-xs text-amber-500"
                >⚠ 响应体过大已截断{{
                  selectedNetwork.resBodySize
                    ? `（原始 ${(selectedNetwork.resBodySize / 1024).toFixed(0)}KB）`
                    : ""
                }}，完整内容需懒加载</span
              >
              <button
                @click="loadFullBody"
                :disabled="bodyLoading"
                class="px-2 py-0.5 text-xs rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {{ bodyLoading ? "加载中..." : "📥 加载完整内容" }}
              </button>
            </div>
          </div>

          <!-- 无 body 提示 -->
          <div
            v-if="!selectedNetwork.reqBody && !selectedNetwork.resBody && !selectedNetwork.error"
            class="text-xs text-faint"
          >
            此请求无请求体/响应体（可能是 GET 请求或响应未完成）
          </div>
        </div>
      </template>
      <div v-else class="text-faint text-center py-8 text-sm">点击左侧请求查看详情</div>
    </div>
  </div>
</template>
