#!/usr/bin/env node
/**
 * clarosight CLI 入口 —— 启动调试服务器
 *
 * 用法：
 *   clarosight                  # 默认端口 8080
 *   clarosight --port 3000      # 指定端口
 *   clarosight -p 3000          # 简写
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../dist/index.mjs'

function parseArgs(args: string[]): { port?: number } {
  const result: { port?: number } = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--port' || arg === '-p') {
      result.port = Number(args[i + 1])
      i++
    } else if (arg.startsWith('--port=')) {
      result.port = Number(arg.slice(7))
    }
  }
  return result
}

/**
 * 路径定位：bundle 后此文件位于 <pkg>/dist/bin/clarosight.mjs
 * - staticRoot: <pkg>/public（sdk.js + 控制台 UI）
 * - demoPagePath: <monorepo>/examples/test-page.html（/demo 路由用）
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const staticRoot = path.resolve(__dirname, '../../public')
const demoPagePath = path.resolve(__dirname, '../../../../examples/test-page.html')

const { port } = parseArgs(process.argv.slice(2))
createServer({ port, staticRoot, demoPagePath })
