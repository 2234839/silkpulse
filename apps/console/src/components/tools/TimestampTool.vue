<script setup lang="ts">
/**
 * TimestampTool —— 时间戳 ↔ 人类时间双向转换（ToolsPanel 的时间戳页签）
 *
 * 自动识别秒/毫秒时间戳；非法输入给红字错误提示而非静默；
 * 人类时间输入支持 Date 可解析的任意格式。
 */
import { ref } from "vue";
import { humanDuration } from "../../utils/json-tools";

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
    tsError.value = `「${raw}」不是合法的数字时间戳`;
    return;
  }
  let num = Number(raw);
  if (raw.length <= 10) num *= 1000;
  const d = new Date(num);
  if (isNaN(d.getTime())) {
    tsResult.value = null;
    tsError.value = `「${raw}」超出可表示的时间范围`;
    return;
  }
  tsError.value = "";
  const now = Date.now();
  const diff = now - num;
  const rel =
    diff > 0 ? `${humanDuration(Math.abs(diff))} 前` : `${humanDuration(Math.abs(diff))} 后`;
  tsResult.value = {
    local: d.toLocaleString("zh-CN"),
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
    dateError.value = `「${dateInput.value}」无法解析为日期`;
    return;
  }
  dateError.value = "";
  dateResult.value = { ms: d.getTime(), s: Math.floor(d.getTime() / 1000) };
}
</script>

<template>
  <div>
    <div>
      <label class="text-xs text-muted block mb-2">时间戳 → 人类时间</label>
      <div class="flex gap-2">
        <input
          v-model="tsInput"
          type="text"
          spellcheck="false"
          class="flex-1 bg-input border border-base rounded px-2 py-1.5 text-xs font-mono text-primary focus:outline-none focus:border-blue-500"
          placeholder="1691563200000 (ms) 或 1691563200 (s)"
          @input="convertTs"
        />
        <button
          @click="
            tsInput = String(Date.now());
            convertTs();
          "
          class="px-3 py-1.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          现在
        </button>
      </div>
      <div v-if="tsResult" class="bg-surface border border-base rounded p-3 mt-2 space-y-1 text-xs">
        <div>
          📅 <strong class="text-primary">{{ tsResult.local }}</strong>
        </div>
        <div class="text-muted">🌍 UTC: {{ tsResult.utc }}</div>
        <div class="text-muted">🌍 ISO: {{ tsResult.iso }}</div>
        <div class="text-muted">🕐 相对: {{ tsResult.relative }}</div>
      </div>
      <p v-else-if="tsError" class="text-xs text-red-500 mt-2">⚠ {{ tsError }}</p>
    </div>
    <div>
      <label class="text-xs text-muted block mb-2">人类时间 → 时间戳</label>
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
