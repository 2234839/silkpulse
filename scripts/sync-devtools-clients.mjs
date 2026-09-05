#!/usr/bin/env node
/**
 * 同步 devtools client 静态文件到 plugins/ 目录
 *
 * 用法：
 *   node scripts/sync-devtools-clients.mjs              # 同步全部
 *   node scripts/sync-devtools-clients.mjs --plugin vue # 只同步 vue
 *   node scripts/sync-devtools-clients.mjs --plugin react
 *
 * 原理：
 *   1. npm pack 拉最新 tarball（不污染 node_modules）
 *   2. 解压提取打包好的 client 静态文件
 *   3. 替换 plugins/<name>/ 内容，写 version.json 记录来源版本
 *
 * Vue: vite-plugin-vue-devtools 的 client/（Vue DevTools 官方 SPA，
 *       内置 iframe preset —— 在 iframe 中自动用 postMessage 与 parent 通信）
 * React: react-devtools-inline 的 frontend 需要自行构建（官方不发布打包产物），
 *       本脚本对 React 暂时只做版本探测，构建逻辑见 scripts/build-react-devtools.mjs
 */

import { execSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
  existsSync,
  readFileSync,
  createWriteStream,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import https from "node:https";

/** 下载 registry tarball 到本地 */
function fetchTarball(pkg, version, destPath) {
  return new Promise((resolve, reject) => {
    /** scoped 包名转 URL：@vue/kit → @vue%2Fkit */
    const url = `https://registry.npmjs.org/${pkg.replace("/", "%2F")}/-/${pkg.split("/").pop()}-${version}.tgz`;
    const file = createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`下载失败 ${res.statusCode}: ${url}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = join(ROOT, "plugins");

/** 解析 CLI 参数 --plugin xxx */
const argIdx = process.argv.indexOf("--plugin");
const onlyPlugin = argIdx > -1 ? process.argv[argIdx + 1] : undefined;

/** 拉包的最新版本号（用 pnpm 规避项目 npm devEngines 校验） */
function latestVersion(pkg) {
  return execSync(`pnpm view ${pkg} version`, { encoding: "utf8" }).trim();
}

/** 下载 tarball 并解压到临时目录，返回解压路径 */
async function downloadTarball(pkg, version) {
  const tmpDir = join(tmpdir(), `silkpulse-devtools-${pkg.replace(/[/@]/g, "_")}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const tarball = join(tmpDir, "package.tgz");
  await fetchTarball(pkg, version, tarball);
  execSync(`tar -xzf ${tarball} -C ${tmpDir}`);
  return join(tmpDir, "package");
}

/** 写版本记录 */
function writeVersion(pluginDir, source, version) {
  writeFileSync(
    join(pluginDir, "version.json"),
    JSON.stringify({ source, version, syncedAt: new Date().toISOString() }, null, 2) + "\n",
  );
}

/** 同步 Vue DevTools client */
async function syncVue() {
  const PKG = "vite-plugin-vue-devtools";
  console.log(`[vue-devtools] 查询 ${PKG} 最新版本...`);
  const version = latestVersion(PKG);
  const pluginDir = join(PLUGINS_DIR, "vue-devtools");

  /** 版本没变且目录非空则跳过 */
  const existing = existsSync(join(pluginDir, "version.json"))
    ? JSON.parse(readFileSync(join(pluginDir, "version.json"), "utf8"))
    : null;
  if (existing?.version === version && existsSync(join(pluginDir, "index.html"))) {
    console.log(`[vue-devtools] 已是最新 ${version}，跳过`);
    return;
  }

  console.log(`[vue-devtools] 下载 ${PKG}@${version}...`);
  const pkgDir = await downloadTarball(PKG, version);

  /** tarball 里 client/ 目录就是官方打包好的 SPA */
  const clientDir = join(pkgDir, "client");
  if (!existsSync(clientDir)) {
    throw new Error(`tarball 中找不到 client/ 目录，${PKG} 包结构可能变了，请检查`);
  }

  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(pluginDir, { recursive: true });
  cpSync(clientDir, pluginDir, { recursive: true });
  writeVersion(pluginDir, PKG, version);
  console.log(`[vue-devtools] ✓ 同步完成 ${version}`);
}

/** React 见独立构建脚本（官方不发布打包好的 frontend） */
async function syncReact() {
  console.log("[react-devtools] 官方不发布打包产物，请运行:");
  console.log("  node scripts/build-react-devtools.mjs");
}

const runners = { vue: syncVue, react: syncReact };
const targets = onlyPlugin ? [onlyPlugin] : Object.keys(runners);

for (const name of targets) {
  const runner = runners[name];
  if (!runner) {
    console.error(`未知插件: ${name}（可选: ${Object.keys(runners).join(", ")}）`);
    process.exit(1);
  }
  await runner();
}
console.log("全部完成");
