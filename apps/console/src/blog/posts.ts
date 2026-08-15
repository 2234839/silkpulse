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
import { defineAsyncComponent, type Component } from 'vue'

export interface BlogPostMeta {
  /** URL slug（/blog/:slug） */
  slug: string
  /** 标题 */
  title: string
  /** 一句话摘要（列表页展示） */
  summary: string
  /** 发布日期 YYYY-MM-DD */
  date: string
  /** 标签 */
  tags: string[]
  /** 阅读时长（分钟，粗略估算） */
  readingMinutes: number
  /** 帖子组件（懒加载） */
  component: Component
}

/** 所有帖子，新帖在前 */
export const POSTS: BlogPostMeta[] = [
  {
    slug: 'hello-silkpulse',
    title: 'hello silkpulse —— 让 AI 直接调试你的远程页面',
    summary: '测试同学说"测试机上白屏了"，而那台设备不在你手边——可能隔着城市，甚至时区。silkpulse 是一个 AI 原生的远程设备调试器：AI 看页面、读日志、执行诊断代码、点按钮、验证结果——一个 agent 完成远程诊断的完整闭环。',
    date: '2026-08-15',
    tags: ['silkpulse', 'ai-native', 'remote-debugging'],
    readingMinutes: 8,
    component: defineAsyncComponent(() => import('./posts/hello-silkpulse.vue')),
  },
]
