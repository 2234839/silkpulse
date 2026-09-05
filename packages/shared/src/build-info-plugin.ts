import { execSync } from "node:child_process";

/**
 * 构建信息（git 哈希 / 分支 / 构建时间）
 *
 * 通过 execSync 从构建机的 git 仓库读取，失败时字段降级为 'unknown'，
 * 保证在任何环境（无 git、CI 浅克隆）下构建都不中断。
 */
export interface BuildInfo {
  /** git 提交哈希（完整 40 位） */
  commit: string;
  /** git 分支名（detached HEAD 时为空字符串） */
  branch: string;
  /** 是否有未提交改动 */
  dirty: boolean;
  /** 构建时间（ISO 8601，含时区） */
  buildAt: string;
}

/** 在 git 目录里执行只读命令，任何失败都返回 null（不让构建崩掉） */
function gitCmd(args: string, cwd?: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 收集当前构建信息
 */
export function collectBuildInfo(cwd: string): BuildInfo {
  return {
    commit: gitCmd("rev-parse HEAD", cwd) ?? "unknown",
    branch: gitCmd("rev-parse --abbrev-ref HEAD", cwd) ?? "",
    // 排除 .codegraph（codegraph 索引自带 .gitignore 会随索引波动，
    // 把工具自身的元数据算进 dirty 会污染版本指纹）
    dirty: (gitCmd("status --porcelain -- . ':!.codegraph'", cwd) ?? "").length > 0,
    buildAt: new Date().toISOString(),
  };
}

/** 虚拟模块的 import 说明符（应用代码里 `import { buildInfo } from 'virtual:build-info'`） */
export const BUILD_INFO_VIRTUAL_ID = "virtual:build-info";

/**
 * 创建构建信息注入插件（虚拟模块方案）
 *
 * 工作原理：把 BuildInfo 序列化后作为虚拟模块 `virtual:build-info` 的内容，
 * 应用代码直接 `import { buildInfo } from 'virtual:build-info'`。
 *
 * 为什么用虚拟模块而不是 define：define 是 vite build 模式的 config 钩子
 * 注入，而 server 端走 vp pack（tsdown/rolldown 管线），用户插件的 config
 * 钩子不会被调用；resolveId/load 钩子两端管线都会执行（uwsNativePlugin
 * 同款机制已被验证）。
 *
 * 前端（vp build/vite build）与 server（vp pack/tsdown）共用同一插件实现。
 */
export function buildInfoPlugin(cwd: string) {
  const info = collectBuildInfo(cwd);
  /** 虚拟模块内容：命名导出 + 默认导出双形态；不用 as const（\0 虚拟 id 不走 TS 转译，纯 JS 语法） */
  const moduleContent = [
    `export const buildInfo = ${JSON.stringify(info)}`,
    `export default buildInfo`,
  ].join("\n");

  console.log(
    `  ℹ️  构建版本注入：${info.branch}@${info.commit.slice(0, 7)}${info.dirty ? " (dirty)" : ""} · ${info.buildAt}`,
  );

  const virtualId = "\0" + BUILD_INFO_VIRTUAL_ID;
  return {
    name: "silkpulse-build-info",
    enforce: "pre",
    resolveId(source: string) {
      if (source === BUILD_INFO_VIRTUAL_ID) return virtualId;
      return null;
    },
    load(id: string) {
      if (id === virtualId) return moduleContent;
      return null;
    },
  };
}
