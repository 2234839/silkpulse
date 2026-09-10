<script setup lang="ts">
/**
 * CookieTool —— Cookie 解析器（ToolsPanel 的 Cookie 页签）
 *
 * 自动识别 document.cookie（分号分隔）与 Set-Cookie 头（逐行）两种格式；
 * Set-Cookie 条目展开 Path/Domain/Expires/Max-Age/SameSite/Secure/HttpOnly 属性，
 * Expires 过期状态随父组件时钟自动判定。
 */
import { ref, computed } from "vue";
import { useCopyFlash } from "../../composables/useCopyFlash";
import ToolSplitLayout from "./ToolSplitLayout.vue";

/** 工具箱复制按钮的统一「✓ 已复制」反馈（key 前缀 cookie:） */
const { copiedKey, copy: copyWithFlash } = useCopyFlash();

/** 父组件注入的响应式当前时间戳（ms），驱动过期状态随时间自动变化 */
const props = defineProps<{ now: number }>();

const cookieInput = ref("");

/** 单条 Cookie 解析结果 */
interface CookieEntry {
  /** Cookie 名 */
  name: string;
  /** Cookie 值（尝试 decodeURIComponent，失败显示原值） */
  value: string;
  /** 是否为 Set-Cookie 格式（带属性） */
  isSetCookie: boolean;
  /** Path 属性 */
  path: string;
  /** Domain 属性 */
  domain: string;
  /** Expires 属性原始值 */
  expiresRaw: string;
  /** Expires 是否已过期；null 表示无 Expires */
  expired: boolean | null;
  /** 过期时间的本地展示 */
  expiresLocal: string;
  /** Max-Age 属性 */
  maxAge: string;
  /** SameSite 属性 */
  sameSite: string;
  /** Secure 属性 */
  secure: boolean;
  /** HttpOnly 属性 */
  httpOnly: boolean;
}

/** 自动识别格式并解析全部 Cookie */
const cookieEntries = computed<CookieEntry[] | null>(() => {
  const raw = cookieInput.value.trim();
  if (!raw) return null;
  const safeDecode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  /** 是否为 Set-Cookie 格式：含 Path=/ Domain= Expires= 等属性关键字 */
  const isSetCookie = lines.some((l) =>
    /(^;\s*|;\s*)(Path|Domain|Expires|Max-Age|SameSite|Secure|HttpOnly)\s*(=|$)/i.test(l),
  );
  const segments = isSetCookie
    ? raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : raw.split(";");
  const entries: CookieEntry[] = [];
  for (const seg of segments) {
    const parts = seg
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    const eq = parts[0].indexOf("=");
    if (eq === -1) continue;
    const entry: CookieEntry = {
      name: safeDecode(parts[0].slice(0, eq).trim()),
      value: safeDecode(parts[0].slice(eq + 1).trim()),
      isSetCookie,
      path: "",
      domain: "",
      expiresRaw: "",
      expired: null,
      expiresLocal: "",
      maxAge: "",
      sameSite: "",
      secure: false,
      httpOnly: false,
    };
    for (const attr of parts.slice(1)) {
      const aeq = attr.indexOf("=");
      const key = (aeq === -1 ? attr : attr.slice(0, aeq)).trim().toLowerCase();
      const val = aeq === -1 ? "" : attr.slice(aeq + 1).trim();
      if (key === "path") entry.path = val;
      else if (key === "domain") entry.domain = val;
      else if (key === "max-age") entry.maxAge = val;
      else if (key === "samesite") entry.sameSite = val;
      else if (key === "secure") entry.secure = true;
      else if (key === "httponly") entry.httpOnly = true;
      else if (key === "expires") {
        entry.expiresRaw = val;
        const d = new Date(val);
        if (!isNaN(d.getTime())) {
          entry.expired = d.getTime() < props.now;
          entry.expiresLocal = d.toLocaleString("zh-CN");
        }
      }
    }
    entries.push(entry);
  }
  return entries.length > 0 ? entries : null;
});
</script>

<template>
  <ToolSplitLayout storage-key="silkpulse.tools-split.cookie" :initial-width="400" :max-width="640">
    <template #left>
      <div class="flex flex-col gap-2 min-w-0 h-full">
        <label class="text-xs text-muted"
          >Cookie（document.cookie 或 Set-Cookie 头，自动识别）</label
        >
        <textarea
          v-model="cookieInput"
          rows="12"
          spellcheck="false"
          class="flex-1 w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          :placeholder="'a=1; b=%E4%B8%AD\n或每行一条 Set-Cookie：\ntoken=abc123; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT; SameSite=Lax'"
        ></textarea>
      </div>
    </template>
    <template #right>
      <div class="flex-1 overflow-auto min-w-0 h-full">
        <template v-if="cookieEntries">
          <div class="text-xs text-muted">
            共 {{ cookieEntries.length }} 条 · 格式：{{
              cookieEntries[0].isSetCookie ? "Set-Cookie" : "document.cookie"
            }}
          </div>
          <div
            v-for="(c, i) in cookieEntries"
            :key="i"
            class="bg-surface border border-base rounded p-3 space-y-1.5 text-xs"
          >
            <div class="flex items-center gap-2">
              <span class="font-mono text-purple-500 break-all">{{ c.name }}</span>
              <span class="text-muted">=</span>
              <span class="font-mono text-primary break-all flex-1">{{ c.value }}</span>
              <button
                @click="copyWithFlash('cookie-' + i, `${c.name}=${c.value}`)"
                class="px-2 py-0.5 rounded border flex-shrink-0"
                :class="
                  copiedKey === 'cookie-' + i
                    ? 'border-green-500 text-green-500'
                    : 'border-base text-muted hover:border-blue-500 hover:text-primary'
                "
              >
                {{ copiedKey === "cookie-" + i ? "✓ 已复制" : "复制" }}
              </button>
            </div>
            <template v-if="c.isSetCookie">
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-muted border-t border-base/30 pt-1.5">
                <span v-if="c.path"
                  >Path: <span class="text-primary">{{ c.path }}</span></span
                >
                <span v-if="c.domain"
                  >Domain: <span class="text-primary">{{ c.domain }}</span></span
                >
                <span v-if="c.maxAge"
                  >Max-Age: <span class="text-primary">{{ c.maxAge }}</span></span
                >
                <span v-if="c.sameSite"
                  >SameSite: <span class="text-primary">{{ c.sameSite }}</span></span
                >
                <span v-if="c.secure" class="text-green-500">Secure</span>
                <span v-if="c.httpOnly" class="text-green-500">HttpOnly</span>
              </div>
              <div v-if="c.expiresRaw" class="flex items-center gap-2">
                <span class="text-muted">Expires: {{ c.expiresLocal }}（{{ c.expiresRaw }}）</span>
                <span v-if="c.expired" class="text-red-500 font-semibold">已过期</span>
                <span v-else class="text-green-500 font-semibold">有效</span>
              </div>
            </template>
          </div>
        </template>
        <div v-else class="text-xs text-faint">粘贴 Cookie 后自动解析...</div>
      </div>
    </template>
  </ToolSplitLayout>
</template>
