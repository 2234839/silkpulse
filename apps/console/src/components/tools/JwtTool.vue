<script setup lang="ts">
/**
 * JwtTool —— JWT 解码器（ToolsPanel 的 JWT 页签）
 *
 * 粘贴 token 即解码 Header/Payload 并用对象树展示；
 * 含 exp 过期检测，过期状态随全局时钟（父组件 nowTs 经 props 传入）自动翻红。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import ObjectInspector from "../ObjectInspector.vue";
import ToolSplitLayout from "./ToolSplitLayout.vue";

/** JWT token 输入 */
const jwtInput = defineModel<string>("input", { default: "" });

/** 父组件注入的响应式当前时间戳（ms），驱动过期状态随时间自动变化 */
const props = defineProps<{ now: number }>();

const { locale } = useI18n();

/** 按当前界面语言格式化本地时间展示 */
function localeString(d: Date): string {
  return d.toLocaleString(locale.value === "zh" ? "zh-CN" : "en-US");
}

const jwtDecoded = computed(() => {
  const token = jwtInput.value.trim();
  if (!token || token.split(".").length < 2) return null;
  try {
    const parts = token.split(".");
    const decode = (s: string): Record<string, unknown> => {
      const padded = s
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
      return JSON.parse(atob(padded));
    };
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    let expTime: string | null = null;
    let expired = false;
    if (payload.exp && typeof payload.exp === "number") {
      expTime = localeString(new Date(payload.exp * 1000));
      expired = payload.exp * 1000 < props.now;
    }
    return { header, payload, expTime, expired };
  } catch {
    return null;
  }
});
</script>

<template>
  <ToolSplitLayout storage-key="silkpulse.tools-split.jwt" :initial-width="400" :max-width="640">
    <template #left>
      <div class="flex flex-col gap-2 min-w-0 h-full">
        <label class="text-xs text-muted">JWT Token</label>
        <textarea
          v-model="jwtInput"
          rows="12"
          spellcheck="false"
          class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
        ></textarea>
      </div>
    </template>
    <template #right>
      <div class="flex-1 overflow-auto min-w-0 h-full">
        <template v-if="jwtDecoded">
          <div>
            <label class="text-xs text-red-500 block mb-1">🔴 Header</label>
            <div class="bg-surface border border-base rounded p-3">
              <ObjectInspector :raw="jwtDecoded.header" />
            </div>
          </div>
          <div>
            <label class="text-xs text-purple-500 block mb-1">🟣 Payload</label>
            <div class="bg-surface border border-base rounded p-3">
              <ObjectInspector :raw="jwtDecoded.payload" />
            </div>
          </div>
          <div
            v-if="jwtDecoded.expired"
            class="text-red-500 text-xs p-2 bg-red-500/10 border border-red-500/30 rounded"
          >
            {{ $t("jwtTool.expired", { time: jwtDecoded.expTime }) }}
          </div>
          <div
            v-else-if="jwtDecoded.expTime"
            class="text-green-500 text-xs p-2 bg-green-500/10 border border-green-500/30 rounded"
          >
            {{ $t("jwtTool.validUntil", { time: jwtDecoded.expTime }) }}
          </div>
        </template>
        <div v-else class="text-xs text-faint">{{ $t("jwtTool.emptyInput") }}</div>
      </div>
    </template>
  </ToolSplitLayout>
</template>
