/**
 * build-react-vite-testpage.mjs —— 构建真实 React vite build 测试页
 *
 * 为什么存在：diag-react-vite.mjs 需要「真实 vite 构建产物」（ESM chunk +
 * prod minified）做验证——手写 UMD 页覆盖不了 ESM 场景（window.React 不存在、
 * dispatcherRef 拿不到）。产物是构建生成的，不入库（.gitignore 已忽略
 * packages/server/public/react-vite-*.html），换机器需要重建。
 *
 * 用法：node scripts/build-react-vite-testpage.mjs
 * 产物：
 *   packages/server/public/react-vite-post.html —— head 带 sdk.js（先注入）
 *   packages/server/public/react-vite-late.html —— 不带（后注入）
 *
 * 依赖：临时目录 npm install vite@5 + @vitejs/plugin-react@4 +
 * react@18.3.1 + react-dom@18.3.1 + vite-plugin-singlefile（~117 包，8s）
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "examples/react-vite-app");
const OUT_DIR = path.join(ROOT, "packages/server/public");
const TMP = path.join(os.tmpdir(), `silkpulse-react-vite-${Date.now()}`);

console.log("1. 准备临时构建目录…");
fs.mkdirSync(TMP, { recursive: true });
fs.cpSync(SRC, TMP, { recursive: true });
/** vite.config.mjs 引用 node_modules，index.html 的 /src/main.jsx 走 vite 约定 */
process.chdir(TMP);

console.log("2. 安装依赖（vite5 + react18 + singlefile）…");
execSync(
  "npm install --no-fund --no-audit vite@5 @vitejs/plugin-react@4 react@18.3.1 react-dom@18.3.1 vite-plugin-singlefile@2",
  { stdio: "inherit" },
);

console.log("3. vite build…");
execSync("npx vite build", { stdio: "inherit" });

const dist = path.join(TMP, "dist/index.html");
if (!fs.existsSync(dist)) throw new Error("构建产物缺失：dist/index.html");

console.log("4. 部署到 server/public…");
fs.mkdirSync(OUT_DIR, { recursive: true });

/** 先注入版：构建产物 head 里已有 sdk.js script（examples 源里带着） */
fs.copyFileSync(dist, path.join(OUT_DIR, "react-vite-post.html"));

/** 后注入版：剥掉 sdk.js script */
const html = fs.readFileSync(dist, "utf8");
const late = html.replace(
  '<script src="/sdk.js" data-server="http://localhost:8080"></script>\n    ',
  "",
);
if (late.includes("sdk.js")) throw new Error("后注入版剥离 sdk.js 失败：仍有残留");
fs.writeFileSync(path.join(OUT_DIR, "react-vite-late.html"), late);

console.log(
  `✅ 完成：\n  ${path.join(OUT_DIR, "react-vite-post.html")}（先注入）\n  ${path.join(OUT_DIR, "react-vite-late.html")}（后注入）`,
);

/** 清理临时目录（失败也无所谓，tmp 目录本来就会清） */
fs.rmSync(TMP, { recursive: true, force: true });
