<script setup lang="ts">
/**
 * AgentPromptModal —— 接入 AI Agent 弹窗
 *
 * 提供两种接入方式：
 * 1. 渐进式加载 —— 极短系统提示词（~50 token），agent 按需 curl 拉取完整文档
 * 2. 完整提示词 —— 一键复制所有 API 文档，agent 直接全量加载
 *
 * 提示词模板来自 @clarosight/shared（服务端 + 控制台共用同一份）。
 */
import { computed, ref, watch } from 'vue'
import { copyText } from '../utils/clipboard'
import { renderSkillPrompt, renderSkillSystemPrompt } from '@clarosight/shared'

const props = defineProps<{
  modelValue: boolean
  /** 当前服务访问地址（如 https://clarosight.heartstack.space） */
  serverUrl: string
  /** 当前用户的 API key（超管密钥或项目密钥） */
  apiKey: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

/** 当前选中的 tab */
type Tab = 'full' | 'lazy'
const activeTab = ref<Tab>('lazy')

const copyState = ref<'idle' | 'copied' | 'error'>('idle')

/** 渲染完整提示词（替换占位符） */
const fullPrompt = computed(() => {
  const key = props.apiKey || '<你的API密钥>'
  const origin = props.serverUrl || 'https://clarosight.heartstack.space'
  return renderSkillPrompt(origin, key)
})

/** 渲染渐进式加载系统提示词 */
const lazyPrompt = computed(() => {
  const key = props.apiKey || '<你的API密钥>'
  const origin = props.serverUrl || 'https://clarosight.heartstack.space'
  return renderSkillSystemPrompt(origin, key)
})

/** 当前 tab 对应的提示词 */
const currentPrompt = computed(() => activeTab.value === 'full' ? fullPrompt.value : lazyPrompt.value)

async function handleCopy() {
  const ok = await copyText(currentPrompt.value)
  copyState.value = ok ? 'copied' : 'error'
  if (ok) {
    setTimeout(() => { copyState.value = 'idle' }, 2000)
  }
}

/** 切 tab 时重置复制状态 */
watch(activeTab, () => { copyState.value = 'idle' })

/** 弹窗关闭时重置状态 */
watch(() => props.modelValue, (v) => {
  if (!v) {
    copyState.value = 'idle'
    activeTab.value = 'lazy'
  }
})
</script>

<template>
  <div
    v-if="modelValue"
    class="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
    @click.self="emit('update:modelValue', false)"
  >
    <div class="bg-surface rounded-lg shadow-xl w-full max-w-[760px] mx-4 max-h-[85vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between px-5 py-3 border-b border-base">
        <div>
          <h3 class="text-sm font-semibold text-primary">🤖 接入 AI Agent</h3>
          <p class="text-xs text-muted mt-0.5">选择接入方式，复制提示词粘贴给你的 AI agent</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="handleCopy"
            class="px-3 py-1.5 text-xs rounded font-medium transition-colors"
            :class="copyState === 'copied'
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : copyState === 'error'
              ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
              : 'bg-blue-600 text-white hover:bg-blue-700'"
          >
            {{ copyState === 'copied' ? '✓ 已复制' : copyState === 'error' ? '复制失败' : '📋 复制提示词' }}
          </button>
          <button
            @click="emit('update:modelValue', false)"
            class="px-3 py-1.5 text-xs rounded bg-elevated text-secondary hover:bg-elevated-hover"
          >关闭</button>
        </div>
      </div>

      <!-- Tab 切换 -->
      <div class="flex gap-1 px-5 pt-3 border-b border-base">
        <button
          @click="activeTab = 'lazy'"
          class="px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px"
          :class="activeTab === 'lazy'
            ? 'border-blue-500 text-blue-600 dark:text-blue-400'
            : 'border-transparent text-muted hover:text-secondary'"
        >
          ⚡ 渐进式加载 <span class="text-muted/60">~50 token</span>
        </button>
        <button
          @click="activeTab = 'full'"
          class="px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px"
          :class="activeTab === 'full'
            ? 'border-blue-500 text-blue-600 dark:text-blue-400'
            : 'border-transparent text-muted hover:text-secondary'"
        >
          📄 完整提示词 <span class="text-muted/60">~600 token</span>
        </button>
      </div>

      <!-- 提示词内容 -->
      <div class="flex-1 overflow-y-auto p-5">
        <!-- 渐进式加载说明 -->
        <div v-if="activeTab === 'lazy'" class="mb-3 p-3 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <p class="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
            💡 将这段极短提示词写入 agent 的<strong>系统提示词</strong>（system prompt）。
            agent 会在需要远程调试时自动 curl 拉取完整文档，平时不占用 token。
          </p>
        </div>
        <pre class="text-xs font-mono text-primary whitespace-pre-wrap leading-relaxed">{{ currentPrompt }}</pre>
      </div>

      <!-- 底部提示 -->
      <div class="px-5 py-2.5 border-t border-base bg-elevated/30">
        <p class="text-xs text-muted">
          <template v-if="activeTab === 'lazy'">
            🚀 提示词中的 curl 地址指向
            <code class="text-blue-500">{{ serverUrl }}/api/skill/clarosight</code>，
            agent 按需拉取完整 API 文档。
          </template>
          <template v-else>
            💡 提示词包含服务地址 <code class="text-blue-500">{{ serverUrl }}</code> 和 API Key，
            agent 可直接通过 HTTP API 查看设备、搜索日志、执行代码。
          </template>
        </p>
      </div>
    </div>
  </div>
</template>
