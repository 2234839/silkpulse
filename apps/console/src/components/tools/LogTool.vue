<script setup lang="ts">
/**
 * LogTool —— 日志/流数据可视化查看器（ToolsPanel 的日志页签，前身 StreamTool）
 *
 * 左侧粘贴日志 + 格式切换（SSE / JSONL / 逐行文本）+ 关键词过滤 + 自定义 Parser；
 * 右侧逐条渲染。支持：
 * - ANSI 转义序列渲染（\x1b[31m 红色等，日志最常见的彩色输出格式）
 * - 纯文本控制符可视化（\t→⇥、\r→␍ 等，切换开关控制显示）
 * 输入经 300ms 防抖；右侧虚拟列表只渲染可视窗口，超大日志不炸 DOM。
 */
import { ref, computed, watch } from "vue";
import { useDebouncedRef } from "../../composables/useDebouncedRef";
import { parseSse, parseJsonl } from "../../utils/json-tools";
import ToolSplitLayout from "./ToolSplitLayout.vue";
import VirtualList from "./VirtualList.vue";

const logInput = defineModel<string>("input", { default: "" });
const logMode = defineModel<"sse" | "jsonl" | "raw">("mode", { default: "sse" });
const logFilter = defineModel<string>("filter", { default: "" });
const logParserCode = defineModel<string>("parser", { default: "" });
/** 控制符可视化开关 */
const showControlChars = defineModel<boolean>("controls", { default: false });

/** 面板展开状态（过滤器 / 映射器） */
const filterOpen = ref(false);
const mapperOpen = ref(false);
/** 过滤器：正则模式开关（纯文本包含匹配 / 正则匹配） */
const filterRegex = ref(false);
/** 正则编译错误 */
const filterError = ref("");

/** 防抖后的日志输入（300ms） */
const inputDebounced = useDebouncedRef(logInput, 300);

const events = computed(() => {
  const input = inputDebounced.value.trim();
  if (!input) return [];
  if (logMode.value === "sse") return parseSse(input);
  if (logMode.value === "jsonl") return parseJsonl(input);
  return input
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ data: l, type: "", id: "" }));
});

/* ════════ 过滤器 Filter ════════ */

/** 正则模式：watch 输入即时编译报错 */
let filterRe: RegExp | null = null;
watch(
  [logFilter, filterRegex],
  ([kw, useRe]) => {
    filterRe = null;
    filterError.value = "";
    if (!useRe || !kw.trim()) return;
    try {
      filterRe = new RegExp(kw, "i");
    } catch (e) {
      filterError.value = (e as Error).message;
    }
  },
  { immediate: true },
);

/** 过滤器命中判断 */
function matchFilter(data: string, type: string): boolean {
  const kw = logFilter.value.trim();
  if (!kw) return true;
  if (filterRegex.value) return filterRe ? filterRe.test(data) || filterRe.test(type) : false;
  return (
    data.toLowerCase().includes(kw.toLowerCase()) || type.toLowerCase().includes(kw.toLowerCase())
  );
}

/* ════════ 映射器 Mapper（原 Parser：data → 任意展示值） */
let compiledParser: ((data: string) => unknown) | null = null;
const parserError = ref("");
watch(
  logParserCode,
  (code) => {
    const trimmed = code.trim();
    if (!trimmed) {
      compiledParser = null;
      parserError.value = "";
      return;
    }
    try {
      compiledParser = new Function("data", code) as (data: string) => unknown;
      parserError.value = "";
    } catch (e) {
      compiledParser = null;
      parserError.value = (e as Error).message;
    }
  },
  { immediate: true },
);

/** 过滤后命中条数（过滤器按钮上的 n/m 展示） */
const matchCount = computed(() => processedEvents.value.length);

/** 处理后的日志条目（Filter → Mapper 管道）；右侧虚拟列表只渲染可视窗口，无需截断 */
const processedEvents = computed(() => {
  const result: {
    type: string;
    id: string;
    display: string;
    /** ANSI 渲染后的 token 流（span 分段），无 ANSI 时为 null */
    ansi: { text: string; color: string; bold: boolean }[] | null;
    parseError?: string;
  }[] = [];
  for (const e of events.value) {
    if (!matchFilter(e.data, e.type)) continue;
    let display = e.data;
    if (compiledParser) {
      try {
        const r = compiledParser(e.data);
        display = typeof r === "string" ? r : JSON.stringify(r, null, 2);
      } catch (e2) {
        result.push({
          type: e.type,
          id: e.id,
          display: e.data,
          ansi: null,
          parseError: (e2 as Error).message,
        });
        continue;
      }
    }
    result.push({ type: e.type, id: e.id, display, ansi: renderAnsi(display) });
  }
  return result;
});

/* ════════ ANSI 转义序列渲染 ════════ */

/** ANSI SGR 颜色码 → CSS 类 */
const ANSI_COLORS: Record<string, string> = {
  "30": "text-gray-600",
  "31": "text-red-500",
  "32": "text-green-600",
  "33": "text-yellow-600",
  "34": "text-blue-500",
  "35": "text-purple-500",
  "36": "text-cyan-600",
  "37": "text-gray-300",
  "90": "text-gray-400",
  "91": "text-red-400",
  "92": "text-green-400",
  "93": "text-yellow-400",
  "94": "text-blue-400",
  "95": "text-purple-400",
  "96": "text-cyan-400",
  "97": "text-gray-100",
};

/** ANSI 渲染 token */
interface AnsiToken {
  /** 文本片段 */
  text: string;
  /** CSS 颜色类（默认无） */
  color: string;
  /** 是否加粗 */
  bold: boolean;
}

/**
 * 解析 ANSI 转义序列为带样式的文本分段
 * 仅处理 SGR（\x1b[..m）；其他 CSI 序列（光标移动等）直接剔除。
 * 无 ANSI 序列时返回 null（走纯文本路径）。
 */
function renderAnsi(s: string): AnsiToken[] | null {
  if (!s.includes("\x1b")) return null;
  const tokens: AnsiToken[] = [];
  /** 当前样式状态 */
  let color = "";
  let bold = false;
  /** eslint 禁 reason：手写词法扫描，regex 无全局标志需求 */
  // eslint-disable-next-line no-constant-condition
  while (true) {
    /** 匹配下一个 CSI 序列：ESC [ 参数字母（ESC 为转义字符，日志渲染有意使用） */
    // eslint-disable-next-line no-control-regex
    const m = /\u001b\[([0-9;]*)m|\u001b\[[0-9;]*[A-Za-z]/.exec(s);
    if (!m) break;
    if (m.index > 0) tokens.push({ text: s.slice(0, m.index), color, bold });
    s = s.slice(m.index + m[0].length);
    if (m[1] !== undefined) {
      // SGR 序列：更新样式状态
      const codes = m[1].split(";").map(Number);
      for (const c of codes) {
        if (c === 0) {
          color = "";
          bold = false;
        } else if (c === 1) bold = true;
        else if (ANSI_COLORS[c]) color = ANSI_COLORS[c];
      }
    }
  }
  if (s) tokens.push({ text: s, color, bold });
  return tokens.length ? tokens : null;
}

/* ════════ 纯文本控制符可视化 ════════ */

/** 控制字符 → 可见符号（显示模式；匹配控制字符是本功能的核心目的，非误用） */
/* eslint-disable no-control-regex */
const CONTROL_MAP: [RegExp, string][] = [
  [/\t/g, "⇥ "],
  [/\r/g, "␍"],
  [/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "�"],
];
/* eslint-enable no-control-regex */

/**
 * 控制符可视化：控制字符替换为可见符号
 * （\n 已被逐行解析消费，无需处理）
 */
function visualizeControls(s: string): string {
  let out = s;
  for (const [re, sym] of CONTROL_MAP) out = out.replace(re, sym);
  return out;
}

/** 渲染条目：按开关决定是否可视化控制符 */
function renderText(s: string): string {
  return showControlChars.value ? visualizeControls(s) : s;
}

const sseSample = `event: message
data: {"ts":"2026-08-09T06:00:00Z","level":"info","msg":"服务启动"}

event: update
id: 1
data: {"ts":"2026-08-09T06:00:01Z","level":"info","msg":"收到请求","path":"/api/users"}

event: error
id: 2
data: {"ts":"2026-08-09T06:00:02Z","level":"error","msg":"数据库超时","code":"DB_TIMEOUT"}

event: done
data: [DONE]`;

const jsonlSample = `{"ts":"2026-08-09T06:00:00Z","level":"info","msg":"服务启动","pid":1234}
{"ts":"2026-08-09T06:00:01Z","level":"info","msg":"收到请求","path":"/api/users","duration":45}
{"ts":"2026-08-09T06:00:02Z","level":"error","msg":"数据库超时","code":"DB_TIMEOUT","duration":5000}
{"ts":"2026-08-09T06:00:03Z","level":"warn","msg":"重连成功","retry":2}`;

/** ANSI 彩色日志示例（终端 raw 模式粘贴典型形态） */
const ansiSample = `\x1b[32m[INFO]\x1b[0m 2026-08-09 06:00:00 服务启动\t pid=1234
\x1b[36m[DEBUG]\x1b[0m 请求路径\x1b[1m/api/users\x1b[0m 耗时 45ms
\x1b[31m[ERROR]\x1b[0m 数据库超时\x07 code=DB_TIMEOUT duration=5000ms
\x1b[33m[WARN]\x1b[0m 重连成功 retry=2
\x1b[1;34m[FATAL]\x1b[0m 进程退出\x1b[5D\x1b[1A 清理完成`;
</script>

<template>
  <ToolSplitLayout storage-key="silkpulse.tools-split.log" :initial-width="400" :max-width="640">
    <template #left>
      <div class="flex flex-col gap-2 min-w-0 h-full">
        <label class="text-xs text-muted">日志输入</label>
        <textarea
          v-model="logInput"
          rows="16"
          spellcheck="false"
          class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          placeholder='event: message&#10;data: {"msg":"hello"}&#10;&#10;或直接粘贴日志文本 / 终端 ANSI 彩色输出'
        ></textarea>
        <!-- 格式 + 示例 -->
        <div class="flex gap-2 items-center">
          <select
            v-model="logMode"
            class="bg-input border border-base rounded px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-blue-500"
          >
            <option value="sse">SSE</option>
            <option value="jsonl">JSONL</option>
            <option value="raw">Raw</option>
          </select>
          <button
            v-for="s in [
              { label: 'SSE 示例', v: sseSample },
              { label: 'JSONL 示例', v: jsonlSample },
              { label: 'ANSI 示例', v: ansiSample },
            ]"
            :key="s.label"
            @click="logInput = s.v"
            class="px-2.5 py-1.5 text-xs rounded border border-base text-faint hover:text-primary hover:border-blue-500 transition-colors"
          >
            {{ s.label }}
          </button>
          <span class="text-xs text-faint ml-auto shrink-0">{{ events.length }} 条</span>
        </div>
        <!-- 处理管道：过滤器 + 映射器 -->
        <div class="flex gap-2 items-center">
          <button
            @click="filterOpen = !filterOpen"
            class="px-2.5 py-1.5 text-xs rounded border transition-colors"
            :class="
              filterOpen || logFilter
                ? 'border-blue-500 text-blue-500 bg-blue-500/5'
                : 'border-base text-primary hover:border-blue-500'
            "
          >
            🔽 过滤器<span v-if="logFilter" class="ml-1 text-faint"
              >· {{ matchCount }}/{{ events.length }}</span
            >
          </button>
          <button
            @click="mapperOpen = !mapperOpen"
            class="px-2.5 py-1.5 text-xs rounded border transition-colors"
            :class="
              mapperOpen || logParserCode
                ? 'border-blue-500 text-blue-500 bg-blue-500/5'
                : 'border-base text-primary hover:border-blue-500'
            "
          >
            ⚡ 映射器
          </button>
          <label
            class="flex items-center gap-1 text-xs text-faint cursor-pointer select-none ml-auto"
          >
            <input v-model="showControlChars" type="checkbox" class="accent-blue-500" />
            控制符
          </label>
        </div>
        <!-- 过滤器面板 -->
        <div
          v-if="filterOpen"
          class="rounded border border-base bg-input p-2 flex flex-col gap-1.5"
        >
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-primary">过滤器 Filter</span>
            <label
              class="flex items-center gap-1 text-xs text-faint cursor-pointer select-none ml-auto"
            >
              <input v-model="filterRegex" type="checkbox" class="accent-blue-500" />
              正则
            </label>
          </div>
          <input
            v-model="logFilter"
            type="text"
            spellcheck="false"
            class="w-full bg-surface border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
            :placeholder="filterRegex ? '.*error|timeout.*' : '关键词包含匹配...'"
          />
          <p v-if="filterError" class="text-xs text-red-500">⚠ {{ filterError }}</p>
        </div>
        <!-- 映射器面板 -->
        <div
          v-if="mapperOpen"
          class="rounded border border-base bg-input p-2 flex flex-col gap-1.5"
        >
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-primary">映射器 Mapper</span>
            <button
              v-if="logParserCode"
              @click="logParserCode = ''"
              class="text-xs text-faint hover:text-red-500 ml-auto"
            >
              清除
            </button>
          </div>
          <textarea
            v-model="logParserCode"
            rows="3"
            spellcheck="false"
            class="w-full bg-surface border border-base rounded p-2 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
            placeholder="// 参数 data，返回映射后的展示值&#10;// 例: return JSON.parse(data).msg"
          ></textarea>
          <p v-if="parserError" class="text-xs text-red-500">⚠ {{ parserError }}</p>
        </div>
      </div>
    </template>
    <template #right>
      <VirtualList
        v-if="processedEvents.length > 0"
        :items="processedEvents"
        :item-height="40"
        :height="600"
      >
        <template #item="{ item: e }">
          <div class="text-xs font-mono py-0.5 border-b border-base/40 last:border-b-0">
            <div class="flex gap-2 items-baseline flex-wrap">
              <span v-if="e.type" class="text-purple-500">event: {{ e.type }}</span>
              <span v-if="e.id" class="text-faint">id: {{ e.id }}</span>
            </div>
            <!-- ANSI 渲染：分段着色 -->
            <div v-if="e.ansi" class="pl-4 break-all whitespace-pre-wrap truncate">
              <span v-for="(t, i) in e.ansi" :key="i" :class="[t.color, { 'font-bold': t.bold }]">{{
                renderText(t.text)
              }}</span>
            </div>
            <div v-else class="text-primary pl-4 break-all whitespace-pre-wrap truncate">
              {{ renderText(e.display) }}
            </div>
            <div v-if="e.parseError" class="text-red-500 text-xs pl-4">⚠ {{ e.parseError }}</div>
          </div>
        </template>
      </VirtualList>
      <template v-else>
        <div v-if="events.length === 0" class="text-xs text-faint text-center py-8">
          粘贴日志数据后自动解析...
        </div>
        <div v-else-if="processedEvents.length === 0" class="text-xs text-faint text-center py-8">
          无匹配项
        </div>
      </template>
    </template>
  </ToolSplitLayout>
</template>
