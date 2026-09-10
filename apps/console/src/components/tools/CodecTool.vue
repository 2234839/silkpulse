<script setup lang="ts">
/**
 * CodecTool —— 编解码/解析工具集（ToolsPanel 的编解码页签）
 *
 * 类别切换：
 * - 编解码：Base64（UTF-8 安全）/ URL / URI Component / HTML Entity 双向转换
 * - JWT 解码：token 解出 Header/Payload + exp 过期检测
 * - URL 解析：各部分拆解 + query 参数表
 * - Cookie 解析：Set-Cookie / Cookie 字符串解析 + 过期检测
 *
 * 结果可复制（带「✓ 已复制」反馈）、反填回输入；清空支持撤销。
 */
import { ref, computed } from "vue";
import { useCopyFlash } from "../../composables/useCopyFlash";
import { utf8ToBase64, base64ToUtf8 } from "../../utils/json-tools";
import { useUndoToast } from "../../composables/useUndoToast";
import { useResizable } from "../../composables/useResizable";
import UndoToast from "./UndoToast.vue";
import JwtTool from "./JwtTool.vue";
import UrlTool from "./UrlTool.vue";
import CookieTool from "./CookieTool.vue";

/** 父组件注入的响应式当前时间戳（ms），驱动 JWT/Cookie 过期状态随时间自动变化 */
const props = defineProps<{ now: number }>();

/** 清空撤销 toast */
const { visible: undoVisible, toastMessage, clearWithUndo, undo: doUndo } = useUndoToast();

/** 工具箱复制按钮的统一「✓ 已复制」反馈（key 前缀 codec:） */
const { copiedKey, copy: copyWithFlash } = useCopyFlash();

/** 工具类别 */
const kinds = [
  { id: "codec", label: "编解码" },
  { id: "jwt", label: "JWT 解码" },
  { id: "url", label: "URL 解析" },
  { id: "cookie", label: "Cookie 解析" },
] as const;
/** 工具类别 id */
type KindId = (typeof kinds)[number]["id"];
/** 工具类别（双向绑定到 ToolsPanel，支持 URL ?tool=jwt/url/cookie 直达对应类别） */
const kind = defineModel<KindId>("kind", { default: "codec" });

/**
 * Auto 模式：根据输入内容推断最可能的编码类型
 *
 * 优先级：HTML Entity > URI Component > URL > Base64（纯文本输入时 fallback 到 Base64）
 */
function detectCodecMode(s: string): (typeof codecModes)[number] {
  if (/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/.test(s)) return "HTML Entity";
  if (/%[0-9a-fA-F]{2}/.test(s))
    return s.includes("?") || s.includes("&") ? "URL" : "URI Component";
  if (/^[A-Za-z0-9+/_\-=\s]+$/.test(s) && s.length >= 8) return "Base64";
  return "Base64";
}

const codecModes = ["Auto", "Base64", "URL", "URI Component", "HTML Entity"] as const;
type CodecMode = (typeof codecModes)[number];
const codecMode = ref<CodecMode>("Auto");
const codecInput = ref("");
const codecResult = ref("");
const codecError = ref("");

/** Auto 模式下实际生效的编码类型（输入变化时重算；非 Auto 置 null） */
const detectedMode = computed(() =>
  codecMode.value === "Auto" ? detectCodecMode(codecInput.value) : null,
);

/** 实际生效的模式（Auto → 检测结果；其他 → 所选模式） */
const effectiveMode = computed(
  () => detectedMode.value ?? (codecMode.value as Exclude<CodecMode, "Auto">),
);

function doEncode() {
  codecError.value = "";
  try {
    const s = codecInput.value;
    switch (effectiveMode.value) {
      case "Base64":
        codecResult.value = utf8ToBase64(s);
        break;
      case "URL":
        codecResult.value = encodeURI(s);
        break;
      case "URI Component":
        codecResult.value = encodeURIComponent(s);
        break;
      case "HTML Entity":
        codecResult.value = s.replace(
          /[&<>"']/g,
          (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
        );
        break;
    }
  } catch (e) {
    codecError.value = (e as Error).message;
  }
}

function doDecode() {
  codecError.value = "";
  try {
    const s = codecInput.value;
    switch (effectiveMode.value) {
      case "Base64":
        codecResult.value = base64ToUtf8(s);
        break;
      case "URL":
        codecResult.value = decodeURI(s);
        break;
      case "URI Component":
        codecResult.value = decodeURIComponent(s);
        break;
      case "HTML Entity": {
        const el = document.createElement("div");
        el.innerHTML = s;
        codecResult.value = el.textContent ?? "";
        break;
      }
    }
  } catch (e) {
    codecError.value = (e as Error).message;
  }
}

/** 把编解码结果反填回输入框 */
function codecBackfill() {
  codecInput.value = codecResult.value;
}

/** 清空编解码输入与结果（暂存内容，5s 内可撤销） */
function codecClear() {
  const input = codecInput.value;
  const result = codecResult.value;
  if (!input && !result) return;
  codecInput.value = "";
  codecResult.value = "";
  codecError.value = "";
  clearWithUndo(() => {
    codecInput.value = input;
    codecResult.value = result;
  }, "已清空输入与结果");
}

/** JWT 状态桥（切类别不丢输入；Url/Cookie 工具输入为内部状态，切类别会重置） */
const jwtInput = ref("");

/** 编解码输入区高度拖拽（持久化；结果区自适应占满剩余空间） */
const { width: inputHeight, onDragStart: onInputHeightDrag } = useResizable({
  initial: 200,
  min: 60,
  max: 560,
  direction: "down",
  storageKey: "silkpulse.tools-split.codec-input-height",
});

/** 是否为文本编解码类别（只有它需要 编码/解码/清空/复制 按钮组） */
const isCodec = computed(() => kind.value === "codec");
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 类别切换 -->
    <div class="flex gap-1 flex-wrap">
      <button
        v-for="k in kinds"
        :key="k.id"
        @click="kind = k.id"
        class="px-3 py-1.5 text-xs rounded border"
        :class="
          kind === k.id
            ? 'bg-blue-600 text-white border-blue-600'
            : 'border-base text-primary hover:border-blue-500'
        "
      >
        {{ k.label }}
      </button>
    </div>

    <!-- 编解码 -->
    <template v-if="isCodec">
      <div class="flex gap-1">
        <button
          v-for="c in codecModes"
          :key="c"
          @click="codecMode = c"
          class="px-3 py-1.5 text-xs rounded border"
          :class="
            codecMode === c
              ? 'bg-blue-500/20 text-blue-500 border-blue-500'
              : 'border-base text-primary hover:border-blue-500'
          "
        >
          {{ c }}
          <template v-if="c === 'Auto' && detectedMode">（{{ detectedMode }}）</template>
        </button>
      </div>
      <label class="text-xs text-muted">输入</label>
      <textarea
        v-model="codecInput"
        spellcheck="false"
        class="w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
        :style="{ height: inputHeight + 'px' }"
      ></textarea>
      <div class="text-xs text-faint">{{ codecInput.length }} 字符</div>
      <div class="flex gap-2">
        <button
          @click="doEncode"
          class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          ↑ 编码
        </button>
        <button
          @click="doDecode"
          class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
          :title="`按 ${effectiveMode} 解码`"
        >
          ↓ 解码
        </button>
        <button
          @click="codecClear"
          class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          清空
        </button>
      </div>
    </template>
    <!-- 输入区高度拖拽手柄（仅编解码类别） -->
    <template v-if="isCodec">
      <div
        class="group relative h-1.5 cursor-row-resize flex-shrink-0 -my-1 z-10"
        title="拖拽调整输入区高度"
        @mousedown="onInputHeightDrag"
      >
        <div class="absolute inset-x-0 -top-1 -bottom-1"></div>
        <div
          class="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 rounded bg-base transition-all group-hover:h-1 group-hover:bg-blue-400/60 group-active:bg-blue-500"
        ></div>
      </div>
    </template>

    <!-- 编解码结果 -->
    <template v-if="isCodec">
      <label class="text-xs text-muted">结果</label>
      <textarea
        :value="codecResult"
        rows="14"
        readonly
        spellcheck="false"
        class="flex-1 min-h-0 w-full bg-surface border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none"
      ></textarea>
      <div class="flex items-center gap-2">
        <button
          @click="codecBackfill"
          class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          ↩ 反填到输入
        </button>
        <button
          v-if="codecResult"
          @click="copyWithFlash('codec', codecResult)"
          class="px-3 py-1.5 text-xs rounded border"
          :class="
            copiedKey === 'codec'
              ? 'border-green-500 text-green-500'
              : 'border-base text-primary hover:border-blue-500'
          "
        >
          {{ copiedKey === "codec" ? "✓ 已复制" : "📋 复制结果" }}
        </button>
        <span class="text-xs text-faint">{{ codecResult.length }} 字符</span>
      </div>
      <p v-if="codecError" class="text-xs text-red-500">⚠ {{ codecError }}</p>
    </template>

    <!-- JWT 解码 -->
    <JwtTool v-else-if="kind === 'jwt'" v-model:input="jwtInput" :now="props.now" />
    <!-- URL 解析 -->
    <UrlTool v-else-if="kind === 'url'" />
    <!-- Cookie 解析 -->
    <CookieTool v-else-if="kind === 'cookie'" :now="props.now" />
  </div>
  <UndoToast :visible="undoVisible" :message="toastMessage" @undo="doUndo" />
</template>
