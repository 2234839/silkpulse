<script setup lang="ts">
/**
 * 接入代码面板
 *
 * 展示四种接入方式（Script 标签 / IIFE / Bookmarklet / Userscript）的代码 + 复制按钮。
 * 既用于未选设备时的空状态卡片，也用于"接入新设备"弹窗。
 *
 * 设备接入凭 projectId：项目密钥登录用自己项目的；超管不属于任何单一项目，
 * 但能看到全部项目——拉取列表让超管选择设备要接入哪个项目。
 */
import { ref, computed, watch } from "vue";
import { useAuth } from "../composables/useAuth";
import { copyText } from "../utils/clipboard";
import { apiFetch } from "../utils/api";

const props = defineProps<{
  /** 是否显示关闭按钮（Modal 模式） */
  closable?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const { authStatus, userRole, projectId } = useAuth();

const serverOrigin = location.origin;

/** 项目公开信息（超管拉取项目列表用） */
interface ProjectPublic {
  id: string;
  name: string;
  enabled: boolean;
}

/** 超管可见的项目列表 */
const adminProjects = ref<ProjectPublic[]>([]);
/** 超管当前选中的项目（注入代码归属） */
const adminSelectedProjectId = ref<string>("");

/** 拉取项目列表（仅超管，供可选归组） */
async function loadAdminProjects(): Promise<void> {
  try {
    const res = await apiFetch("/api/projects");
    if (!res.ok) return;
    const data = (await res.json()) as { projects: ProjectPublic[] };
    adminProjects.value = data.projects;
    /** 默认未分组（全局设备）；仅当选中的项目从列表消失时才重置 */
    const stillThere =
      adminSelectedProjectId.value === "" ||
      data.projects.some((p) => p.id === adminSelectedProjectId.value);
    if (!stillThere) adminSelectedProjectId.value = "";
  } catch {
    /** 面板照常展示，只是没有项目可选 */
  }
}

watch(
  () => userRole.value,
  (role) => {
    if (role === "admin") void loadAdminProjects();
  },
  { immediate: true },
);

/**
 * 注入代码归属的项目 ID：
 * - 项目密钥登录：自己项目的（verify 返回）
 * - 超管：下拉选择，默认 ""（未分组，设备全局可见，不借用任何项目）
 * - 未启用鉴权：无需 projectId
 */
const injectProjectId = computed(() => {
  if (!authStatus.value?.authEnabled) return undefined;
  if (userRole.value === "project") return projectId.value;
  if (userRole.value === "admin") return adminSelectedProjectId.value || undefined;
  return undefined;
});

/**
 * script 标签方式（前端自己拼，最简单）
 * ⚠️ 不能直接写 HTML 标签字符串字面量（含尖括号）：
 * Vue SFC 解析器会误认为 script 块结束。用 String.fromCharCode 绕开。
 */
const scriptSnippet = computed(() => {
  const lt = String.fromCharCode(60);
  const gt = String.fromCharCode(62);
  const base = `${lt}script src="${serverOrigin}/sdk.js" data-server="${serverOrigin}"`;
  /** 归属项目时带 projectId（公开标识，可外发）；未分组/未启用鉴权不带也能接入 */
  if (injectProjectId.value) {
    return `${base} data-project-id="${injectProjectId.value}"${gt}${lt}/script${gt}`;
  }
  return `${base}${gt}${lt}/script${gt}`;
});

/**
 * 注入器核心 JS：往当前页面塞一个带 data-server 的 sdk.js script 标签
 * 防重复注入（同页面多次点 bookmarklet 只生效一次）
 * 设备接入凭 projectId（公开标识，非密钥）——注入代码可安全发给任意第三方
 */
const injectScriptCode = computed(() => {
  const dataAttrs = [
    `s.dataset.server='${serverOrigin}'`,
    injectProjectId.value ? `s.dataset.projectId='${injectProjectId.value}'` : "",
  ]
    .filter(Boolean)
    .join(";");
  return `(function(){var k='__silkpulse_injected__';if(window[k])return;window[k]=1;var s=document.createElement('script');s.src='${serverOrigin}/sdk.js';${dataAttrs};document.head.appendChild(s);})();`;
});

/** IIFE 立即执行：F12 console 粘贴即注入 */
const iifeSnippet = computed(() => injectScriptCode.value);

/** Bookmarklet：拖到书签栏，在任意页面点击即注入 */
const bookmarkletSnippet = computed(
  () => `javascript:${encodeURIComponent(injectScriptCode.value)}`,
);

/** Tampermonkey/Greasemonkey userscript —— 自动匹配所有页面注入 */
const userscriptSnippet = computed(() => {
  const code = injectScriptCode.value;
  return `// ==UserScript==
// @name         silkpulse 远程调试注入
// @namespace    silkpulse
// @version      0.1.0
// @description  自动注入 silkpulse SDK，将当前页面接入远程调试
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==
(function(){${code}})();
`;
});

type InjectTab = "script" | "iife" | "bookmarklet" | "userscript";
const injectTab = ref<InjectTab>("script");
const copyingInject = ref<InjectTab | null>(null);

const currentInjectSnippet = computed(() => {
  if (injectTab.value === "script") return scriptSnippet.value;
  if (injectTab.value === "iife") return iifeSnippet.value;
  if (injectTab.value === "bookmarklet") return bookmarkletSnippet.value;
  return userscriptSnippet.value;
});

/** 场景说明文案 */
const scenarioText = computed(() => {
  const map: Record<InjectTab, string> = {
    script: "适合：能改源码的项目（自己的网站 / App）",
    iife: "适合：临时调试某个页面，F12 打开 console 粘贴即注入",
    bookmarklet: "适合：改不了源码的线上站，临时接入一次",
    userscript: "适合：长期调试某个站，Tampermonkey 自动注入",
  };
  return map[injectTab.value];
});

/** 粘贴位置说明 */
const locationText = computed(() => {
  const map: Record<InjectTab, string> = {
    script:
      "→ 粘贴到目标页面的 HTML 里（如 index.html 的 <head> 或 <body> 顶部），重新部署/刷新即接入",
    iife: "→ F12 打开目标页面的 DevTools console，粘贴上面代码回车即注入（页面刷新后失效）",
    bookmarklet: "→ 复制后新建书签，URL 粘贴为上面的代码；在目标页面点这个书签即注入",
    userscript: "→ 粘贴到 Tampermonkey/Greasemonkey 新建的脚本里，保存后自动在所有页面生效",
  };
  return map[injectTab.value];
});

async function copyInject() {
  const code = currentInjectSnippet.value;
  if (!code) return;
  const ok = await copyText(code);
  if (ok) {
    copyingInject.value = injectTab.value;
    setTimeout(() => {
      if (copyingInject.value === injectTab.value) copyingInject.value = null;
    }, 1500);
  }
}
</script>

<template>
  <div>
    <!-- Modal 头部（仅 closable 模式） -->
    <div v-if="closable" class="flex items-center justify-between px-5 py-3 border-b border-base">
      <h3 class="text-sm font-semibold text-primary">接入新设备</h3>
      <button
        @click="emit('close')"
        class="px-3 py-1 text-xs rounded bg-elevated text-secondary bg-elevated-hover"
      >
        关闭
      </button>
    </div>

    <div :class="closable ? 'flex-1 overflow-y-auto p-5' : ''">
      <!-- Tab 切换 -->
      <div class="flex gap-1 mb-3 border-b border-light">
        <button
          v-for="tab in ['script', 'iife', 'bookmarklet', 'userscript'] as const"
          :key="tab"
          @click="injectTab = tab"
          class="px-3 py-1.5 text-xs font-medium border-b-2 -mb-px"
          :class="
            injectTab === tab
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-muted hover:text-primary'
          "
        >
          {{
            tab === "script"
              ? "Script 标签"
              : tab === "iife"
                ? "IIFE 立即执行"
                : tab === "bookmarklet"
                  ? "Bookmarklet"
                  : "Userscript"
          }}
        </button>
      </div>

      <p class="text-xs text-muted mb-2">{{ scenarioText }}</p>

      <!-- 超管：选择设备归属（默认未分组，全局可见；需要归组管理时再选项目） -->
      <div
        v-if="authStatus?.authEnabled && userRole === 'admin'"
        class="flex items-center gap-2 mb-3"
      >
        <label class="text-xs text-secondary shrink-0">设备归属</label>
        <select
          v-model="adminSelectedProjectId"
          class="px-2 py-1 text-xs rounded border border-input bg-elevated text-primary"
        >
          <option value="">未分组（全局可见）</option>
          <option v-for="p in adminProjects" :key="p.id" :value="p.id" :disabled="!p.enabled">
            {{ p.name }}（{{ p.id }}）{{ p.enabled ? "" : " · 已停用" }}
          </option>
        </select>
      </div>

      <div class="relative">
        <pre
          class="bg-base border border-input rounded p-3 pr-16 text-[11px] font-mono text-primary overflow-x-auto whitespace-pre-wrap break-all max-h-48"
          >{{ currentInjectSnippet || "加载中..." }}</pre>
        <button
          @click="copyInject"
          :disabled="!currentInjectSnippet"
          class="absolute top-2 right-2 px-2 py-1 text-[10px] font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {{ copyingInject === injectTab ? "✓ 已复制" : "复制" }}
        </button>
      </div>

      <p class="text-[11px] text-faint mt-2">{{ locationText }}</p>
    </div>
  </div>
</template>
