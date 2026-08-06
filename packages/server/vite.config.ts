import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
    /** 不让 vp pack 自动管理 exports —— server 有库入口和 bin 入口，手动管理更稳 */
    exports: false,
    /** 强制把运行时依赖打包进 bundle，这样 Docker 镜像里不需要额外安装 */
    deps: {
      alwaysBundle: ["ws", "@clarosight/feature-detect"],
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
