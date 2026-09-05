<script setup lang="ts">
/**
 * SecretText —— 敏感文本模糊组件
 *
 * 将文本（或文本中的敏感子串）模糊化，用户点击后才显示明文。
 * 用于保护 API Key 等敏感信息不被直接展示/被旁观者看到。
 *
 * 用法：
 *   1. 整段模糊：<SecretText text="sk-xxxx" />
 *   2. 模糊指定子串：<SecretText :text="prompt" :secret="apiKey" />
 *   3. 正则匹配模糊：<SecretText :text="url" :pattern="/key=[a-z0-9]{8,}/gi" />
 *   4. 自动探测（内置常见密钥形态）：<SecretText :text="text" auto />
 *
 * secret / pattern / auto 可组合使用，命中的区段全部模糊。
 */
import { computed, ref } from "vue";

const props = defineProps<{
  /** 要展示的文本 */
  text: string;
  /** 需要模糊的子串（如 apiKey）；不传则看 pattern/auto */
  secret?: string;
  /** 正则匹配的敏感片段（模糊所有命中项） */
  pattern?: RegExp;
  /** 开启内置自动探测：key=xxx / token=xxx / sk-xxx / Bearer xxx 等常见密钥形态 */
  auto?: boolean;
}>();

/** 内置密钥形态探测规则 */
const AUTO_PATTERN =
  /(?:key|token|secret|password|pwd)=?[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}/gi;

/** 是否已揭示明文 */
const revealed = ref(false);

/** 点击切换揭示状态 */
function toggle() {
  revealed.value = !revealed.value;
}

/** 掩码区段 [start, end) */
interface MaskRange {
  start: number;
  end: number;
}

/** 收集所有敏感区段（secret 子串 + 正则命中 + 自动探测），合并重叠 */
const maskRanges = computed<MaskRange[]>(() => {
  const ranges: MaskRange[] = [];
  const text = props.text;

  const secret = props.secret?.trim();
  if (secret && secret.length >= 4) {
    let idx = text.indexOf(secret);
    while (idx !== -1) {
      ranges.push({ start: idx, end: idx + secret.length });
      idx = text.indexOf(secret, idx + secret.length);
    }
  }

  const patterns: RegExp[] = [];
  if (props.pattern) patterns.push(props.pattern);
  if (props.auto) patterns.push(AUTO_PATTERN);
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      ranges.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  /** 按起点排序并合并重叠区段 */
  ranges.sort((a, b) => a.start - b.start);
  const merged: MaskRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
});

/** 文本分段：敏感区段 masked=true，其余正常 */
const segments = computed<{ value: string; masked: boolean }[]>(() => {
  const ranges = maskRanges.value;
  if (ranges.length === 0) {
    return [{ value: props.text, masked: false }];
  }
  const result: { value: string; masked: boolean }[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) result.push({ value: props.text.slice(cursor, r.start), masked: false });
    result.push({ value: props.text.slice(r.start, r.end), masked: true });
    cursor = r.end;
  }
  if (cursor < props.text.length) result.push({ value: props.text.slice(cursor), masked: false });
  return result;
});

/** 无任何命中时退化为整段模糊（防止调用方漏传匹配规则导致明文直出） */
const wholeMasked = computed(() => maskRanges.value.length === 0);
</script>

<template>
  <span class="secret-text inline cursor-pointer" title="点击查看/隐藏明文" @click="toggle">
    <template v-if="wholeMasked">
      <!-- 整段模糊模式 -->
      <span
        class="transition-[filter] duration-150"
        :class="revealed ? '' : 'blur-[5px] select-none'"
        >{{ props.text }}</span
      >
    </template>
    <template v-else>
      <!-- 局部模糊模式：仅命中区段模糊 -->
      <template v-for="(seg, i) in segments" :key="i">
        <span v-if="!seg.masked">{{ seg.value }}</span>
        <span
          v-else
          class="transition-[filter] duration-150"
          :class="revealed ? '' : 'blur-[5px] select-none'"
          >{{ seg.value }}</span
        >
      </template>
    </template>
    <span v-if="!revealed" class="text-muted text-[10px] ml-1 align-middle">🔒 点击查看</span>
  </span>
</template>
