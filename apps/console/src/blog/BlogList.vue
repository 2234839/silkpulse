<script setup lang="ts">
/**
 * BlogList —— blog 列表页（/blog）
 *
 * 展示所有帖子的卡片：标题 / 日期 / 标签 / 摘要 / 阅读时长。
 * 外链帖子（externalUrl）在卡片右侧附二维码，方便手机扫码直达原文。
 * 帖子数据来自本地注册表（编译期集合，无后端依赖）。
 */
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import QRCode from "qrcode";
import { POSTS } from "./posts";
import BlogHeader from "./BlogHeader.vue";

const { t } = useI18n();

/** slug → 二维码 dataURL（仅外链帖子生成） */
const qrDataUrls = ref<Record<string, string>>({});

onMounted(async () => {
  for (const post of POSTS) {
    if (!post.externalUrl) continue;
    qrDataUrls.value[post.slug] = await QRCode.toDataURL(post.externalUrl, {
      margin: 1,
      width: 160,
      color: { dark: "#1a1f29", light: "#ffffff" },
    });
  }
});
</script>

<template>
  <div class="min-h-screen bg-base">
    <BlogHeader />

    <main class="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <!-- 站点介绍 -->
      <section class="mb-10">
        <h1 class="text-3xl font-bold text-primary mb-3">silkpulse blog</h1>
        <p class="text-secondary leading-relaxed">
          {{ t("blog.introPrefix")
          }}<strong class="text-primary">{{ t("blog.introHighlight") }}</strong
          >{{ t("blog.introSuffix") }}
        </p>
      </section>

      <!-- 帖子卡片列表 -->
      <div class="space-y-6">
        <article
          v-for="post in POSTS"
          :key="post.slug"
          class="bg-surface border border-base rounded-xl p-6 hover:border-blue-400/50 transition-colors"
        >
          <component
            :is="post.externalUrl ? 'a' : 'router-link'"
            :to="post.externalUrl ? undefined : `/blog/${post.slug}`"
            :href="post.externalUrl"
            :target="post.externalUrl ? '_blank' : undefined"
            :rel="post.externalUrl ? 'noopener' : undefined"
            class="group flex items-start gap-5"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-3 text-xs text-faint mb-2">
                <time :datetime="post.date">{{ post.date }}</time>
                <span>·</span>
                <span>{{ t("blog.readingTime", { minutes: post.readingMinutes }) }}</span>
              </div>
              <h2
                class="text-xl font-semibold text-primary group-hover:text-blue-400 transition-colors mb-2"
              >
                {{ post.title }}
              </h2>
              <p class="text-secondary text-sm leading-relaxed mb-4">{{ post.summary }}</p>
              <div class="flex items-center gap-2 flex-wrap">
                <span
                  v-for="tag in post.tags"
                  :key="tag"
                  class="px-2 py-0.5 text-xs rounded bg-elevated text-muted"
                  >#{{ tag }}</span
                >
                <span
                  v-if="post.externalUrl"
                  class="ml-auto text-xs text-blue-400 group-hover:underline"
                  >{{ t("blog.externalLink") }}</span
                >
              </div>
            </div>
            <!-- 手机扫码直达原文 -->
            <div v-if="post.externalUrl && qrDataUrls[post.slug]" class="shrink-0 text-center">
              <img
                :src="qrDataUrls[post.slug]"
                :alt="t('blog.qrAlt')"
                class="w-20 h-20 rounded-lg border border-base"
                width="80"
                height="80"
              />
              <p class="text-[10px] text-faint mt-1">{{ t("blog.qrHint") }}</p>
            </div>
          </component>
        </article>
      </div>
    </main>

    <footer class="max-w-3xl mx-auto px-4 sm:px-6 pb-10 text-center text-xs text-faint">
      <p>
        {{ t("blog.footerBrand") }}
        <router-link to="/" class="hover:text-primary underline underline-offset-2">{{
          t("blog.openConsole")
        }}</router-link>
      </p>
    </footer>
  </div>
</template>
