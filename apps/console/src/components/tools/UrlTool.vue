<script setup lang="ts">
/**
 * UrlTool —— URL 解析器（ToolsPanel 的 URL 页签）
 *
 * 拆解 protocol/host/port/pathname/hash 与 query 参数表，
 * 每项支持单独复制（带「✓ 已复制」反馈）；非法 URL 给红字提示。
 */
import { ref, computed } from "vue";
import { useCopyFlash } from "../../composables/useCopyFlash";
import ToolSplitLayout from "./ToolSplitLayout.vue";

/** 工具箱复制按钮的统一「✓ 已复制」反馈（key 前缀 url:） */
const { copiedKey, copy: copyWithFlash } = useCopyFlash();

const urlInput = ref("");

/** 单项：标签 + 值 */
interface UrlPart {
  /** 展示标签 */
  label: string;
  /** 值 */
  value: string;
}

/** 解析出的 URL 各组成部分 */
const urlParts = computed<UrlPart[] | null>(() => {
  if (!urlInput.value.trim()) return null;
  try {
    const u = new URL(urlInput.value.trim());
    return [
      { label: "protocol", value: u.protocol },
      { label: "host", value: u.host },
      { label: "port", value: u.port || "(默认)" },
      { label: "pathname", value: u.pathname },
      { label: "hash", value: u.hash || "(空)" },
    ];
  } catch {
    return null;
  }
});

/** URL 是否格式非法（有输入但解析失败） */
const urlInvalid = computed(() => urlInput.value.trim() !== "" && urlParts.value === null);

/** query 参数行：key / value（decode 失败显示原值） */
const urlQueryRows = computed<{ key: string; value: string }[]>(() => {
  if (!urlParts.value) return [];
  const qs = urlInput.value.trim().split("?")[1]?.split("#")[0] ?? "";
  if (!qs) return [];
  return qs
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      const rawVal = eq === -1 ? "" : pair.slice(eq + 1);
      const safeDecode = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, " "));
        } catch {
          return s;
        }
      };
      return { key: safeDecode(rawKey), value: safeDecode(rawVal) };
    });
});
</script>

<template>
  <ToolSplitLayout storage-key="silkpulse.tools-split.url" :initial-width="400" :max-width="640">
    <template #left>
      <div class="flex flex-col gap-2 min-w-0 h-full">
        <label class="text-xs text-muted">URL</label>
        <textarea
          v-model="urlInput"
          rows="10"
          spellcheck="false"
          class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          placeholder="https://example.com:8080/api?foo=bar&name=%E4%B8%AD#top"
        ></textarea>
      </div>
    </template>
    <template #right>
      <div class="flex-1 overflow-auto min-w-0 h-full">
        <template v-if="urlInvalid">
          <div class="text-red-500 text-xs p-3 bg-red-500/10 border border-red-500/30 rounded">
            ⚠ 无法解析为 URL
          </div>
        </template>
        <template v-else-if="urlParts">
          <div class="bg-surface border border-base rounded p-3 space-y-2">
            <div v-for="p in urlParts" :key="p.label" class="flex items-center gap-2 text-xs">
              <span class="text-muted w-20 flex-shrink-0">{{ p.label }}</span>
              <span class="font-mono text-primary break-all flex-1">{{ p.value }}</span>
              <button
                @click="copyWithFlash('url-' + p.label, p.value)"
                class="px-2 py-0.5 text-xs rounded border flex-shrink-0"
                :class="
                  copiedKey === 'url-' + p.label
                    ? 'border-green-500 text-green-500'
                    : 'border-base text-muted hover:border-blue-500 hover:text-primary'
                "
              >
                {{ copiedKey === "url-" + p.label ? "✓ 已复制" : "复制" }}
              </button>
            </div>
          </div>
          <div v-if="urlQueryRows.length > 0">
            <label class="text-xs text-muted block mb-1">Query 参数</label>
            <div class="bg-surface border border-base rounded overflow-hidden">
              <table class="w-full text-xs">
                <thead>
                  <tr class="border-b border-base text-muted">
                    <th class="text-left px-3 py-2">Key</th>
                    <th class="text-left px-3 py-2">Value</th>
                    <th class="w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(row, i) in urlQueryRows"
                    :key="i"
                    class="border-b border-base/30 last:border-0"
                  >
                    <td class="px-3 py-1.5 font-mono text-purple-500 break-all">{{ row.key }}</td>
                    <td class="px-3 py-1.5 font-mono text-primary break-all">{{ row.value }}</td>
                    <td class="px-2">
                      <button
                        @click="copyWithFlash('urlq-' + i, row.value)"
                        class="px-2 py-0.5 text-xs rounded border"
                        :class="
                          copiedKey === 'urlq-' + i
                            ? 'border-green-500 text-green-500'
                            : 'border-base text-muted hover:border-blue-500 hover:text-primary'
                        "
                      >
                        {{ copiedKey === "urlq-" + i ? "✓" : "复制" }}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
        <div v-else class="text-xs text-faint">粘贴 URL 后自动解析...</div>
      </div>
    </template>
  </ToolSplitLayout>
</template>
