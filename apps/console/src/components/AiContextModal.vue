<script setup lang="ts">
/**
 * AI 诊断上下文弹窗 —— 结构化诊断包
 *
 * 将设备现场（环境 + 错误 + 请求 + Storage）按 markdown 结构组装为
 * AI 可读诊断包，支持各 section 勾选、字符数统计与一键复制。
 */
import { ref, computed, watch } from "vue";
import type { LogEntry, NetworkEntry, ErrorEntry, DeviceInfo } from "@silkpulse/shared";
import { copyText } from "../utils/clipboard";
import { apiFetch } from "../utils/api";

const props = defineProps<{
  modelValue: boolean;
  deviceId: string;
  /** 完整设备信息（取 userAgent / viewport / deviceType，父组件传 selectedDevice） */
  device: DeviceInfo | null;
  title: string;
  url: string;
  errors: ErrorEntry[];
  network: NetworkEntry[];
  logs: LogEntry[];
}>();

const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

/** 组装中 */
const building = ref(false);
/** 各 section 勾选状态（默认全选） */
const sections = ref({ env: true, errors: true, network: true, storage: true });
/** 生成的诊断包 markdown */
const diagText = ref("");
/** 远端 localStorage 原始 JSON（打开时异步拉取，null = 未加载） */
const storageRaw = ref<string | null>(null);
/** 复制状态：idle / copied / error */
const copyState = ref<"idle" | "copied" | "error">("idle");

/** 总字符数 */
const totalChars = computed(() => diagText.value.length);

/** 字符截断，超长加省略标记 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(截断)` : text;
}

/** ISO 时间转本地可读，非法则原样返回 */
function fmtTime(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString("zh-CN");
}

/** 环境 section（UA/屏幕来自 DeviceInfo） */
function buildEnv(): string {
  const d = props.device;
  const lines = ["## 环境", `- 生成时间: ${new Date().toISOString()}`];
  if (d) {
    lines.push(
      `- 设备标题: ${d.title}`,
      `- URL: ${d.url}`,
      `- UA: ${d.userAgent}`,
      `- 屏幕(视口): ${d.viewportWidth}x${d.viewportHeight}`,
      `- 设备类型: ${d.deviceType}`,
    );
  } else {
    lines.push(`- 设备标题: ${props.title}`, `- URL: ${props.url}`);
  }
  return lines.join("\n");
}

/** 最近错误 section（最多 10 条，按时间倒序） */
function buildErrors(): string {
  const lines = ["## 最近错误"];
  const list = [...props.errors]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 10);
  if (list.length === 0) {
    lines.push("（无）");
    return lines.join("\n");
  }
  for (const e of list) {
    const pos = e.source ? ` (+ ${e.source}:${e.line ?? "?"}:${e.col ?? "?"})` : "";
    lines.push(`- [${fmtTime(e.timestamp)}] 错误: ${truncate(e.message, 300)}${pos}`);
  }
  return lines.join("\n");
}

/** 最近请求 section（最多 15 条倒序，失败请求附详情截断 500 字符） */
function buildNetwork(): string {
  const lines = ["## 最近请求"];
  const list = [...props.network]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 15);
  if (list.length === 0) {
    lines.push("（无）");
    return lines.join("\n");
  }
  for (const n of list) {
    const failed = n.status >= 400 || n.status === 0 || !!n.error;
    lines.push(
      `- [${fmtTime(n.timestamp)}] ${n.method} ${n.url} → ${n.status} (${n.duration} ms)${failed ? " ⚠ 失败" : ""}`,
    );
    if (failed) {
      if (n.reqHeaders)
        lines.push(`  - reqHeaders: ${truncate(JSON.stringify(n.reqHeaders), 500)}`);
      if (n.reqBody) lines.push(`  - reqBody: ${truncate(n.reqBody, 500)}`);
      if (n.resBody) lines.push(`  - resBody: ${truncate(n.resBody, 500)}`);
    }
  }
  return lines.join("\n");
}

/** Storage 摘要 section（值截断 200 字符） */
function buildStorage(): string {
  const lines = ["## Storage 摘要"];
  if (storageRaw.value === null) {
    lines.push("（不可用）");
    return lines.join("\n");
  }
  const data: Record<string, string> = JSON.parse(storageRaw.value);
  const keys = Object.keys(data);
  if (keys.length === 0) {
    lines.push("（空）");
    return lines.join("\n");
  }
  for (const k of keys) lines.push(`- ${k}: ${truncate(data[k], 200)}`);
  return lines.join("\n");
}

/** 按勾选的 section 组装诊断包全文 */
function assemble(): void {
  const parts: string[] = ["# SilkPulse 诊断包"];
  if (sections.value.env) parts.push(buildEnv());
  if (sections.value.errors) parts.push(buildErrors());
  if (sections.value.network) parts.push(buildNetwork());
  if (sections.value.storage) parts.push(buildStorage());
  diagText.value = parts.join("\n\n");
}

/** 通过 server HTTP 接口拉取远端 localStorage（与 StoragePanel 同源） */
async function loadStorage(): Promise<void> {
  try {
    const res = await apiFetch(`/api/devices/${props.deviceId}/storage?type=local`);
    if (res.ok) {
      const data = await res.json();
      storageRaw.value = JSON.stringify(data.entries ?? data);
      return;
    }
  } catch {
    /** 网络失败按空 storage 处理 */
  }
  storageRaw.value = "{}";
}

/** 复制诊断包全文到剪贴板 */
async function copyDiag(): Promise<void> {
  const ok = await copyText(diagText.value);
  if (ok) {
    copyState.value = "copied";
    setTimeout(() => (copyState.value = "idle"), 1500);
  } else {
    copyState.value = "error";
  }
}

/** 弹窗打开时拉取 storage 并首次组装 */
watch(
  () => props.modelValue,
  async (v) => {
    if (v) {
      building.value = true;
      await loadStorage();
      assemble();
      building.value = false;
    }
  },
);

/** 勾选变化时实时重组 */
watch(sections, assemble, { deep: true });
</script>

<template>
  <div
    v-if="modelValue"
    class="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
    @click.self="emit('update:modelValue', false)"
  >
    <div
      class="bg-surface rounded-lg shadow-xl w-full max-w-[720px] mx-4 max-h-[80vh] flex flex-col"
    >
      <div class="flex items-center justify-between px-5 py-3 border-b border-base">
        <h3 class="text-sm font-semibold text-primary">AI 诊断上下文</h3>
        <div class="flex items-center gap-2">
          <button
            @click="copyDiag"
            class="px-3 py-1 text-xs rounded font-medium"
            :class="
              copyState === 'copied'
                ? 'bg-green-100 text-green-700'
                : copyState === 'error'
                  ? 'bg-red-100 text-red-700'
                  : 'bg-elevated text-secondary bg-elevated-hover'
            "
          >
            {{ copyState === "copied" ? "✓ 已复制" : copyState === "error" ? "复制失败" : "复制" }}
          </button>
          <button
            @click="emit('update:modelValue', false)"
            class="px-3 py-1 text-xs rounded bg-elevated text-secondary bg-elevated-hover"
          >
            关闭
          </button>
        </div>
      </div>
      <div class="px-5 py-2 flex flex-wrap items-center gap-3 border-b border-base text-xs">
        <label class="flex items-center gap-1 cursor-pointer text-secondary">
          <input v-model="sections.env" type="checkbox" /> 环境
        </label>
        <label class="flex items-center gap-1 cursor-pointer text-secondary">
          <input v-model="sections.errors" type="checkbox" /> 错误
        </label>
        <label class="flex items-center gap-1 cursor-pointer text-secondary">
          <input v-model="sections.network" type="checkbox" /> 请求
        </label>
        <label class="flex items-center gap-1 cursor-pointer text-secondary">
          <input v-model="sections.storage" type="checkbox" /> Storage
        </label>
        <span class="ml-auto text-faint">{{ totalChars }} 字符</span>
      </div>
      <div class="flex-1 overflow-y-auto p-5">
        <pre v-if="building" class="text-sm text-faint">正在组装诊断包...</pre>
        <pre v-else class="text-xs font-mono text-primary whitespace-pre-wrap">{{ diagText }}</pre>
      </div>
    </div>
  </div>
</template>
