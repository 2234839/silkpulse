import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { useTheme } from "./composables/useTheme";
import "./style.css";

/** 全局初始化主题（单例，所有路由页包括 /tools /blog 都应用 .dark class） */
useTheme();

createApp(App).use(router).mount("#app");
