import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
    /** 不让 vp pack 自动管理 exports —— server 有库入口和 bin 入口，手动管理更稳 */
    exports: false,
    /** 强制把纯 JS 运行依赖打包进 bundle，Docker 镜像里不需要额外安装。
     * uWebSockets.js 是原生 C++ 模块（.node 二进制），必须保持 external 不能 bundle——
     * 部署产物需随 dist 带上 node_modules/uWebSockets.js */
    deps: {
      alwaysBundle: ['@silkpulse/feature-detect', '@silkpulse/shared'],
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
