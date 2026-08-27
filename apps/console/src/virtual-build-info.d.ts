/**
 * 虚拟模块 `virtual:build-info` 的类型环境声明（console 侧）
 *
 * 该模块由 @silkpulse/shared/build-info-plugin 在构建期生成真实内容。
 * TS 无法跨包感知虚拟模块，需在消费包内提供 ambient 声明；
 * 与 packages/server/src/virtual-build-info.d.ts 保持一致。
 */
declare module "virtual:build-info" {
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
