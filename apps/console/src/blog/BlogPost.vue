<script setup lang="ts">
/**
 * BlogPost —— blog 详情页（/blog/:slug）
 *
 * 根据 slug 从注册表找帖子，懒加载组件渲染正文。
 * 找不到时展示 404 提示 + 返回列表链接。
 */
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { POSTS } from './posts'
import BlogHeader from './BlogHeader.vue'

const route = useRoute()

/** 当前 slug 对应的帖子 meta（不存在为 null） */
const post = computed(() => POSTS.find((p) => p.slug === route.params.slug) ?? null)

/** 路由切换时滚动回顶部（同组件复用时 watch 生效） */
watch(() => route.fullPath, () => window.scrollTo(0, 0))
</script>

<template>
  <div class="min-h-screen bg-base">
    <BlogHeader />

    <!-- 帖子正文 -->
    <main v-if="post" class="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <!-- 文章头部信息 -->
      <header class="mb-8 pb-6 border-b border-base">
        <div class="flex items-center gap-3 text-xs text-faint mb-3">
          <time :datetime="post.date">{{ post.date }}</time>
          <span>·</span>
          <span>约 {{ post.readingMinutes }} 分钟</span>
        </div>
        <h1 class="text-3xl font-bold text-primary leading-tight mb-3">{{ post.title }}</h1>
        <div class="flex items-center gap-2 flex-wrap">
          <span
            v-for="tag in post.tags"
            :key="tag"
            class="px-2 py-0.5 text-xs rounded bg-elevated text-muted"
          >#{{ tag }}</span>
        </div>
      </header>

      <!-- 正文组件（懒加载） -->
      <component :is="post.component" />

      <!-- 底部导航 -->
      <footer class="mt-12 pt-6 border-t border-base flex items-center justify-between text-sm">
        <router-link to="/blog" class="text-blue-key hover:underline underline-offset-2">← 所有文章</router-link>
        <router-link to="/" class="text-muted hover:text-primary underline underline-offset-2">打开 silkpulse 控制台</router-link>
      </footer>
    </main>

    <!-- 404 -->
    <main v-else class="max-w-3xl mx-auto px-4 sm:px-6 py-20 text-center">
      <p class="text-5xl mb-4">🔍</p>
      <h1 class="text-xl font-semibold text-primary mb-2">文章不存在</h1>
      <p class="text-secondary text-sm mb-6">slug「{{ route.params.slug }}」没有对应的帖子。</p>
      <router-link to="/blog" class="inline-block px-4 py-2 rounded bg-teal-600 text-white text-sm hover:bg-teal-700">← 返回文章列表</router-link>
    </main>
  </div>
</template>
