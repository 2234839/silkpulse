<script setup lang="ts">
/**
 * 鉴权登录页
 *
 * 输入超管密钥或项目密钥，验证通过后进入控制台。
 */
import { ref } from 'vue'

const emit = defineEmits<{
  /** 验证成功 */
  success: []
}>()

/** 密钥输入 */
const authKeyInput = ref('')
/** 错误信息 */
const authError = ref('')
/** 加载中 */
const authLoading = ref(false)

/** 由父组件提供验证逻辑（因为 saveKey/verifyKey/connect 都在父级） */
const props = defineProps<{
  /** 父级提供的验证函数，返回 true=成功 */
  onVerify: (key: string) => Promise<boolean>
}>()

async function submitAuth() {
  if (!authKeyInput.value.trim()) return
  authLoading.value = true
  authError.value = ''
  try {
    const ok = await props.onVerify(authKeyInput.value.trim())
    if (!ok) {
      authError.value = '密钥无效，请检查后重试'
      return
    }
    authKeyInput.value = ''
    emit('success')
  } catch {
    authError.value = '网络错误，请检查服务器连接'
  } finally {
    authLoading.value = false
  }
}
</script>

<template>
  <div class="h-screen flex items-center justify-center bg-gray-900 text-white">
    <div class="w-96 max-w-full mx-4 space-y-6">
      <div class="text-center">
        <div class="text-5xl mb-3">🔐</div>
        <h1 class="text-2xl font-bold mb-1">clarosight</h1>
        <p class="text-gray-400 text-sm">输入密钥以访问控制台</p>
      </div>
      <div class="space-y-3">
        <input
          v-model="authKeyInput"
          type="password"
          placeholder="超管密钥或项目密钥"
          class="w-full px-4 py-3 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 focus:outline-none text-sm"
          @keydown.enter="submitAuth"
          :disabled="authLoading"
        />
        <button
          @click="submitAuth"
          :disabled="authLoading || !authKeyInput.trim()"
          class="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg font-medium text-sm transition"
        >{{ authLoading ? '验证中...' : '登录' }}</button>
        <p v-if="authError" class="text-red-400 text-sm text-center">{{ authError }}</p>
      </div>
      <p class="text-xs text-gray-500 text-center leading-relaxed">
        超管密钥可查看所有项目和设备<br/>
        项目密钥只能查看对应项目的设备<br/>
        <span class="text-gray-600">密钥安全存储在浏览器本地</span>
      </p>
    </div>
  </div>
</template>
