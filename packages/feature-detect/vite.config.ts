import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    /** 不用 tsgo：WSL2 下 spawn 偶发 EBUSY，走进程内 TS API 更稳 */
    dts: false,
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
