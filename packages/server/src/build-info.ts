/**
 * 构建信息 —— 由 shared/build-info-plugin 提供的虚拟模块在构建期内联
 *
 * `virtual:build-info` 在 vp build（vite）与 vp pack（tsdown/rolldown）
 * 两条管线都被插件解析为真实的构建信息常量，零运行时依赖。
 */

import { buildInfo as raw } from 'virtual:build-info'

/**
 * 获取构建信息；直接透传虚拟模块内联的常量。
 * dev 模式下 vite 同样解析该虚拟模块（值为当前 git 状态），无需降级分支。
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
  return raw
}
