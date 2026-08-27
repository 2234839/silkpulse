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
    },
  },
  fmt: {},
});
