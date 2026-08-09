/**
 * Vue Router 配置
 *
 * 路由懒加载：每个路由组件用动态 import() 拆为独立 chunk，
 * 访问对应路由时才加载，减小首屏 JS 体积。
 */
import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'console',
      /** 控制台主页（设备列表 + 调试面板） */
      component: () => import('../ConsoleApp.vue'),
    },
    {
      path: '/tools',
      name: 'tools',
      /** Web Debug 工具箱（不需要选中设备） */
      component: () => import('../components/ToolsPanel.vue'),
    },
    /** 兜底：未知路由重定向到控制台 */
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
