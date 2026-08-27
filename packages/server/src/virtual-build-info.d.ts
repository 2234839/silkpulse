/**
 * 虚拟模块 `virtual:build-info` 的类型声明
 *
 * 该模块由 @silkpulse/shared/build-info-plugin 在构建期生成，
 * 必须放在独立 .d.ts 中作为环境声明（放在含 import/export 的
 * 模块文件里会被 TS 当作模块增强而报 TS2664）。
 */
declare module 'virtual:build-info' {
  /** 构建期内联的构建信息常量 */
  const buildInfo: {
    /** git 提交哈希（完整 40 位） */
    commit: string;
    /** git 分支名（detached HEAD 时为空字符串） */
    branch: string;
    /** 是否有未提交改动 */
    dirty: boolean;
    /** 构建时间（ISO 8601） */
    buildAt: string;
  };
  export { buildInfo };
  export default buildInfo;
}
