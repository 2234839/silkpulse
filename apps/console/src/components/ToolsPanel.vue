<script setup lang="ts">
/**
 * ToolsPanel —— Web Debug 工具箱（/tools 页壳）
 *
 * 职责收敛为三件事：
 * 1. 页签切换（含 URL ?tool= 同步、Alt+数字快捷键）
 * 2. 页签设置系统（显示/隐藏 + 拖拽排序 + localStorage 持久化）
 * 3. 全局时钟 nowTs（经 props 注入各子组件，驱动 JWT/Cookie 过期状态）
 *
 * 各工具的实现已拆分到 tools/ 目录下的独立子组件。
 */
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { type JsonParseMode } from "../utils/json-tools";
import JsonTool from "./tools/JsonTool.vue";
import StreamTool from "./tools/StreamTool.vue";
import CodecTool from "./tools/CodecTool.vue";
import TimestampTool from "./tools/TimestampTool.vue";
import ColorTool from "./tools/ColorTool.vue";
import RegexTool from "./tools/RegexTool.vue";
import DiffTool from "./tools/DiffTool.vue";

/** 工具箱内响应式当前时间：驱动 JWT/Cookie 的过期状态随时间自动翻红（30s 低频刷新） */
const nowTs = ref(Date.now());
const nowTimer = setInterval(() => (nowTs.value = Date.now()), 30_000);
onUnmounted(() => clearInterval(nowTimer));

/** 工具 tab 列表（按重要性排序：JSON 第一，Diff 第二） */
const tools = [
  { id: "json", icon: "📦", label: "JSON" },
  { id: "diff", icon: "📋", label: "Diff" },
  { id: "stream", icon: "🌊", label: "Stream" },
  { id: "codec", icon: "🔐", label: "编解码" },
  { id: "timestamp", icon: "⏰", label: "时间戳" },
  { id: "color", icon: "🎨", label: "颜色" },
  { id: "regex", icon: "🔍", label: "正则" },
];

/** 当前激活工具 id（与 URL ?tool= 双向同步） */
const activeTool = ref<string>("json");

/* ════════ 页签设置系统 ════════ */
const TOOLS_PREF_KEY = "silkpulse.tools-prefs";
const showToolsSettings = ref(false);

/** 设置弹层里的排序/可见性编辑副本 */
interface ToolSettingItem {
  /** 工具 id */
  id: string;
  /** 是否可见 */
  visible: boolean;
}

/** 用户自定义的工具顺序与可见性（持久化到 localStorage） */
const settingsOrder = ref<ToolSettingItem[]>(tools.map((t) => ({ id: t.id, visible: true })));

/** 从 localStorage 恢复页签设置 */
function loadToolsSettings() {
  try {
    const raw = localStorage.getItem(TOOLS_PREF_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as ToolSettingItem[];
    /** 以保存的顺序为准，且只保留仍然存在的工具；新增工具追加到末尾并默认可见 */
    const byId = new Map(saved.map((s) => [s.id, s.visible]));
    settingsOrder.value = [
      ...saved.filter((s) => tools.some((t) => t.id === s.id)),
      ...tools.filter((t) => !byId.has(t.id)).map((t) => ({ id: t.id, visible: true })),
    ].map((s) => ({ id: s.id, visible: byId.get(s.id) ?? true }));
  } catch {
    /** localStorage 数据损坏时回退默认设置 */
    settingsOrder.value = tools.map((t) => ({ id: t.id, visible: true }));
  }
}

/** 应用设置（写 localStorage 并刷新可见列表） */
function applyToolsSettings() {
  localStorage.setItem(TOOLS_PREF_KEY, JSON.stringify(settingsOrder.value));
  showToolsSettings.value = false;
}

/** 恢复默认设置 */
function resetToolsSettings() {
  settingsOrder.value = tools.map((t) => ({ id: t.id, visible: true }));
  localStorage.removeItem(TOOLS_PREF_KEY);
}

/** 拖拽排序状态：被拖行 & 悬停目标行 */
const dragIdx = ref<number | null>(null);
const dragOverIdx = ref<number | null>(null);

/**
 * @param idx 被拖行的下标
 */
function onDragStart(idx: number) {
  dragIdx.value = idx;
}

/**
 * @param idx 悬停目标行下标
 * @param e 拖拽事件（阻止默认行为以允许 drop）
 */
function onDragOver(idx: number, e: DragEvent) {
  e.preventDefault();
  dragOverIdx.value = idx;
}

/** 拖拽离开列表区域时清除悬停高亮 */
function onDragLeaveList() {
  dragOverIdx.value = null;
}

/**
 * 把被拖行放到目标位置
 *
 * @param idx 目标位置下标
 */
function onDrop(idx: number) {
  if (dragIdx.value === null || dragIdx.value === idx) {
    dragIdx.value = null;
    dragOverIdx.value = null;
    return;
  }
  const list = settingsOrder.value;
  const [moved] = list.splice(dragIdx.value, 1);
  list.splice(idx, 0, moved);
  dragIdx.value = null;
  dragOverIdx.value = null;
}

/**
 * 切换单个工具可见性
 *
 * @param id 工具 id
 */
function toggleToolVisible(id: string) {
  const item = settingsOrder.value.find((s) => s.id === id);
  if (item) item.visible = !item.visible;
}

/** 按用户设置排序后的可见工具列表 */
const visibleTools = computed(() => {
  const order = new Map(settingsOrder.value.map((s) => [s.id, s.visible]));
  return tools
    .filter((t) => order.get(t.id) ?? true)
    .sort((a, b) => {
      const ia = settingsOrder.value.findIndex((s) => s.id === a.id);
      const ib = settingsOrder.value.findIndex((s) => s.id === b.id);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
});

loadToolsSettings();

/* ════════ 持久化到各子组件的共享状态（v-model 桥：切页签不丢输入） ════════ */
/** JSON 工具 */
const jsonInput = ref("");
const jsonJqFilter = ref("");
const jsonParseMode = ref<JsonParseMode>("json");
const jsonTreeSearch = ref("");

/** Diff 工具 */
const diffA = ref("");
const diffB = ref("");
const diffTreeSearchA = ref("");
const diffTreeSearchB = ref("");

/** Stream 工具 */
const streamInput = ref("");
const streamMode = ref<"sse" | "jsonl" | "raw">("sse");
const streamFilter = ref("");
const streamParserCode = ref("");

/** 编解码工具内类别（JWT/URL/Cookie 并入编解码页，用 URL ?tool= 直达对应类别） */
const codecKind = ref<"codec" | "jwt" | "url" | "cookie">("codec");

/* ════════ activeTool 与 URL ?tool= 双向同步 ════════ */
const route = useRoute();
const router = useRouter();

watch(
  () => route.query.tool,
  (v) => {
    /** 旧页签 id → 编解码内类别（JWT/URL/Cookie 已并入编解码页） */
    const legacyMap: Record<string, "jwt" | "url" | "cookie"> = {
      jwt: "jwt",
      url: "url",
      cookie: "cookie",
    };
    if (typeof v === "string" && v in legacyMap) {
      activeTool.value = "codec";
      codecKind.value = legacyMap[v];
      return;
    }
    if (typeof v === "string" && tools.some((t) => t.id === v)) {
      activeTool.value = v;
    }
  },
  { immediate: true },
);

watch(activeTool, (v) => {
  if (route.query.tool !== v) {
    router.replace({ query: { ...route.query, tool: v } });
  }
});

/** 处理 Alt + 数字键：切换到第 N 个可见工具（Ctrl/Cmd+数字被浏览器「切标签页」保留拦不住，改用 Alt） */
function onGlobalKeydown(e: KeyboardEvent) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (!/^[1-9]$/.test(e.key)) return;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  /** 输入控件与可编辑节点内不打断用户输入 */
  if (tag === "TEXTAREA" || tag === "INPUT" || target?.isContentEditable) return;
  const tool = visibleTools.value[Number(e.key) - 1];
  if (!tool) return;
  e.preventDefault();
  activeTool.value = tool.id;
}

onMounted(() => window.addEventListener("keydown", onGlobalKeydown));
onUnmounted(() => window.removeEventListener("keydown", onGlobalKeydown));
</script>

<template>
  <div class="h-screen flex flex-col overflow-hidden">
    <!-- 顶部栏 -->
    <header class="bg-gray-900 text-white px-4 py-2.5 flex items-center gap-4 flex-shrink-0">
      <h1 class="text-base font-semibold">🔧 SilkPulse Tools</h1>
      <span class="text-xs text-gray-400" title="快捷键：Alt + 1~9 切换到第 N 个可见工具"
        >Web Debug 工具箱 · 纯前端 · 数据不出域 · Alt+数字切换工具</span
      >
      <div class="ml-auto flex items-center gap-3">
        <button
          @click="showToolsSettings = true"
          class="text-xs text-gray-400 hover:text-white"
          title="自定义工具页签：排序与显示/隐藏"
        >
          ⚙️ 工具设置
        </button>
        <router-link to="/" class="text-xs text-blue-400 hover:text-blue-300">← 控制台</router-link>
      </div>
    </header>

    <!-- 工具切换栏 -->
    <nav class="flex border-b border-base bg-surface overflow-x-auto flex-shrink-0">
      <button
        v-for="t in visibleTools"
        :key="t.id"
        @click="activeTool = t.id"
        class="px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap flex items-center gap-1.5"
        :class="
          activeTool === t.id
            ? 'border-blue-500 text-blue-600'
            : 'border-transparent text-muted hover:text-primary'
        "
      >
        {{ t.icon }} {{ t.label }}
      </button>
    </nav>

    <!-- 工具内容 -->
    <div class="flex-1 overflow-y-auto p-4">
      <JsonTool
        v-if="activeTool === 'json'"
        v-model:input="jsonInput"
        v-model:jq="jsonJqFilter"
        v-model:mode="jsonParseMode"
        v-model:search="jsonTreeSearch"
      />
      <DiffTool
        v-else-if="activeTool === 'diff'"
        v-model:input-a="diffA"
        v-model:input-b="diffB"
        v-model:search-a="diffTreeSearchA"
        v-model:search-b="diffTreeSearchB"
      />
      <StreamTool
        v-else-if="activeTool === 'stream'"
        v-model:input="streamInput"
        v-model:mode="streamMode"
        v-model:filter="streamFilter"
        v-model:parser="streamParserCode"
      />
      <CodecTool v-else-if="activeTool === 'codec'" v-model:kind="codecKind" :now="nowTs" />
      <TimestampTool v-else-if="activeTool === 'timestamp'" />
      <ColorTool v-else-if="activeTool === 'color'" />
      <RegexTool v-else-if="activeTool === 'regex'" />
    </div>

    <!-- 工具页签设置弹层 -->
    <div
      v-if="showToolsSettings"
      class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      @click.self="showToolsSettings = false"
    >
      <div
        class="bg-surface border border-base rounded-lg shadow-xl w-[420px] max-h-[80vh] flex flex-col"
      >
        <div class="px-4 py-3 border-b border-base flex items-center">
          <h3 class="text-sm font-semibold">⚙️ 工具页签设置</h3>
          <button
            @click="showToolsSettings = false"
            class="ml-auto text-muted hover:text-primary text-sm"
            title="关闭"
          >
            ✕
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-3">
          <p class="text-xs text-muted mb-2">拖动行调整顺序，取消勾选隐藏页签。</p>
          <div class="flex flex-col gap-1" @dragleave="onDragLeaveList">
            <div
              v-for="(item, idx) in settingsOrder"
              :key="item.id"
              draggable="true"
              @dragstart="onDragStart(idx)"
              @dragover="onDragOver(idx, $event)"
              @drop="onDrop(idx)"
              @dragend="
                dragIdx = null;
                dragOverIdx = null;
              "
              class="flex items-center gap-2 px-2 py-1.5 rounded border cursor-grab active:cursor-grabbing transition-colors"
              :class="[
                item.visible ? '' : 'opacity-50',
                dragIdx === idx ? 'border-blue-500 bg-blue-500/10' : 'border-base',
                dragOverIdx === idx && dragIdx !== null && dragIdx !== idx
                  ? 'border-t-2 border-t-blue-500'
                  : '',
              ]"
            >
              <span class="text-faint text-xs select-none" title="拖动排序">⠿</span>
              <input
                type="checkbox"
                :checked="item.visible"
                @change="toggleToolVisible(item.id)"
                @click.stop
                class="cursor-pointer"
              />
              <span class="text-sm flex-1 select-none">
                {{ tools.find((t) => t.id === item.id)?.icon }}
                {{ tools.find((t) => t.id === item.id)?.label }}
              </span>
              <button
                @click="onDrop(0)"
                :disabled="idx === 0"
                class="px-1.5 text-xs text-muted hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                title="置顶"
              >
                ⤒
              </button>
            </div>
          </div>
        </div>
        <div class="px-4 py-3 border-t border-base flex items-center gap-2">
          <button
            @click="resetToolsSettings"
            class="px-3 py-1.5 text-xs rounded border border-base text-muted hover:text-primary"
          >
            恢复默认
          </button>
          <button
            @click="applyToolsSettings"
            class="ml-auto px-4 py-1.5 text-xs rounded bg-blue-500 text-white hover:bg-blue-600"
          >
            应用
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
