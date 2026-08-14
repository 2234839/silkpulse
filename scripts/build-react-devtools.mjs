#!/usr/bin/env node
/**
 * 构建 React DevTools frontend bundle（浏览器 IIFE）
 *
 * 用法：node scripts/build-react-devtools.mjs
 *
 * 原理：
 *   react-devtools-inline 的 dist/frontend.js 是 CJS webpack bundle，
 *   react/react-dom/react-is 是 external（未打包）。
 *   官方不发布浏览器可用的预构建产物，所以本脚本：
 *
 *   1. 在临时目录安装 react@18 + react-dom@18 + react-is@18 + react-devtools-inline
 *   2. 写一个 entry wrapper（import frontend.js + re-export react/react-dom）
 *   3. esbuild 打包成 IIFE（global-name=ReactDevToolsFrontend）
 *      → plugins/react-devtools/assets/frontend.bundle.js
 *   4. 同样打包 backend.js → plugins/react-devtools/assets/backend.bundle.js
 *      （IIFE global-name=ReactDevToolsBackend，SDK 动态加载用）
 *
 * 为什么 entry wrapper 要导出 react/react-dom：
 *   initialize() 返回的 <DevTools /> 是 forwardRef 组件，必须用同一份
 *   react-dom 渲染（不同 react 实例的 hooks 会报错），所以宿主 HTML
 *   从 bundle 导出里拿 react/reactDOM 来 createRoot。
 */

import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'plugins/react-devtools/assets')
const TMP = join(ROOT, 'node_modules/.cache/build-react-devtools')

/** React 版本（frontend UI 自身用，与目标页 React 版本无关） */
const REACT_VERSION = '19.1.0'
/** react-devtools-inline 版本（7.x 对应 React DevTools 2025 版） */
const INLINE_VERSION = '7.0.1'

/** 是否跳过安装（本地已有缓存目录时提速） */
const skipInstall = process.argv.includes('--skip-install')

console.log(`[1/4] 准备构建环境 → ${TMP}`)
mkdirSync(TMP, { recursive: true })
if (!skipInstall || !existsSync(join(TMP, 'node_modules/react-devtools-inline'))) {
  if (!existsSync(join(TMP, 'package.json'))) {
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'rd-build', private: true }, null, 2))
  }
  console.log(`      安装 react@${REACT_VERSION} react-dom@${REACT_VERSION} react-is@${REACT_VERSION} react-devtools-inline@${INLINE_VERSION} esbuild`)
  execSync(
    `npm install --no-audit --no-fund react@${REACT_VERSION} react-dom@${REACT_VERSION} react-is@${REACT_VERSION} react-devtools-inline@${INLINE_VERSION} esbuild@latest`,
    { cwd: TMP, stdio: 'inherit' },
  )
}

console.log('[2/4] 写 entry wrapper（frontend：导出 react/react-dom 供宿主渲染）')
const feEntry = join(TMP, 'fe-entry.js')
writeFileSync(feEntry, `
const react = require('react')
const reactDOM = require('react-dom')
const reactDOMClient = require('react-dom/client')

/**
 * polyfill unstable_getCacheForType —— npm 发布的 react 不含此 API（只有
 * facebook/react 仓库内源码构建的 devtools shell 才有），而 frontend.js 的
 * InspectedElementContextController 直接调用它做 per-render cache。
 * 语义：返回当前渲染周期内与 createMap 一一对应的 cache 实例（Map/WeakMap）。
 * react-devtools 自己的用法只在单次渲染内读存，全局表足以满足。
 */
if (typeof react.unstable_getCacheForType !== 'function') {
  const cacheTable = new WeakMap()
  react.unstable_getCacheForType = function (createMap) {
    let map = cacheTable.get(createMap)
    if (map === undefined) {
      map = createMap()
      cacheTable.set(createMap, map)
    }
    return map
  }
}

const frontend = require('react-devtools-inline/dist/frontend.js')
module.exports = frontend
module.exports.react = react
module.exports.reactDOM = reactDOM
module.exports.reactDOMClient = reactDOMClient
`)

console.log('[3/4] esbuild 打包 frontend（IIFE）')
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })
execSync(
  `node ${join(TMP, 'node_modules/esbuild/bin/esbuild')} ${feEntry}` +
    ' --bundle --format=iife --global-name=ReactDevToolsFrontend' +
    ` --outfile=${join(OUT_DIR, 'frontend.bundle.js')}` +
    ` --define:process.env.NODE_ENV='"development"'`,
  { stdio: 'inherit' },
)

console.log('[4/4] esbuild 打包 backend（IIFE，SDK 按需 fetch）')
execSync(
  `node ${join(TMP, 'node_modules/esbuild/bin/esbuild')} ${join(TMP, 'node_modules/react-devtools-inline/dist/backend.js')}` +
    ' --bundle --format=iife --global-name=ReactDevToolsBackend' +
    ` --outfile=${join(OUT_DIR, 'backend.bundle.js')}` +
    ` --define:process.env.NODE_ENV='"development"'`,
  { stdio: 'inherit' },
)

/** 记录版本信息（同 vue-devtools 的 version.json 格式） */
writeFileSync(
  join(OUT_DIR, '..', 'version.json'),
  JSON.stringify(
    {
      plugin: 'react',
      reactDevtoolsInline: INLINE_VERSION,
      react: REACT_VERSION,
      builtAt: new Date().toISOString(),
      source: 'react-devtools-inline dist + esbuild IIFE（scripts/build-react-devtools.mjs）',
    },
    null,
    2,
  ) + '\n',
)

const feSize = (readFileSync(join(OUT_DIR, 'frontend.bundle.js')).length / 1024 / 1024).toFixed(2)
const beSize = (readFileSync(join(OUT_DIR, 'backend.bundle.js')).length / 1024).toFixed(0)
console.log(`\n✅ 构建完成：frontend ${feSize}MB / backend ${beSize}KB → plugins/react-devtools/assets/`)
