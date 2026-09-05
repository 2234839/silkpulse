#!/usr/bin/env node
/**
 * 构建 devtools 插件产物（增量）
 *
 * 用法：
 *   node scripts/build-plugins.mjs            # 增量构建（产物存在且版本记录完整则跳过）
 *   node scripts/build-plugins.mjs --force    # 强制重建
 *   node scripts/build-plugins.mjs --plugin vue | react
 *
 * 产物 plugins 各子目录的 assets 不入库（.gitignore 排除），clone 后首次 build 自动生成，
 * 之后产物没删就跳过，构建很快。--force 清掉 version 标记强制走完整重建。
 */

import { execSync } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

/** --plugin xxx 过滤 */
const argIdx = process.argv.indexOf("--plugin");
const only = argIdx > -1 ? process.argv[argIdx + 1] : undefined;

/**
 * 判断插件产物是否已就绪：version.json 可读 + 关键产物文件存在
 *
 * vue: client SPA 的入口 index.html（assets 由 index.html 引用）
 * react: frontend.bundle.js / backend.bundle.js
 */
function isReady(plugin) {
  const dir = join(ROOT, "plugins", `${plugin}-devtools`);
  if (!existsSync(join(dir, "version.json"))) return false;
  if (plugin === "vue") return existsSync(join(dir, "index.html"));
  return (
    existsSync(join(dir, "assets/frontend.bundle.js")) &&
    existsSync(join(dir, "assets/backend.bundle.js"))
  );
}

/** 当前产物对应的版本标记（打印信息用） */
function currentVersion(plugin) {
  try {
    return JSON.parse(
      readFileSync(join(ROOT, "plugins", `${plugin}-devtools`, "version.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

/** 插件 → 构建命令 */
const builders = {
  vue: () =>
    execSync("node scripts/sync-devtools-clients.mjs --plugin vue", {
      cwd: ROOT,
      stdio: "inherit",
    }),
  react: () =>
    execSync("node scripts/build-react-devtools.mjs --skip-install", {
      cwd: ROOT,
      stdio: "inherit",
    }),
};

for (const plugin of Object.keys(builders)) {
  if (only && plugin !== only) continue;
  if (!force && isReady(plugin)) {
    const v = currentVersion(plugin);
    console.log(
      `[${plugin}-devtools] 产物已就绪（${v ? (v.version ?? v.reactDevtoolsInline) : "?"}），跳过；如需重建用 --force`,
    );
    continue;
  }
  if (force) {
    /** 删掉 version 标记，让下游脚本不走"已是最新"跳过 */
    rmSync(join(ROOT, "plugins", `${plugin}-devtools`, "version.json"), {
      force: true,
    });
  }
  console.log(`[${plugin}-devtools] 构建...`);
  builders[plugin]();
}
console.log("plugins 构建完成");
