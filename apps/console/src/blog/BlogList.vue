<script setup lang="ts">
/**
 * BlogList —— blog 列表页（/blog）
 *
 * 展示所有帖子的卡片：标题 / 日期 / 标签 / 摘要 / 阅读时长。
 * 帖子数据来自本地注册表（编译期集合，无后端依赖）。
 */
import { POSTS } from './posts'
import BlogHeader from './BlogHeader.vue'
</script>

<template>
  <div class="min-h-screen bg-base">
    <BlogHeader />

    <main class="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <!-- 站点介绍 -->
      <section class="mb-10">
        <h1 class="text-3xl font-bold text-primary mb-3">silkpulse blog</h1>
        <p class="text-secondary leading-relaxed">
          关于 <strong class="text-primary">AI 原生远程调试</strong> 的实践笔记——
          让 AI agent 直接查看、诊断、操作运行在远程设备上的网页。
        </p>
      </section>

      <!-- 帖子卡片列表 -->
      <div class="space-y-6">
        <article
          v-for="post in POSTS"
          :key="post.slug"
          class="bg-surface border border-base rounded-xl p-6 hover:border-blue-400/50 transition-colors"
        >
          <router-link :to="`/blog/${post.slug}`" class="block group">
            <div class="flex items-center gap-3 text-xs text-faint mb-2">
              <time :datetime="post.date">{{ post.date }}</time>
              <span>·</span>
              <span>约 {{ post.readingMinutes }} 分钟</span>
            </div>
            <h2 class="text-xl font-semibold text-primary group-hover:text-blue-400 transition-colors mb-2">
              {{ post.title }}
            </h2>
            <p class="text-secondary text-sm leading-relaxed mb-4">{{ post.summary }}</p>
            <div class="flex items-center gap-2 flex-wrap">
              <span
                v-for="tag in post.tags"
                :key="tag"
                class="px-2 py-0.5 text-xs rounded bg-elevated text-muted"
              >#{{ tag }}</span>
            </div>
          </router-link>
        </article>
      </div>
    </main>

    <footer class="max-w-3xl mx-auto px-4 sm:px-6 pb-10 text-center text-xs text-faint">
      <p>silkpulse —— AI 原生的远程设备调试器 · <router-link to="/" class="hover:text-primary underline underline-offset-2">打开控制台</router-link></p>
    </footer>
  </div>
</template>
