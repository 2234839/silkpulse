import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite-plus";
/** rolldown 类型经 vite-plus-core re-export（rolldown 本体未直接暴露给项目） */
import type { Plugin } from "@voidzero-dev/vite-plus-core/rolldown";

/**
 * uWS 原生二进制自包含插件
 *
 * .node 二进制物理上无法内联进 JS bundle（dlopen 需要真实文件路径），
 * 但可以把产物做成自包含：
 * 1. resolveId 拦截 'uWebSockets.js'，替换为加载同目录 .node 的 shim（绕过
 *    uws.js 的平台拼接 require，也就绕开了 external 约束）
 * 2. generateBundle 把构建机当前平台的单个 .node（约 4.8MB）emit 到输出目录
 *
 * 效果：dist/ 整体 rsync 即可部署，不再需要 node_modules/uWebSockets.js。
 * ABI 由文件名携带（uws_linux_x64_137.node），跨 Node 大版本部署时一眼可辨。
 */
function uwsNativePlugin(): Plugin {
  /** 按构建机平台/ABI 拼出二进制名（与 uws.js 内部的加载逻辑一致） */
  const nodeFile = `uws_${process.platform}_${process.arch}_${process.versions.modules}.node`;
  const virtualId = "\0virtual:uws-native";
  return {
    name: "uws-native-self-contained",
    resolveId(source: string) {
      if (source === "uWebSockets.js") return virtualId;
    },
    load(id: string) {
      if (id !== virtualId) return;
      /** createRequire 相对 bundle 文件解析；.node 与 bundle 同目录（emitFile 放 outDir 根） */
      return [
        "import { createRequire } from 'node:module'",
        "const require = createRequire(import.meta.url)",
        `export default require('./${nodeFile}')`,
        "",
      ].join("\n");
    },
    generateBundle() {
      const uwsDir = path.resolve(import.meta.dirname, "node_modules/uWebSockets.js");
      this.emitFile({
        type: "asset",
        fileName: nodeFile,
        source: fs.readFileSync(path.join(uwsDir, nodeFile)),
      });
    },
  };
}

export default defineConfig({
  pack: {
    /** 不用 tsgo：WSL2 下 spawn tsgo 二进制偶发 EBUSY（被 Windows Defender 扫描锁文件），
     *  且失败会打断 watch 构建；留空则走进程内 TS API 生成类型，更稳 */
    dts: {},
    /** 不让 vp pack 自动管理 exports —— server 有库入口和 bin 入口，手动管理更稳 */
    exports: false,
    deps: {
      /** uWebSockets.js 加入 alwaysBundle 才能让下方插件拦截到 resolveId：
       *  否则它在 package.json dependencies 里，会被 tsdown 的 DepsPlugin
       *  先一步判为 external，用户插件的 resolveId 根本轮不到 */
      alwaysBundle: ['@silkpulse/feature-detect', '@silkpulse/shared', 'uWebSockets.js'],
    },
    /** uWS 的 import 被上面的插件替换为同目录 .node 加载，且二进制随产物 emit */
    plugins: [uwsNativePlugin()],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
