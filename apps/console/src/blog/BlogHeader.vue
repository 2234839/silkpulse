<script setup lang="ts">
/**
 * BlogHeader —— blog 公共页头
 *
 * 比控制台 header 更轻：silkpulse 标识 + 返回控制台 + 亮/暗主题切换。
 * blog 是公开区域，不依赖鉴权/设备状态。
 */
import { useTheme } from '../composables/useTheme'

const { theme, toggleTheme } = useTheme()
</script>

<template>
  <header class="sticky top-0 z-40 bg-surface border-b border-base">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
      <router-link to="/blog" class="flex items-center gap-2 min-w-0">
        <span class="text-lg">🩺</span>
        <span class="text-sm font-semibold text-primary truncate">silkpulse <span class="text-muted font-normal">blog</span></span>
      </router-link>
      <div class="flex items-center gap-1 flex-shrink-0">
        <router-link
          to="/"
          class="px-3 py-1.5 text-xs font-medium rounded bg-teal-600 text-white hover:bg-teal-700 flex items-center gap-1"
          title="回到调试控制台"
        >🎯 控制台</router-link>
        <button
          @click="toggleTheme"
          class="px-2 py-1 text-xs rounded text-muted hover:text-primary hover:bg-elevated"
          :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'"
        >{{ theme === 'dark' ? '☀️' : '🌙' }}</button>
      </div>
    </div>
  </header>
</template>
