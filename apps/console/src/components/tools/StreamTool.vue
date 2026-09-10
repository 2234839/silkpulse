<script setup lang="ts">
/**
 * StreamTool —— SSE / JSONL / 逐行文本流分析器（ToolsPanel 的流页签）
 *
 * 左侧输入 + 模式切换 + 关键词过滤 + 自定义 Parser（JS 函数，参数 data）；
 * 右侧逐条渲染解析结果。输入经 300ms 防抖；超过 1000 条截断防 DOM 爆炸。
 */
import { ref, computed, watch } from "vue";
import { useDebouncedRef } from "../../composables/useDebouncedRef";
import { parseSse, parseJsonl } from "../../utils/json-tools";
import ToolSplitLayout from "./ToolSplitLayout.vue";
import VirtualList from "./VirtualList.vue";

const streamInput = defineModel<string>("input", { default: "" });
const streamMode = defineModel<"sse" | "jsonl" | "raw">("mode", { default: "sse" });
const streamFilter = defineModel<string>("filter", { default: "" });
const streamParserCode = defineModel<string>("parser", { default: "" });

const streamParserOpen = ref(false);

/** 防抖后的流输入（300ms） */
const streamInputDebounced = useDebouncedRef(streamInput, 300);

const streamEvents = computed(() => {
  const input = streamInputDebounced.value.trim();
  if (!input) return [];
  if (streamMode.value === "sse") return parseSse(input);
  if (streamMode.value === "jsonl") return parseJsonl(input);
  return input
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ data: l, type: "", id: "" }));
});

/** Parser 函数编译 */
let compiledParser: ((data: string) => unknown) | null = null;
const streamParserError = ref("");
watch(
  streamParserCode,
  (code) => {
    const trimmed = code.trim();
    if (!trimmed) {
      compiledParser = null;
      streamParserError.value = "";
      return;
    }
    try {
      compiledParser = new Function("data", code) as (data: string) => unknown;
      streamParserError.value = "";
    } catch (e) {
      compiledParser = null;
      streamParserError.value = (e as Error).message;
    }
  },
  { immediate: true },
);

/** 处理后的流事件（应用 filter + parser）；超过上限截断防 DOM 爆炸 */
const STREAM_MAX_EVENTS = 1000;
const processedStreamEvents = computed(() => {
  const q = streamFilter.value.trim().toLowerCase();
  const result: { type: string; id: string; display: string; parseError?: string }[] = [];
  for (const e of streamEvents.value) {
    if (result.length >= STREAM_MAX_EVENTS) break;
    if (q && !e.data.toLowerCase().includes(q) && !e.type.toLowerCase().includes(q)) continue;
    if (!compiledParser) {
      result.push({ type: e.type, id: e.id, display: e.data });
      continue;
    }
    try {
      const r = compiledParser(e.data);
      result.push({
        type: e.type,
        id: e.id,
        display: typeof r === "string" ? r : JSON.stringify(r, null, 2),
      });
    } catch (e2) {
      result.push({ type: e.type, id: e.id, display: e.data, parseError: (e2 as Error).message });
    }
  }
  return result;
});

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
</script>

<template>
  <ToolSplitLayout storage-key="silkpulse.tools-split.stream" :initial-width="400" :max-width="640">
    <template #left>
      <div class="flex flex-col gap-2 min-w-0 h-full">
        <label class="text-xs text-muted">输入流</label>
        <textarea
          v-model="streamInput"
          rows="16"
          spellcheck="false"
          class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          placeholder='event: message&#10;data: {"msg":"hello"}'
        ></textarea>
        <div class="flex gap-2 items-center">
          <select
            v-model="streamMode"
            class="bg-input border border-base rounded px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-blue-500"
          >
            <option value="sse">SSE (data:/event:)</option>
            <option value="jsonl">JSONL (逐行 JSON)</option>
            <option value="raw">Raw (逐行文本)</option>
          </select>
          <input
            v-model="streamFilter"
            type="text"
            spellcheck="false"
            class="flex-1 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
            placeholder="🔍 过滤关键词..."
          />
        </div>
        <div class="flex gap-2 items-center">
          <button
            @click="streamParserOpen = !streamParserOpen"
            class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
            :class="{ 'text-blue-500 border-blue-500': streamParserOpen || streamParserCode }"
          >
            ⚡ Parser
          </button>
          <button
            @click="streamInput = sseSample"
            class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
          >
            📋 SSE 示例
          </button>
          <button
            @click="streamInput = jsonlSample"
            class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
          >
            📋 JSONL 示例
          </button>
          <span class="text-xs text-faint ml-auto">{{ streamEvents.length }} 条</span>
        </div>
        <div v-if="streamParserOpen">
          <textarea
            v-model="streamParserCode"
            rows="3"
            spellcheck="false"
            class="w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
            placeholder="// 参数 data，返回变换后的值&#10;// 例: return JSON.parse(data).msg"
          ></textarea>
          <p v-if="streamParserError" class="text-xs text-red-500 mt-1">
            ⚠ {{ streamParserError }}
          </p>
        </div>
      </div>
    </template>
    <template #right>
      <!-- 虚拟列表：1000+ 条流事件只渲染可视窗口，避免 DOM 爆炸 -->
      <VirtualList
        v-if="processedStreamEvents.length > 0"
        :items="processedStreamEvents"
        :item-height="40"
        :height="600"
      >
        <template #item="{ item: e }">
          <div class="text-xs font-mono py-0.5 border-b border-base/30">
            <div class="flex gap-2 items-baseline flex-wrap">
              <span v-if="e.type" class="text-purple-500">event: {{ e.type }}</span>
              <span v-if="e.id" class="text-faint">id: {{ e.id }}</span>
            </div>
            <div class="text-primary pl-4 break-all whitespace-pre-wrap truncate">
              {{ e.display }}
            </div>
            <div v-if="e.parseError" class="text-red-500 text-xs pl-4">⚠ {{ e.parseError }}</div>
          </div>
        </template>
      </VirtualList>
      <template v-else>
        <div v-if="streamEvents.length === 0" class="text-xs text-faint text-center py-8">
          输入流数据后自动解析...
        </div>
        <div
          v-else-if="processedStreamEvents.length === 0"
          class="text-xs text-faint text-center py-8"
        >
          无匹配项
        </div>
      </template>
      <div
        v-if="streamEvents.length > processedStreamEvents.length"
        class="text-xs text-amber-500 text-center py-2"
      >
        已截断：仅显示前 {{ STREAM_MAX_EVENTS }} 条（共 {{ streamEvents.length }}
        条），可用过滤缩小范围
      </div>
    </template>
  </ToolSplitLayout>
</template>
