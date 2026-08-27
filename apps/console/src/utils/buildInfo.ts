/**
 * 前端构建信息 —— 复用 server 端同一虚拟模块机制
 *
 * `virtual:build-info` 由 @silkpulse/shared/build-info-plugin 在构建期
 * 内联为真实常量（git 哈希/分支/构建时间），console 的 vite.config 已接入。
 * 类型环境声明见 src/types/virtual-build-info.d.ts。
 */

import { buildInfo as raw } from "virtual:build-info";

/**
 * 获取构建信息（构建期内联的常量）
 */
export function getBuildInfo(): {
  /** git 提交哈希（完整 40 位） */
  commit: string;
  /** git 分支名（detached HEAD 时为空字符串） */
  branch: string;
  /** 是否有未提交改动 */
  dirty: boolean;
  /** 构建时间（ISO 8601，含时区） */
  buildAt: string;
} {
  return raw;
}
