import { defineConfig, lazyPlugins } from "vite-plus";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { buildInfoPlugin } from "@silkpulse/shared/build-info-plugin";

export default defineConfig({
  plugins: lazyPlugins(() => [vue(), tailwindcss(), buildInfoPlugin(import.meta.dirname)]),
  /** 控制台 UI 构建到 server 的 public 目录，被 server 静态 serve */
  build: {
    outDir: "../../packages/server/public",
    emptyOutDir: false,
  },
  server: {
    /** dev 模式代理 API 和 WS 到 server */
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
      "/sdk.js": "http://localhost:8080",
      /** devtools client 静态资源（vue/react devtools iframe）也在 server 的 public 下，dev 模式必须代理，否则 SPA fallback 会返回 console 首页导致面板握手永远卡在「连接中」 */
      "/plugins": "http://localhost:8080",
    },
  },
  fmt: {},
});
