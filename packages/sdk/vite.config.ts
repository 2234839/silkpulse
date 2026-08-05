import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    /** SDK 不需要 dts，注入脚本自包含 */
    dts: false,
    /** 注入脚本不生成 exports 映射，产物是单文件 IIFE */
    exports: false,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
