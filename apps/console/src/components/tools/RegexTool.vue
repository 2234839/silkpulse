<script setup lang="ts">
/**
 * RegexTool —— 正则测试器（ToolsPanel 的正则页签）
 *
 * 实时匹配 + 捕获组展示 + 替换预览；输入防抖 250ms 降低灾难性回溯卡顿频率；
 * 匹配上限 500 条防 DOM 爆炸；非法正则给红字错误提示。
 */
import { ref, computed } from "vue";
import { useDebouncedRef } from "../../composables/useDebouncedRef";
import ToolSplitLayout from "./ToolSplitLayout.vue";

const regexPattern = ref("");
const regexFlags = ref("g");
const regexInput = ref("");
const regexReplace = ref("");

/** 正则输入防抖（250ms）：降低灾难性回溯卡顿的触发频率 */
const regexInputDebounced = useDebouncedRef(regexInput, 250);
/** 单次匹配上限（防 DOM 爆炸） */
const REGEX_MAX_MATCHES = 500;

const regexError = computed(() => {
  if (!regexPattern.value) return "";
  try {
    new RegExp(regexPattern.value, regexFlags.value);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
});

const regexMatches = computed(() => {
  if (!regexPattern.value || !regexInputDebounced.value || regexError.value) return null;
  try {
    const flags = regexFlags.value.includes("g") ? regexFlags.value : regexFlags.value + "g";
    const re = new RegExp(regexPattern.value, flags);
    const ms: { full: string; index: number; groups: string[] }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(regexInputDebounced.value)) !== null) {
      ms.push({ full: m[0], index: m.index, groups: m.slice(1) });
      if (m.index === re.lastIndex) re.lastIndex++;
      if (ms.length >= REGEX_MAX_MATCHES) break;
    }
    return ms;
  } catch {
    return null;
  }
});

const regexResult = computed(() => {
  if (!regexPattern.value || !regexInputDebounced.value || !regexReplace.value || regexError.value)
    return null;
  try {
    const flags = regexFlags.value.includes("g") ? regexFlags.value : regexFlags.value + "g";
    return regexInputDebounced.value.replace(
      new RegExp(regexPattern.value, flags),
      regexReplace.value,
    );
  } catch {
    return null;
  }
});
</script>

<template>
  <ToolSplitLayout storage-key="silkpulse.tools-split.regex" :initial-width="400" :max-width="640">
    <template #left>
      <div class="flex flex-col gap-2 min-w-0 h-full">
        <label class="text-xs text-muted flex items-center gap-2">
          {{ $t("regexTool.patternLabel") }}
          <span class="text-faint cursor-help" :title="$t('regexTool.redosTitle')">⚠️ ReDoS</span>
        </label>
        <div class="flex items-center gap-1">
          <span class="text-sm text-muted">/</span>
          <input
            v-model="regexPattern"
            type="text"
            spellcheck="false"
            class="flex-1 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
            placeholder="\d{4}-\d{2}-\d{2}"
          />
          <span class="text-sm text-muted">/</span>
          <input
            v-model="regexFlags"
            type="text"
            spellcheck="false"
            class="w-16 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
            placeholder="gim"
          />
        </div>
        <label class="text-xs text-muted mt-2">{{ $t("regexTool.testTextLabel") }}</label>
        <textarea
          v-model="regexInput"
          rows="10"
          spellcheck="false"
          class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
        ></textarea>
        <label class="text-xs text-muted mt-1">{{ $t("regexTool.replaceLabel") }}</label>
        <input
          v-model="regexReplace"
          type="text"
          spellcheck="false"
          class="w-full bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
          placeholder="$1-$2-$3"
        />
      </div>
    </template>
    <template #right>
      <div class="flex-1 overflow-auto min-w-0 h-full">
        <label class="text-xs text-muted block mb-2">
          {{ $t("regexTool.matchesLabel") }}
          <span v-if="regexMatches" class="text-green-500">{{
            $t("regexTool.matchCount", { count: regexMatches.length })
          }}</span>
        </label>
        <div
          v-if="regexError"
          class="text-red-500 text-xs p-3 bg-red-500/10 border border-red-500/30 rounded"
        >
          ⚠ {{ regexError }}
        </div>
        <div
          v-else-if="regexReplace && regexResult !== null"
          class="bg-surface border border-base rounded p-3"
        >
          <div class="text-xs text-muted mb-1">{{ $t("regexTool.replaceResult") }}</div>
          <pre class="text-xs text-green-500 whitespace-pre-wrap break-all">{{ regexResult }}</pre>
        </div>
        <div v-else-if="regexMatches" class="bg-surface border border-base rounded p-3 space-y-2">
          <div
            v-for="(m, i) in regexMatches"
            :key="i"
            class="border-b border-base/30 pb-2 last:border-0"
          >
            <span class="text-xs text-green-500">{{ $t("regexTool.matchN", { n: i + 1 }) }}</span>
            <span class="text-xs text-muted"> @{{ m.index }}</span>
            <code class="block text-xs text-orange-400 py-1 break-all">{{ m.full }}</code>
            <div v-for="(g, gi) in m.groups" :key="gi" class="text-xs text-muted">
              ${{ gi + 1 }}: <span class="text-purple-500">{{ g }}</span>
            </div>
          </div>
        </div>
        <div v-else class="text-xs text-faint">{{ $t("regexTool.emptyInput") }}</div>
      </div>
    </template>
  </ToolSplitLayout>
</template>
