<script setup lang="ts">
/**
 * 接入代码面板
 *
 * 展示四种接入方式（Script 标签 / IIFE / Bookmarklet / Userscript）的代码 + 复制按钮。
 * 既用于未选设备时的空状态卡片，也用于"接入新设备"弹窗。
 */
import { ref, computed, watchEffect } from 'vue'
import { useAuth } from '../composables/useAuth'
import { copyText } from '../utils/clipboard'

const props = defineProps<{
  /** 是否显示关闭按钮（Modal 模式） */
  closable?: boolean
}>()

const emit = defineEmits<{ close: [] }>()

const { authStatus, userRole, projectId } = useAuth()

const serverOrigin = location.origin

/**
 * script 标签方式（前端自己拼，最简单）
 * ⚠️ 不能直接写 HTML 标签字符串字面量（含尖括号）：
 * Vue SFC 解析器会误认为 script 块结束。用 String.fromCharCode 绕开。
 */
const scriptSnippet = computed(() => {
  const lt = String.fromCharCode(60)
  const gt = String.fromCharCode(62)
  const base = `${lt}script src="${serverOrigin}/sdk.js" data-server="${serverOrigin}"`
  if (authStatus.value?.authEnabled) {
    /** 项目密钥登录：只带 projectId（设备端不需要密钥） */
    if (userRole.value === 'project' && projectId.value) {
      return `${base} data-project-id="${projectId.value}"${gt}${lt}/script${gt}`
    }
    return `${base} data-project-id="你的项目ID"${gt}${lt}/script${gt}`
  }
  return `${base}${gt}${lt}/script${gt}`
})

/** iife / bookmarklet / userscript 从 server 拉现成代码 */
const iifeSnippet = ref('')
const bookmarkletSnippet = ref('')
const userscriptSnippet = ref('')

/**
 * 拉取三种注入代码，项目密钥登录时自动带上 api_key + project_id 查询参数。
 * 用 watchEffect 让 userRole/apiKey/projectId 变化后自动重新拉取，
 * 保证四种方式始终统一：要么都带鉴权信息，要么都不带。
 */
watchEffect(() => {
  /** 项目密钥登录时只带 project_id（设备端不需要密钥，随便接入） */
  const params = new URLSearchParams()
  if (userRole.value === 'project' && projectId.value) {
    params.set('project_id', projectId.value)
  }
  const qs = params.toString()
  const suffix = qs ? `?${qs}` : ''

  fetch(`/inject/iife${suffix}`).then((r) => r.text()).then((t) => { iifeSnippet.value = t })
  fetch(`/inject/bookmarklet${suffix}`).then((r) => r.text()).then((t) => { bookmarkletSnippet.value = t })
  fetch(`/inject/userscript${suffix}`).then((r) => r.text()).then((t) => { userscriptSnippet.value = t })
})

type InjectTab = 'script' | 'iife' | 'bookmarklet' | 'userscript'
const injectTab = ref<InjectTab>('script')
const copyingInject = ref<InjectTab | null>(null)

const currentInjectSnippet = computed(() => {
  if (injectTab.value === 'script') return scriptSnippet.value
  if (injectTab.value === 'iife') return iifeSnippet.value
  if (injectTab.value === 'bookmarklet') return bookmarkletSnippet.value
  return userscriptSnippet.value
})

/** 场景说明文案 */
const scenarioText = computed(() => {
  const map: Record<InjectTab, string> = {
    script: '适合：能改源码的项目（自己的网站 / App）',
    iife: '适合：临时调试某个页面，F12 打开 console 粘贴即注入',
    bookmarklet: '适合：改不了源码的线上站，临时接入一次',
    userscript: '适合：长期调试某个站，Tampermonkey 自动注入',
  }
  return map[injectTab.value]
})

/** 粘贴位置说明 */
const locationText = computed(() => {
  const map: Record<InjectTab, string> = {
    script: '→ 粘贴到目标页面的 HTML 里（如 index.html 的 <head> 或 <body> 顶部），重新部署/刷新即接入',
    iife: '→ F12 打开目标页面的 DevTools console，粘贴上面代码回车即注入（页面刷新后失效）',
    bookmarklet: '→ 复制后新建书签，URL 粘贴为上面的代码；在目标页面点这个书签即注入',
    userscript: '→ 粘贴到 Tampermonkey/Greasemonkey 新建的脚本里，保存后自动在所有页面生效',
  }
  return map[injectTab.value]
})

async function copyInject() {
  const code = currentInjectSnippet.value
  if (!code) return
  const ok = await copyText(code)
  if (ok) {
    copyingInject.value = injectTab.value
    setTimeout(() => {
      if (copyingInject.value === injectTab.value) copyingInject.value = null
    }, 1500)
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
      >关闭</button>
    </div>

    <div :class="closable ? 'flex-1 overflow-y-auto p-5' : ''">
      <!-- Tab 切换 -->
      <div class="flex gap-1 mb-3 border-b border-light">
        <button
          v-for="tab in (['script', 'iife', 'bookmarklet', 'userscript'] as const)"
          :key="tab"
          @click="injectTab = tab"
          class="px-3 py-1.5 text-xs font-medium border-b-2 -mb-px"
          :class="injectTab === tab
            ? 'border-blue-500 text-blue-600'
            : 'border-transparent text-muted hover:text-primary'"
        >
          {{ tab === 'script' ? 'Script 标签' : tab === 'iife' ? 'IIFE 立即执行' : tab === 'bookmarklet' ? 'Bookmarklet' : 'Userscript' }}
        </button>
      </div>

      <p class="text-xs text-muted mb-2">{{ scenarioText }}</p>

      <div class="relative">
        <pre class="bg-base border border-input rounded p-3 pr-16 text-[11px] font-mono text-primary overflow-x-auto whitespace-pre-wrap break-all max-h-48">{{ currentInjectSnippet || '加载中...' }}</pre>
        <button
          @click="copyInject"
          :disabled="!currentInjectSnippet"
          class="absolute top-2 right-2 px-2 py-1 text-[10px] font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >{{ copyingInject === injectTab ? '✓ 已复制' : '复制' }}</button>
      </div>

      <p class="text-[11px] text-faint mt-2">{{ locationText }}</p>
    </div>
  </div>
</template>
