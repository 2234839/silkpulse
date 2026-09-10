<script setup lang="ts">
/**
 * JsonTool —— JSON 可视化 + JQ 过滤（ToolsPanel 的 JSON 页签）
 *
 * 左右分栏可拖拽（宽度持久化），支持 JSON/JSONC/JSON5 三种解析模式、
 * 格式化/压缩/转义/反转义快捷操作、JQ 风格路径过滤、树内节点搜索。
 * 输入经 300ms 防抖后才做解析渲染，防大文本粘贴卡死。
 */
import { ref, computed, watch } from "vue";
import { applyJq, parseByMode, type JsonParseMode } from "../../utils/json-tools";
import ObjectInspector from "../ObjectInspector.vue";
import ToolSplitLayout from "./ToolSplitLayout.vue";

const jsonInput = defineModel<string>("input", { default: "" });
const jsonJqFilter = defineModel<string>("jq", { default: "" });
const jsonParseMode = defineModel<JsonParseMode>("mode", { default: "json" });
const jsonTreeSearch = defineModel<string>("search", { default: "" });

/** 当前模式下的输入框 placeholder */
const placeholder = computed(() => {
  if (jsonParseMode.value === "jsonc") {
    return '// 配置文件\n{\n  "name": "silkpulse",\n  "debug": true,\n}';
  }
  if (jsonParseMode.value === "json5") {
    return "// JSON5\n{\n  name: 'silkpulse',\n  items: [1, 2, 3,]\n}";
  }
  return '{"name":"silkpulse","items":[{"id":1,"msg":"hello"}]}';
});

/** 当前模式的提示文案 */
const modeHint = computed(() => {
  if (jsonParseMode.value === "jsonc") return "JSONC：支持单行/多行注释、尾逗号";
  if (jsonParseMode.value === "json5")
    return "JSON5：支持注释、单引号、无引号 key、尾逗号、十六进制";
  return "语法：.key 取字段，.arr[] 遍历数组，.a.b 嵌套路径";
});

/** JSON 操作按钮的错误提示文本（格式化/压缩/转义/反转义共用） */
const actionError = ref("");

/** 按当前解析模式解析输入，失败时写入错误提示并返回 undefined */
function parseInputOrError(): unknown | undefined {
  try {
    actionError.value = "";
    return parseByMode(jsonInput.value, jsonParseMode.value);
  } catch (e) {
    actionError.value = "JSON 解析失败：" + (e as Error).message;
    return undefined;
  }
}

/** 格式化 JSON（2 空格缩进）写回输入框 */
function format() {
  const obj = parseInputOrError();
  if (obj === undefined) return;
  jsonInput.value = JSON.stringify(obj, null, 2);
}

/** 压缩 JSON（去除空白）写回输入框 */
function minify() {
  const obj = parseInputOrError();
  if (obj === undefined) return;
  jsonInput.value = JSON.stringify(obj);
}

/** 把整个输入文本作为字符串转义（JSON.stringify 的带引号形式）写回输入框 */
function escape() {
  actionError.value = "";
  jsonInput.value = JSON.stringify(jsonInput.value);
}

/** 反转义：解析结果为字符串时写回该字符串 */
function unescape() {
  const parsed = parseInputOrError();
  if (parsed === undefined) return;
  if (typeof parsed !== "string") {
    actionError.value = "JSON 解析失败：结果不是字符串，无法反转义";
    return;
  }
  jsonInput.value = parsed;
}

/** 防抖后的输入/JQ：粘贴大 JSON 时避免每次键入都全量解析卡死主线程 */
const inputDebounced = ref(jsonInput.value);
const jqDebounced = ref(jsonJqFilter.value);
let inputTimer: ReturnType<typeof setTimeout> | undefined;
let jqTimer: ReturnType<typeof setTimeout> | undefined;
watch(jsonInput, (v) => {
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => (inputDebounced.value = v), 300);
});
watch(jsonJqFilter, (v) => {
  clearTimeout(jqTimer);
  jqTimer = setTimeout(() => (jqDebounced.value = v), 300);
});

/** 解析结果：ok 带数据 / error 带消息 / undefined 空输入 */
const parsed = computed<{ ok: true; data: unknown } | { ok: false; error: string } | undefined>(
  () => {
    if (!inputDebounced.value.trim()) return undefined;
    try {
      let data: unknown = parseByMode(inputDebounced.value, jsonParseMode.value);
      const jq = jqDebounced.value.trim();
      if (jq && jq.startsWith(".")) {
        data = applyJq(data, jq);
      }
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
);
</script>

<template>
  <ToolSplitLayout storage-key="silkpulse.tools-split.json" :initial-width="480">
    <template #left>
      <div class="flex items-center gap-2">
        <label class="text-xs text-muted">输入</label>
        <div class="ml-auto flex items-center gap-1">
          <button
            v-for="m in [
              { id: 'json', label: 'JSON' },
              { id: 'jsonc', label: 'JSONC' },
              { id: 'json5', label: 'JSON5' },
            ]"
            :key="m.id"
            @click="jsonParseMode = m.id as JsonParseMode"
            class="px-2 py-0.5 text-xs rounded border transition-colors"
            :class="
              jsonParseMode === m.id
                ? 'border-blue-500 text-blue-500 bg-blue-500/10'
                : 'border-base text-muted hover:text-primary'
            "
          >
            {{ m.label }}
          </button>
        </div>
      </div>
      <textarea
        v-model="jsonInput"
        rows="20"
        spellcheck="false"
        class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
        :placeholder="placeholder"
      ></textarea>
      <div class="flex gap-1 flex-wrap">
        <button
          @click="format"
          class="px-2 py-0.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          格式化
        </button>
        <button
          @click="minify"
          class="px-2 py-0.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          压缩
        </button>
        <button
          @click="escape"
          class="px-2 py-0.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          转义
        </button>
        <button
          @click="unescape"
          class="px-2 py-0.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          反转义
        </button>
      </div>
      <p v-if="actionError" class="text-xs text-red-500">⚠ {{ actionError }}</p>
      <div class="flex gap-2 items-center">
        <input
          v-model="jsonJqFilter"
          type="text"
          spellcheck="false"
          class="flex-1 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
          placeholder="JQ 过滤（如 .items[].msg）"
        />
      </div>
      <p class="text-xs text-faint">{{ modeHint }}</p>
    </template>
    <template #right>
      <div class="flex items-center justify-between mb-2">
        <label class="text-xs text-muted">可视化结果</label>
        <input
          v-model="jsonTreeSearch"
          type="text"
          placeholder="搜索节点..."
          class="w-40 px-2 py-0.5 text-xs bg-base border border-base rounded focus:outline-none focus:border-blue-400"
        />
      </div>
      <div v-if="parsed?.ok" class="bg-surface border border-base rounded p-3">
        <ObjectInspector :raw="parsed.data" :search-query="jsonTreeSearch" />
      </div>
      <div
        v-else-if="parsed && !parsed.ok"
        class="text-red-500 text-xs p-3 bg-red-500/10 border border-red-500/30 rounded"
      >
        ⚠ {{ parsed.error }}
      </div>
      <div v-else class="text-xs text-faint">输入 JSON 后自动渲染...</div>
    </template>
  </ToolSplitLayout>
</template>
