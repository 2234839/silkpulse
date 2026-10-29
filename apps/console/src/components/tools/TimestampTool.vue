<script setup lang="ts">
/**
 * TimestampTool —— 时间戳 ↔ 人类时间双向转换（ToolsPanel 的时间戳页签）
 *
 * 自动识别秒/毫秒时间戳；非法输入给红字错误提示而非静默；
 * 人类时间输入支持 Date 可解析的任意格式。
 */
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { humanDuration } from "../../utils/json-tools";

const { t, locale } = useI18n();

/** 按当前界面语言格式化本地时间展示 */
function localeString(d: Date): string {
  return d.toLocaleString(locale.value === "zh" ? "zh-CN" : "en-US");
}

const tsInput = ref("");
const tsResult = ref<{ local: string; utc: string; iso: string; relative: string } | null>(null);
/** 时间戳输入非法时的错误提示（非法输入不再静默无反馈） */
const tsError = ref("");
/** 日期输入非法时的错误提示 */
const dateError = ref("");
const dateInput = ref("");
const dateResult = ref<{ ms: number; s: number } | null>(null);

/** 把时间戳转换为多种格式展示；相对时间基于当前时刻 */
function convertTs() {
  const raw = tsInput.value.trim();
  if (!raw) {
    tsResult.value = null;
    tsError.value = "";
    return;
  }
  if (isNaN(Number(raw))) {
    tsResult.value = null;
    tsError.value = t("timestampTool.invalidTs", { raw });
    return;
  }
  let num = Number(raw);
  if (raw.length <= 10) num *= 1000;
  const d = new Date(num);
  if (isNaN(d.getTime())) {
    tsResult.value = null;
    tsError.value = t("timestampTool.outOfRange", { raw });
    return;
  }
  tsError.value = "";
  const now = Date.now();
  const diff = now - num;
  /** 相对时间：duration 复用 jsonTools.* 时长键（humanDuration 内部已走 i18n） */
  const rel =
    diff > 0
      ? t("timestampTool.relAgo", { duration: humanDuration(Math.abs(diff)) })
      : t("timestampTool.relLater", { duration: humanDuration(Math.abs(diff)) });
  tsResult.value = {
    local: localeString(d),
    utc: d.toUTCString(),
    iso: d.toISOString(),
    relative: rel,
  };
}

/** 把人类时间转换为 ms/s 时间戳 */
function convertDate() {
  if (!dateInput.value.trim()) {
    dateResult.value = null;
    dateError.value = "";
    return;
  }
  const d = new Date(dateInput.value);
  if (isNaN(d.getTime())) {
    dateResult.value = null;
    dateError.value = t("timestampTool.invalidDate", { raw: dateInput.value });
    return;
  }
  dateError.value = "";
  dateResult.value = { ms: d.getTime(), s: Math.floor(d.getTime() / 1000) };
}
</script>

<template>
  <div>
    <div>
      <label class="text-xs text-muted block mb-2">{{ $t("timestampTool.tsToDate") }}</label>
      <div class="flex gap-2">
        <input
          v-model="tsInput"
          type="text"
          spellcheck="false"
          class="flex-1 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
          :placeholder="$t('timestampTool.tsPlaceholder')"
          @input="convertTs"
        />
        <button
          @click="
            tsInput = String(Date.now());
            convertTs();
          "
          class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          {{ $t("timestampTool.now") }}
        </button>
      </div>
      <div v-if="tsResult" class="bg-surface border border-base rounded p-3 mt-2 space-y-1 text-xs">
        <div>
          📅 <strong class="text-primary">{{ tsResult.local }}</strong>
        </div>
        <div class="text-muted">🌍 UTC: {{ tsResult.utc }}</div>
        <div class="text-muted">🌍 ISO: {{ tsResult.iso }}</div>
        <div class="text-muted">🕐 {{ $t("timestampTool.relative") }}: {{ tsResult.relative }}</div>
      </div>
      <p v-else-if="tsError" class="text-xs text-red-500 mt-2">⚠ {{ tsError }}</p>
    </div>
    <div>
      <label class="text-xs text-muted block mb-2">{{ $t("timestampTool.dateToTs") }}</label>
      <input
        v-model="dateInput"
        type="text"
        spellcheck="false"
        class="w-full bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
        placeholder="2026-08-09 14:30:00"
        @input="convertDate"
      />
      <div
        v-if="dateResult"
        class="bg-surface border border-base rounded p-3 mt-2 space-y-1 text-xs"
      >
        <div>
          ms: <strong class="text-green-500">{{ dateResult.ms }}</strong>
        </div>
        <div class="text-muted">s: {{ dateResult.s }}</div>
      </div>
      <p v-else-if="dateError" class="text-xs text-red-500 mt-2">⚠ {{ dateError }}</p>
    </div>
  </div>
</template>
