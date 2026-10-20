/**
 * blog 帖子注册表
 *
 * 帖子即 Vue SFC（<script setup> + <template>），天然支持：
 * - markdown 风格排版（直接写模板结构，无解析器依赖）
 * - 内嵌交互 demo（帖子本身是组件，可挂任何交互）
 * - 代码高亮（用 <pre><code> + 少量样式约定）
 * - 懒加载：每篇帖子动态 import() 拆独立 chunk，访问该路由才下载
 *
 * 新增帖子步骤：
 * 1. 在 posts/ 目录新建 hello-xxx.vue
 * 2. 在下方 POSTS 数组头部注册（新帖在前）
 */
import { defineAsyncComponent, type Component } from "vue";

export interface BlogPostMeta {
  /** URL slug（/blog/:slug） */
  slug: string;
  /** 外链文章地址（设置后卡片点击直接跳转外部，不走 /blog/:slug） */
  externalUrl?: string;
  /** 标题 */
  title: string;
  /** 一句话摘要（列表页展示） */
  summary: string;
  /** 发布日期 YYYY-MM-DD */
  date: string;
  /** 标签 */
  tags: string[];
  /** 阅读时长（分钟，粗略估算） */
  readingMinutes: number;
  /** 帖子组件（懒加载） */
  component: Component;
}

/** 所有帖子，新帖在前 */
export const POSTS: BlogPostMeta[] = [
  {
    slug: "hello-silkpulse",
    title: "silkpulse：让 AI 接管前端线上排障",
    summary:
      '测试同学报「测试机上白屏」「手机上打不开」时，开发者无法用本地 DevTools 调试远在别处的设备。silkpulse 在页面里插一个 script 标签，console、网络请求、报错实时上报到网页控制台——你人工看，或直接让 AI 排查。本文同步发在公众号「崮生」，欢迎阅读关注。',
    date: "2026-10-15",
    tags: ["silkpulse", "ai-native", "remote-debugging"],
    readingMinutes: 5,
    externalUrl: "https://mp.weixin.qq.com/s/ipLbaflx6i92cgUURgkkLQ",
    component: defineAsyncComponent(() => import("./posts/hello-silkpulse.vue")),
  },
];
