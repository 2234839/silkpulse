#!/usr/bin/env node
/**
 * silkpulse CLI 入口 —— 启动调试服务器
 *
 * 用法：
 *   silkpulse                  # 默认端口 8080
 *   silkpulse --port 3000      # 指定端口
 *   silkpulse -p 3000          # 简写
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/index.ts";

function parseArgs(args: string[]): { port?: number; static?: string } {
  const result: { port?: number; static?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" || arg === "-p") {
      result.port = Number(args[i + 1]);
      i++;
    } else if (arg.startsWith("--port=")) {
      result.port = Number(arg.slice(7));
    } else if (arg === "--static") {
      result.static = args[i + 1];
      i++;
    } else if (arg.startsWith("--static=")) {
      result.static = arg.slice(9);
    }
  }
  return result;
}

/**
 * 路径定位：bundle 后此文件位于 <pkg>/dist/bin/silkpulse.mjs
 * - staticRoot: <pkg>/public（sdk.js + 控制台 UI）
 * - demoPagePath 由 createServer 内部多路径查找（bundle 后 __dirname 不可靠）
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(__dirname, "../../public");

const { port, static: staticOverride } = parseArgs(process.argv.slice(2));
/** createServer 返回 Promise（uWS listen 异步）：失败时让进程非零退出（let it crash） */
await createServer({
  port,
  /** --static 覆盖：dev-watch 产物目录（dist-bin）层级与正式 dist/bin 不同，默认推导会错位 */
  staticRoot: staticOverride ? path.resolve(staticOverride) : staticRoot,
});
