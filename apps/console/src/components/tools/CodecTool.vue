<script setup lang="ts">
/**
 * CodecTool —— 编解码/解析工具集（ToolsPanel 的编解码页签）
 *
 * 类别切换：
 * - 编解码：Base64（UTF-8 安全）/ URL / URI Component / HTML Entity 双向转换
 *   双向可编辑：两个框都是输入框，**谁在编辑谁是消息源**，另一框实时换算
 *   （lastEdited 决定流向）；Auto 模式下消息源的内容签名推断编码类型，
 *   两个框语义不同（原文框=明文、编码框=密文），天然解决「我这段是原文还是编码」的歧义
 * - JWT 解码：token 解出 Header/Payload + exp 过期检测
 * - URL 解析：各部分拆解 + query 参数表
 * - Cookie 解析：Set-Cookie / Cookie 字符串解析 + 过期检测
 *
 * 两个框都可单独复制（带「✓ 已复制」反馈）；清空支持撤销。
 */
import { ref, computed, watch } from "vue";
import { useCopyFlash } from "../../composables/useCopyFlash";
import { utf8ToBase64, base64ToUtf8 } from "../../utils/json-tools";
import { useUndoToast } from "../../composables/useUndoToast";
import { useResizable } from "../../composables/useResizable";
import UndoToast from "./UndoToast.vue";
import JwtTool from "./JwtTool.vue";
import UrlTool from "./UrlTool.vue";
import CookieTool from "./CookieTool.vue";
import TimestampTool from "./TimestampTool.vue";

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
  { id: "timestamp", label: "⏰ 时间戳" },
] as const;
/** 工具类别 id */
type KindId = (typeof kinds)[number]["id"];
/** 工具类别（双向绑定到 ToolsPanel，支持 URL ?tool=jwt/url/cookie 直达对应类别） */
const kind = defineModel<KindId>("kind", { default: "codec" });

/**
 * 根据输入内容推断最可能的编码类型（签名优先级：HTML Entity > 百分号编码）
 *
 * 签名不明确的输入（含中文、空格、标点）视为纯文本，归入 Base64 分支。
 */
function detectCodecMode(s: string): Exclude<CodecMode, "Auto"> {
  if (/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/.test(s)) return "HTML Entity";
  if (/%[0-9a-fA-F]{2}/.test(s))
    return s.includes("?") || s.includes("&") ? "URL" : "URI Component";
  return "Base64";
}

const codecModes = ["Auto", "Base64", "URL", "URI Component", "HTML Entity"] as const;
type CodecMode = (typeof codecModes)[number];
const codecMode = ref<CodecMode>("Auto");

/** 消息源框（谁最后被编辑谁是源；另一框跟随换算） */
const lastEdited = ref<"plain" | "encoded">("plain");
/** 原文框（明文） */
const plainText = ref("");
/** 编码框（密文） */
const encodedText = ref("");

/** Auto 模式下实际生效的编码类型（按消息源内容推断；检测器不会返回 Auto） */
const detectedMode = computed<Exclude<CodecMode, "Auto"> | null>(() =>
  codecMode.value === "Auto"
    ? detectCodecMode(lastEdited.value === "plain" ? plainText.value : encodedText.value)
    : null,
);

/** 实际生效的模式（Auto → 检测结果；其他 → 所选模式） */
const effectiveMode = computed(
  () => detectedMode.value ?? (codecMode.value as Exclude<CodecMode, "Auto">),
);

/** 编解码核心：按模式对字符串做单向转换 */
function runCodec(mode: Exclude<CodecMode, "Auto">, dir: "encode" | "decode", s: string): string {
  if (dir === "encode") {
    switch (mode) {
      case "Base64":
        return utf8ToBase64(s);
      case "URL":
        return encodeURI(s);
      case "URI Component":
        return encodeURIComponent(s);
      case "HTML Entity":
        return s.replace(
          /[&<>"']/g,
          (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
        );
    }
  }
  switch (mode) {
    case "Base64":
      return base64ToUtf8(s);
    case "URL":
      return decodeURI(s);
    case "URI Component":
      return decodeURIComponent(s);
    case "HTML Entity": {
      const el = document.createElement("div");
      el.innerHTML = s;
      return el.textContent ?? "";
    }
  }
}

/**
 * 跟随框的即时换算（v-model 赋值驱动 UI 刷新）
 *
 * plain 是源 → 编码框 = encode(plain)；encoded 是源 → 原文框 = decode(encoded)。
 * 无条件回写：即使「结果 = 源」（如 URL 编码纯数字）也要同步跟随框，
 * 否则跟随框残留旧内容，用户看到的是过期数据。「无变化」仅通过 syncNote 提示。
 * 解码失败（Base64 非整组、%XX 非法等）→ 空串 + 红字错误，源输入不受影响。
 */
function syncFollowText() {
  try {
    if (lastEdited.value === "plain") {
      const s = plainText.value;
      if (!s) {
        encodedText.value = "";
        return;
      }
      encodedText.value = runCodec(effectiveMode.value, "encode", s);
    } else {
      const s = encodedText.value;
      if (!s) {
        plainText.value = "";
        return;
      }
      plainText.value = runCodec(effectiveMode.value, "decode", s);
    }
  } catch (e) {
    if (lastEdited.value === "plain") encodedText.value = "";
    else plainText.value = "";
    syncNote.value = `⚠ ${(e as Error).message}`;
  }
}

/** 提示文案：错误红字（跟随框置空），无变化灰字（跟随框保留源原文以便修正） */
const syncNote = ref("");

/** 源框输入：定消息源 → 即时换算另一框 */
function onSourceInput(target: "plain" | "encoded") {
  lastEdited.value = target;
  syncNote.value = "";
  const s = target === "plain" ? plainText.value : encodedText.value;
  const dir = target === "plain" ? "encode" : "decode";
  let note = "";
  if (s) {
    try {
      if (runCodec(effectiveMode.value, dir, s) === s) {
        note =
          dir === "encode"
            ? "输入已是编码形式，再次编码无变化"
            : `按 ${effectiveMode.value} 解码后无变化（输入可能不是该编码）`;
      }
    } catch {
      note = ""; // 错误由 syncFollowText 统一给出
    }
  }
  syncFollowText();
  // 换算已报 ⚠ 错误时不覆盖，错误优先于「无变化」灰字
  if (!syncNote.value.startsWith("⚠")) syncNote.value = note;
}

/** 模式切换 / 切回编解码页签：按当前消息源强制重算跟随框（lastEdited 不变；跟随框可能残留上一模式的旧结果，必须无条件刷新） */
function resyncFollow() {
  syncNote.value = "";
  if (plainText.value || encodedText.value) syncFollowText();
}
watch(effectiveMode, resyncFollow);
watch(kind, (k) => {
  if (k === "codec") resyncFollow();
});

/** 清空两个框（暂存内容，5s 内可撤销） */
function codecClear() {
  if (!plainText.value && !encodedText.value) return;
  const p = plainText.value;
  const e = encodedText.value;
  const src = lastEdited.value;
  plainText.value = "";
  encodedText.value = "";
  syncNote.value = "";
  clearWithUndo(() => {
    plainText.value = p;
    encodedText.value = e;
    lastEdited.value = src;
  }, "已清空输入");
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
          <template v-if="c === 'Auto' && detectedMode">
            （{{ detectedMode }}·{{ lastEdited === "plain" ? "编码" : "解码" }}）
          </template>
        </button>
      </div>
      <label class="text-xs text-muted">
        原文
        <span v-if="lastEdited === 'plain'" class="text-blue-500">（数据源）</span>
        <span class="text-faint ml-1">{{ plainText.length }} 字符</span>
      </label>
      <textarea
        v-model="plainText"
        spellcheck="false"
        class="w-full bg-input border rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none"
        :class="lastEdited === 'plain' ? 'border-blue-500' : 'border-base'"
        :style="{ height: inputHeight + 'px' }"
        @input="onSourceInput('plain')"
      ></textarea>
    </template>
    <!-- 输入区高度拖拽手柄（仅编解码类别） -->
    <template v-if="isCodec">
      <div
        class="group relative h-1.5 cursor-row-resize shrink-0 -my-1 z-10"
        title="拖拽调整输入区高度"
        @mousedown="onInputHeightDrag"
      >
        <div class="absolute inset-x-0 -top-1 -bottom-1"></div>
        <div
          class="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 rounded bg-base transition-all group-hover:h-1 group-hover:bg-blue-400/60 group-active:bg-blue-500"
        ></div>
      </div>
    </template>

    <!-- 编解码结果（可编辑：编辑此框即成为消息源，原文框跟随解码） -->
    <template v-if="isCodec">
      <label class="text-xs text-muted">
        编码结果
        <span v-if="lastEdited === 'encoded'" class="text-blue-500">（数据源）</span>
        <span class="text-faint ml-1">{{ encodedText.length }} 字符</span>
      </label>
      <textarea
        v-model="encodedText"
        rows="14"
        spellcheck="false"
        class="flex-1 min-h-0 w-full bg-surface border rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none"
        :class="
          lastEdited === 'encoded'
            ? 'border-blue-500 bg-blue-500/5 focus:border-blue-500'
            : 'border-base focus:border-blue-500'
        "
        @input="onSourceInput('encoded')"
      ></textarea>
      <div class="flex items-center gap-2">
        <button
          @click="codecClear"
          class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          清空
        </button>
        <button
          v-if="plainText"
          @click="copyWithFlash('codec:plain', plainText)"
          class="px-3 py-1.5 text-xs rounded border"
          :class="
            copiedKey === 'codec:plain'
              ? 'border-green-500 text-green-500'
              : 'border-base text-primary hover:border-blue-500'
          "
        >
          {{ copiedKey === "codec:plain" ? "✓ 已复制" : "📋 复制原文" }}
        </button>
        <button
          v-if="encodedText"
          @click="copyWithFlash('codec:encoded', encodedText)"
          class="px-3 py-1.5 text-xs rounded border"
          :class="
            copiedKey === 'codec:encoded'
              ? 'border-green-500 text-green-500'
              : 'border-base text-primary hover:border-blue-500'
          "
        >
          {{ copiedKey === "codec:encoded" ? "✓ 已复制" : "📋 复制编码结果" }}
        </button>
        <span class="text-xs text-faint ml-1">
          编辑哪一框，哪一框就是数据源
          <span v-if="syncNote && !syncNote.startsWith('⚠')">{{ syncNote }}</span>
          <span v-if="syncNote.startsWith('⚠')" class="text-red-500">{{ syncNote }}</span>
        </span>
      </div>
    </template>

    <!-- JWT 解码 -->
    <JwtTool v-else-if="kind === 'jwt'" v-model:input="jwtInput" :now="props.now" />
    <!-- URL 解析 -->
    <UrlTool v-else-if="kind === 'url'" />
    <!-- Cookie 解析 -->
    <CookieTool v-else-if="kind === 'cookie'" :now="props.now" />
    <!-- 时间戳 -->
    <TimestampTool v-else-if="kind === 'timestamp'" />
  </div>
  <UndoToast :visible="undoVisible" :message="toastMessage" @undo="doUndo" />
</template>
