import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { useTheme } from "./composables/useTheme";
import { i18n } from "./i18n";
import "./style.css";

/** 全局初始化主题（单例，所有路由页包括 /tools /blog 都应用 .dark class） */
useTheme();

createApp(App).use(router).use(i18n).mount("#app");
