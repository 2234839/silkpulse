<script setup lang="ts">
/**
 * AgentPromptModal —— 接入 AI Agent 弹窗
 *
 * 展示一段完整的 agent 提示词，包含 clarosight API 使用说明 + 当前服务地址 + API key。
 * 用户一键复制交给任意 AI agent（Cursor / Claude Code / ChatGPT 等），
 * agent 即可通过 HTTP API 查看在线设备、搜索日志、执行诊断代码。
 *
 * 提示词模板从 agent-prompt.md 以 ?raw 导入，
 * 运行时替换 __SERVER_URL__ / __API_KEY__ 占位符为实际值。
 */
import { computed, ref, watch } from 'vue'
import { copyText } from '../utils/clipboard'
import promptTemplate from '../assets/agent-prompt.md?raw'

const props = defineProps<{
  modelValue: boolean
  /** 当前服务访问地址（如 https://clarosight.heartstack.space） */
  serverUrl: string
  /** 当前用户的 API key（超管密钥或项目密钥） */
  apiKey: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const copyState = ref<'idle' | 'copied' | 'error'>('idle')

/** 替换模板占位符，生成最终提示词 */
const promptText = computed(() => {
  const key = props.apiKey || '<你的API密钥>'
  const origin = props.serverUrl || 'https://clarosight.heartstack.space'
  return promptTemplate
    .replaceAll('__SERVER_URL__', origin)
    .replaceAll('__API_KEY__', key)
})

async function handleCopy() {
  const ok = await copyText(promptText.value)
  copyState.value = ok ? 'copied' : 'error'
  if (ok) {
    setTimeout(() => { copyState.value = 'idle' }, 2000)
  }
}

/** 弹窗关闭时重置状态 */
watch(() => props.modelValue, (v) => {
  if (!v) copyState.value = 'idle'
})
</script>

<template>
  <div
    v-if="modelValue"
    class="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
    @click.self="emit('update:modelValue', false)"
  >
    <div class="bg-surface rounded-lg shadow-xl w-[760px] max-h-[85vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between px-5 py-3 border-b border-base">
        <div>
          <h3 class="text-sm font-semibold text-primary">🤖 接入 AI Agent</h3>
          <p class="text-xs text-muted mt-0.5">复制以下提示词，粘贴给你的 AI agent 即可开始远程调试</p>
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

      <!-- 提示词内容 -->
      <div class="flex-1 overflow-y-auto p-5">
        <pre class="text-xs font-mono text-primary whitespace-pre-wrap leading-relaxed">{{ promptText }}</pre>
      </div>

      <!-- 底部提示 -->
      <div class="px-5 py-2.5 border-t border-base bg-elevated/30">
        <p class="text-xs text-muted">
          💡 提示词包含服务地址 <code class="text-blue-500">{{ serverUrl }}</code> 和 API Key，
          agent 可直接通过 HTTP API 查看设备、搜索日志、执行代码。
        </p>
      </div>
    </div>
  </div>
</template>
