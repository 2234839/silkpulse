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

const emit = defineEmits<{ close: []; goCreateProject: [] }>();

const { authStatus, userRole, projectId, isPlayground } = useAuth();

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

/** 注入代码归属的项目 ID：
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

/** 设备接入令牌（防伪造设备混入项目）：归属项目时拉取，拼进接入代码 */
const deviceToken = ref<string>("");

async function loadDeviceToken(): Promise<void> {
  if (!injectProjectId.value) {
    deviceToken.value = "";
    return;
  }
  try {
    const q = userRole.value === "admin" ? `?projectId=${injectProjectId.value}` : "";
    const res = await apiFetch(`/api/device-token${q}`);
    if (!res.ok) return;
    const data = (await res.json()) as { token?: string };
    deviceToken.value = data.token ?? "";
  } catch {
    /** 拉不到令牌时仍生成只带 projectId 的代码（设备会降级为未分组） */
  }
}

watch(injectProjectId, () => void loadDeviceToken(), { immediate: true });

/** 是否开启 Alt 点选元素（Element Picker）：开启后页面上 Alt+点击任意元素可弹出定位信息并复制发给 AI */
const elementPicker = ref(false);

/** 是否开启悬浮球（默认开启）：展示调试状态 + 拖出选元素联动控制台 Element 面板 */
const floatingBall = ref(true);

/**
 * script 标签方式（前端自己拼，最简单）
 * ⚠️ 不能直接写 HTML 标签字符串字面量（含尖括号）：
 * Vue SFC 解析器会误认为 script 块结束。用 String.fromCharCode 绕开。
 */
const scriptSnippet = computed(() => {
  const lt = String.fromCharCode(60);
  const gt = String.fromCharCode(62);
  const base = `${lt}script src="${serverOrigin}/sdk.js" data-server="${serverOrigin}"`;
  /** 归属项目时带 projectId + 设备令牌；未分组/未启用鉴权不带也能接入 */
  let s = injectProjectId.value
    ? `${base} data-project-id="${injectProjectId.value}" data-device-token="${deviceToken.value}"`
    : base;
  /** Alt 点选元素（Element Picker）开关 */
  if (elementPicker.value) s += " data-element-picker=1";
  /** 悬浮球开关：仅关闭时输出 data-floating-ball=0，保持默认片段简洁 */
  if (!floatingBall.value) s += ' data-floating-ball="0"';
  return `${s}${gt}${lt}/script${gt}`;
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
    injectProjectId.value && deviceToken.value
      ? `s.dataset.deviceToken='${deviceToken.value}'`
      : "",
    elementPicker.value ? "s.dataset.elementPicker='1'" : "",
    floatingBall.value ? "" : "s.dataset.floatingBall='0'",
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

/**
 * Tampermonkey userscript —— 自动匹配所有页面注入
 *
 * GM_addElement 特权注入免疫页面 CSP script-src；内置 GM 桥接宿主后，
 * SDK 与 server 的通信（含 WebSocket 语义的指令通道）全部由
 * GM_xmlhttpRequest（register/uplink POST + stream SSE）承载，
 * connect-src 限制的强 CSP 站也能全功能接入。
 * 宿主标记写在 <html data-silkpulse-bridge>（DOM 跨沙箱与页面共享，
 * window 属性在隔离世界不互通）。需 Tampermonkey 或 ScriptCat（脚本猫），
 * Violentmonkey 缺这两个 GM API。
 */
const userscriptSnippet = computed(() => {
  const dataAttrs = [
    `'data-server': '${serverOrigin}'`,
    injectProjectId.value ? `'data-project-id': '${injectProjectId.value}'` : "",
    elementPicker.value ? `'data-element-picker': '1'` : "",
    floatingBall.value ? "" : `'data-floating-ball': '0'`,
  ]
    .filter(Boolean)
    .join(",\n    ");
  const projectIdQs = injectProjectId.value
    ? `&projectId=${encodeURIComponent(injectProjectId.value)}`
    : "";
  let connectHost = "*";
  try {
    connectHost = new URL(serverOrigin).host;
  } catch {
    connectHost = "*";
  }
  return `// ==UserScript==
// @name         silkpulse 远程调试注入
// @namespace    silkpulse
// @version      0.3.0
// @description  自动注入 silkpulse SDK 并内置 GM 桥接宿主，强 CSP 页面（script-src/connect-src 均限制）也可全功能远程调试
// @match        *://*/*
// @grant        GM_addElement
// @grant        GM_xmlhttpRequest
// @connect      ${connectHost}
// @run-at       document-idle
// ==/UserScript==
(function () {
  var ORIGIN = '${serverOrigin}';
  var QS = '?bridge=1${projectIdQs}';

  /** 桥接宿主标记：<html data-silkpulse-bridge="1">（DOM 跨世界共享，SDK 据此切 bridge 传输） */
  document.documentElement.setAttribute('data-silkpulse-bridge', '1');

  /** ---------- 桥接宿主：GM_xmlhttpRequest 承载 server 通信 ---------- */
  var session = null; // { id, token, alive, flushTimer, uplinkBuf: [], streamOffset, streamBuf }
  var pageAlive = false; // 页面侧 BridgeSocket 是否在场

  function toPage(msg) {
    try { window.postMessage(msg, window.location.origin); } catch (e) { /* 页面即将卸载等场景忽略 */ }
  }
  function notifyPage(event, data) {
    toPage({ __silkpulseHost: true, event: event, data: data });
  }

  function gm(opts) {
    opts.url = ORIGIN + opts.url;
    opts.headers = opts.headers || {};
    if (opts.data) opts.headers['Content-Type'] = 'application/json';
    opts.timeout = opts.timeout || 15000;
    GM_xmlhttpRequest(opts);
  }

  /** 销毁当前会话；notify=false 时静默销毁（页面重连重建场景，不能向新 BridgeSocket 发 close） */
  function dropSession(notify) {
    if (!session) return;
    var s = session;
    session = null;
    s.alive = false;
    if (s.flushTimer) clearTimeout(s.flushTimer);
    if (notify !== false && pageAlive) notifyPage('close');
  }

  /** 建立桥接会话：先 POST register（空消息），SDK 的 register 随后经 uplink 到达 */
  function createSession() {
    dropSession(false);
    gm({
      method: 'POST',
      url: '/ws/device-bridge/register' + QS,
      data: JSON.stringify({ messages: [] }),
      onload: function (res) {
        if (res.status !== 200) { retryLater(); return; }
        var data;
        try { data = JSON.parse(res.responseText); } catch (e) { retryLater(); return; }
        session = {
          id: data.bridgeId, token: data.token, alive: true,
          flushTimer: null, uplinkBuf: [], streamOffset: 0, streamBuf: ''
        };
        /** SSE 下行流：onprogress 增量解析 data: 帧（需 TM ≥ 4.10 流式响应） */
        gm({
          method: 'GET',
          timeout: 0,
          url: '/ws/device-bridge/stream?bridgeId=' + data.bridgeId + '&token=' + data.token,
          onprogress: function (res) {
            if (!session) return;
            var text = res.responseText.slice(session.streamOffset);
            session.streamOffset = res.responseText.length;
            session.streamBuf += text;
            var frames = session.streamBuf.split('\\n\\n');
            session.streamBuf = frames.pop();
            for (var i = 0; i < frames.length; i++) {
              var line = frames[i];
              if (line.indexOf('data: ') === 0) notifyPage('down', line.slice(6));
            }
          },
          onerror: function () { dropSession(true); },
          onabort: function () { dropSession(true); },
          onload: function () { dropSession(true); }
        });
        /** 建好会话即通知页面：BridgeSocket 转 OPEN，SDK 开始发 register */
        if (pageAlive) notifyPage('open');
      },
      onerror: retryLater,
      ontimeout: retryLater
    });
  }

  /** 会话建立失败退避重试 */
  var retryCount = 0;
  function retryLater() {
    var delay = Math.min(1000 * Math.pow(2, retryCount++), 30000);
    setTimeout(function () {
      if (pageAlive) createSession();
    }, delay);
  }

  /** uplink 批量上行：50ms 聚合窗口，减少请求数 */
  function flushUplink() {
    if (!session || !session.alive) return;
    if (session.uplinkBuf.length === 0) return;
    var msgs = session.uplinkBuf;
    session.uplinkBuf = [];
    gm({
      method: 'POST',
      timeout: 10000,
      url: '/ws/device-bridge/uplink?bridgeId=' + session.id + '&token=' + session.token,
      data: JSON.stringify({ messages: msgs }),
      onload: function (res) {
        if (res.status === 404) dropSession(true); // 会话过期 → 页面重连重建
      },
      onerror: function () { dropSession(true); },
      ontimeout: function () { dropSession(true); }
    });
  }

  window.addEventListener('message', function (ev) {
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || d.__silkpulsePage !== true) return;
    if (d.cmd === 'init') {
      pageAlive = true;
      if (session && session.alive) { notifyPage('open'); return; }
      createSession();
      return;
    }
    if (d.cmd === 'close') { pageAlive = false; dropSession(true); return; }
    if (d.cmd === 'send' && session && session.alive && d.msgs) {
      for (var i = 0; i < d.msgs.length; i++) session.uplinkBuf.push(d.msgs[i]);
      if (!session.flushTimer) {
        session.flushTimer = setTimeout(function () {
          if (session) session.flushTimer = null;
          flushUplink();
        }, 50);
      }
    }
  });

  /** ---------- 注入 SDK（GM_addElement 特权通道，免疫页面 CSP script-src） ---------- */
  var k = '__silkpulse_injected__';
  if (window[k]) return;
  window[k] = 1;
  GM_addElement('script', {
    src: '${serverOrigin}/sdk.js',
    ${dataAttrs}
  });
})();
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
    userscript: "适合：长期调试某个站 / 强 CSP 站（含 connect-src 限制），需 Tampermonkey 或脚本猫（ScriptCat）",
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
    userscript:
      "→ 粘贴到 Tampermonkey / 脚本猫（ScriptCat）新建的脚本里，保存后自动在所有页面生效；GM_addElement 特权注入穿过 CSP script-src，内置 GM 桥接宿主用 GM_xmlhttpRequest 承载全部通信，connect-src 限制也不影响（需 Tampermonkey ≥ 4.10 或 ScriptCat）",
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
      <!-- 游客模式警示：Playground 数据全员可见，防信息泄露 -->
      <div
        v-if="isPlayground"
        class="mb-3 px-3 py-2 rounded border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950 text-xs text-amber-800 dark:text-amber-200"
      >
        <p class="font-semibold">⚠️ 游客模式：该设备对所有人可见</p>
        <p class="mt-1">
          Playground
          是公共项目，你接入设备的页面快照、console、网络请求（含响应体）等数据<b>所有访客都能看到</b>。
          <b>切勿接入有登录态或敏感信息的页面</b>。长期使用请<a
            href="#"
            class="underline font-medium"
            @click.prevent="emit('goCreateProject')"
            >创建我的项目 Key</a
          >，获得仅自己可见的私有项目（免费免注册，5 天有效）。
        </p>
      </div>
      <!-- Tab 切换 -->
      <div class="flex gap-1 mb-3 border-b border-light">
        <button
          v-for="tab in ['script', 'iife', 'bookmarklet', 'userscript'] as const"
          :key="tab"
          @click="injectTab = tab"
          class="px-3 py-1.5 text-xs font-medium border-b-2 -mb-px"
          :class="
            injectTab === tab
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
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

      <!-- Alt 点选元素开关：开启后接入片段带 data-element-picker -->
      <label
        class="flex items-center gap-2 mb-3 text-xs text-secondary cursor-pointer select-none"
        title="开启后，页面里按住 Alt 点击任意元素会弹出定位信息面板，可一键复制定位 + 提示词 + 接入调用方法发给 AI"
      >
        <input v-model="elementPicker" type="checkbox" class="accent-blue-600" />
        开启「Alt 点选元素」—— 选中页面元素后一键复制定位信息，发给 AI 直接指哪改哪
      </label>

      <!-- 悬浮球开关：默认开启 -->
      <label
        class="flex items-center gap-2 mb-3 text-xs text-secondary cursor-pointer select-none"
        title="开启后，接入页面右下角出现悬浮球：实时展示调试状态，拖住可联动控制台 Element 面板选元素"
      >
        <input v-model="floatingBall" type="checkbox" class="accent-blue-600" />
        开启「悬浮球」—— 页面右下角实时展示调试状态，拖出可联动选元素
      </label>

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
