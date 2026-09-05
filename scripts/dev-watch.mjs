#!/usr/bin/env node
/**
 * 一键 dev 编排器：
 * 1. 并行启动 sdk / server(src) / console 的 watch（server src watch 的 clean 会清空 dist，
 *    所以 dist/bin 必须等它首次构建完成后再补建）
 * 2. 等待 server src 产物 dist/index.mjs 出现且稳定
 * 3. 补建 dist/bin，然后以 node --watch 启动 HTTP 服务（后续 src 变更自动重启）
 * 任一子任务退出则终止全部；Ctrl+C 转发 SIGTERM 给整组。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

/** @type {boolean} */
let shuttingDown = false;

/**
 * 终止全部子进程并退出
 * @param {number} code
 */
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (c.exitCode === null && !c.killed) c.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

/**
 * 运行一个长驻任务并接管输出
 * @param {string} label
 * @param {string[]} command
 */
function runTask(label, command) {
  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  children.push(child);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`\n[${label}] 异常退出(code=${code})，终止其余任务\n`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

/**
 * 执行一次性命令，成功则 resolve
 * @param {string[]} command
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<void>}
 */
function runOnce(command, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", ...opts });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command.join(" ")} 失败，code=${code}`)),
    );
  });
}

/**
 * 轮询等待文件出现
 * @param {string} file
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForFile(file, timeoutMs = 30_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    /** 周期检查 */
    function check() {
      if (existsSync(file)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`等待 ${file} 超时`));
      setTimeout(check, 200);
    }
    check();
  });
}

console.log("== 启动 watch 组（sdk / server / console）==");
runTask("watch", [
  "vp",
  "run",
  "--parallel",
  "--log",
  "labeled",
  "--filter",
  "@silkpulse/sdk",
  "--filter",
  "@silkpulse/server",
  "--filter",
  "@silkpulse/console",
  "dev",
]);

console.log("== 等待 server src 首次构建 ==");
await waitForFile("packages/server/dist/index.mjs");

console.log("== 补建 server bin 并启动 HTTP 服务 ==");
await runOnce(["vp", "pack", "bin/silkpulse.ts", "--format", "esm", "--out-dir", "dist-bin"], {
  cwd: "packages/server",
});
// 本地 dev 默认开启 Playground 游客模式（密钥随机生成，仅本地用；显式设置了 SILKPULSE_PLAYGROUND_KEY 则尊重外部值）
if (!process.env.SILKPULSE_PLAYGROUND_KEY)
  process.env.SILKPULSE_PLAYGROUND_KEY = `dev-playground-${Date.now().toString(36)}`;
runTask("server-http", ["node", "--watch", "packages/server/dist-bin/silkpulse.mjs"]);

console.log(
  "\n全部就绪：server http://localhost:8080 · console http://localhost:5173 （Ctrl+C 全部退出）\n",
);

await new Promise(() => {});
