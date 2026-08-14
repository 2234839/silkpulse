import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    /** SDK 不需要 dts，注入脚本自包含 */
    dts: false,
    /** 注入脚本不生成 exports 映射，产物是单文件 IIFE */
    exports: false,
    /** SnapDOM 默认被当外部依赖，IIFE 模式下必须 inline */
    deps: {
      alwaysBundle: ["@zumer/snapdom", "@vue/devtools-kit", "@vue/devtools-core", "superjson"],
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
