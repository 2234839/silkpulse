# clarosight

**AI 原生的远程设备调试器** —— 让 AI 直接查看、诊断、甚至操作远程页面（线上 H5、移动端、webview 等无法用本地 DevTools 调试的环境）。

定位 = PageSpy 的远程多端调试能力 + vite-plugin-pilot 的 AI-native 注入式哲学。

## 核心能力

- **远程设备调试**：任意线上页面注入 SDK 即可接入，不挑框架、不挑环境
- **AI-native**：AI agent 通过 skill + HTTP API 直接操作远程设备（看页面结构、执行诊断代码、读 console/网络/错误）
- **compact 快照**：移植自 pilot 的 AI 友好文本格式，~300 字符压缩整页状态，token 高效
- **多设备并发**：一个 server 管理多个远程设备，控制台可切换查看
- **exec 通道**：AI 在远程设备执行任意诊断 JS，可精确操作快照中的元素

## 架构

```
远程设备 (被调试页面)
  │  clarosight SDK (注入)  ← <script src="http://server/sdk.js">
  │   · console/network/error 采集
  │   · compact 快照 (移植 pilot)
  │   · exec 通道 (接收指令 → eval → 回传)
  └──────────┬──────────
         WebSocket (上报 + 接收指令)
             ▼
clarosight server (Node + TS)
  · 设备注册表 + 环形缓冲区
  · WS 中转：设备 ↔ 控制台
  · HTTP API：AI skill 调用入口
  · 静态 serve：控制台 UI + SDK
      ├── HTTP API ──→ AI agent (skill)
      └── WebSocket ──→ 控制台 UI (Vue3 + Tailwind)
```

## 快速开始

### 构建

```bash
pnpm install
pnpm build    # 构建所有包并复制产物到 server/public
```

### 启动 server

```bash
pnpm start    # 默认端口 8080
# 或 node packages/server/dist/bin/clarosight.mjs --port 3000
```

### 接入远程设备

**方式一：script 标签**（最常用，能改源码时）

```html
<script src="http://localhost:8080/sdk.js" data-server="http://localhost:8080"></script>
```

**方式二：bookmarklet**（线上站不便改源码时）

访问 `http://localhost:8080/inject/bookmarklet`，将输出的 `javascript:` 链接拖到浏览器书签栏，在任意页面点击即接入。

**方式三：userscript**（Tampermonkey/Greasemonkey）

访问 `http://localhost:8080/inject/userscript`，保存为 `.user.js` 安装到油猴，自动匹配所有页面注入。

### AI 接入（skill）

AI agent 通过 clarosight skill 操作设备：

```bash
node tools/skill/scripts/clarosight.mjs devices                # 列出在线设备
node tools/skill/scripts/clarosight.mjs snapshot <id>          # 取页面快照
node tools/skill/scripts/clarosight.mjs exec <id> "return document.title"
node tools/skill/scripts/clarosight.mjs errors <id>            # 查看错误
node tools/skill/scripts/clarosight.mjs logs <id>              # 查看日志
node tools/skill/scripts/clarosight.mjs network <id>           # 查看网络请求
```

详见 [tools/skill/SKILL.md](tools/skill/SKILL.md)。

### 控制台 UI

浏览器打开 `http://localhost:8080` —— Vue3 + Tailwind 的设备调试控制台，支持设备列表、console/network/errors/snapshot 面板实时展示。

## 项目结构

```
clarosight/
├── packages/
│   ├── shared/          # 共享协议类型（protocol）
│   ├── server/          # Node server：WS 中转 + HTTP API + 静态资源
│   └── sdk/             # 注入 SDK（IIFE 单文件）：采集 + exec
├── apps/
│   └── console/         # Vue3 + TS + Tailwind 控制台 UI
├── tools/
│   └── skill/           # AI skill：SKILL.md + CLI 脚本
├── examples/
│   └── test-page.html   # 测试页（注入 SDK）
└── scripts/
    └── headless-test.mjs # 无头浏览器端到端测试
```

整个项目用 [VitePlus](https://viteplus.dev/) 统一管理 —— `vp pack` 打包库、`vp build` 构建应用、`catalog:` 统一版本。

## HTTP API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/devices` | 列出在线设备 |
| GET | `/api/devices/:id/snapshot` | compact 快照（text/plain，AI 直接读） |
| POST | `/api/devices/:id/exec` | 在设备页面执行 JS |
| GET | `/api/devices/:id/logs` | console 日志（支持 `?since=N` 游标） |
| GET | `/api/devices/:id/network` | network 记录（HAR 风格） |
| GET | `/api/devices/:id/errors` | 错误记录 |

## 端到端测试

```bash
pnpm start  # 启动 server（端口 8080 或用 8081 避免冲突）
CLAROSIGHT_SERVER=http://localhost:8081 pnpm exec node scripts/headless-test.mjs
```

无头浏览器（puppeteer-core + 系统 chromium）自动验证：控制台 UI、SDK 注入、snapshot、exec、元素操作、console/error 采集、WS 实时推送。

## License

MIT
