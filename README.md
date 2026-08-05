# clarosight

**AI 原生的远程设备调试器** —— 让 AI 直接查看、诊断、操作远程页面（线上 H5、移动端、webview 等无法用本地 DevTools 调试的环境）。

定位 = PageSpy 的远程多端调试能力 + vite-plugin-pilot 的 AI-native 注入式哲学。

## 为什么用 clarosight

用户报告"线上页面白屏""手机上打不开"时，开发者无法用本地 DevTools 调试远程设备。clarosight 让 **AI agent 直接接入远程页面**——看页面结构、读 console/网络/错误、执行诊断代码、操作元素，完成"远程诊断→操作→验证"的完整闭环。

| | PageSpy | chii | vite-plugin-pilot | **clarosight** |
|---|---|---|---|---|
| 远程设备调试 | ✅ | ✅ | ❌（仅本地 dev server） | ✅ |
| AI-native | ❌ | ❌ | ✅ | ✅ |
| AI 接入方式 | 无 | 无 | MCP | **skill + HTTP API** |
| 多设备并发 | ✅ | ✅ | ❌ | ✅ |
| 断线重连 | — | — | — | ✅（历史保留） |
| 前端依赖 | 自研控制台 | fork DevTools | 无控制台 | 自研轻量控制台 |

## 核心能力

### 远程采集
- **console 劫持**：info/warn/error/debug 全级别采集，安全序列化（限深限长防卡死），**日志限流**（滑动窗口 50 条/秒，防 log 爆炸打爆 WS/server；error 级不限流）
- **network 采集**：fetch + XHR 劫持，HAR 风格（URL/方法/状态/**关键请求头/响应头**/请求体/响应体/耗时）。headers 只采诊断关键头（content-type/authorization/cookie/自定义 x-* 等），鉴权/cookie 脱敏保留类型
- **error 捕获**：window.onerror + unhandledrejection，含堆栈 + **自动 source map 解析**（压缩位置 → 原始源码位置，让 AI 能定位压缩代码的真实出错点）。**资源加载失败不计入 errorCount**（404 图片/脚本降级为快照附带提示，避免红条误导诊断）
- **compact 快照**：移植自 pilot 的 AI 友好文本格式，稳定索引，~400 字符压缩整页状态，穿透 shadow DOM + 同源 iframe。**全量表单状态**（disabled/readonly/required/indeterminate/aria-disabled/aria-expanded/**当前聚焦元素 focus**）—— AI 诊断"按钮点不了""表单提交失败""光标在哪"时能直接定位根因

### AI 操作（exec 通道）
AI 在远程设备执行任意诊断 JS，内置辅助函数：
- `__clarosight_click(idx)` — 点击快照中的元素
- `__clarosight_setValue(idx, val)` — 设置表单值（框架兼容）
- `__clarosight_type(idx, text)` — 模拟键盘逐字输入（触发 keydown/keyup）
- `__clarosight_wait(ms)` — 异步等待
- `__clarosight_snapshot()` — 手动取快照
- `__clarosight_sourcemap(line, col, sourceUrl?)` — 解析 source map，压缩位置 → 原始源码位置
- `__clarosight_sourcemapStack(frames[])` — 批量解析堆栈帧

### 多形态接入
- **script 标签**：能改源码时
- **bookmarklet**：线上站不便改源码时，拖到书签栏点击即接入
- **userscript**：Tampermonkey/Greasemonkey，自动匹配所有页面

### 设备标签 / 备注
多设备场景下区分"哪台是哪台"：
- **接入时预设**：`<script src=".../sdk.js" data-tags="生产,用户A" data-note="iPhone 15"></script>`
- **运行时修改**：控制台 UI 内联编辑（选中设备点 🏷️），或 `POST /api/devices/:id/tags`
- **AI 可用**：`clarosight tag <id> "标签1,标签2" 备注内容`
- **持久保留**：SPA 路由变化、断线重连都不覆盖 server 侧标签

### 可靠性
- **断线重连**：指数退避（1s/2s/4s...30s），重连后历史缓冲区完整保留
- **SDK 离线缓冲**：启动期间（采集器装好到 WS 连上）和断线期间产生的日志/错误/网络请求，暂存 SDK 内存队列（上限 200 条），重连后 flush，不丢失早期错误
- **SPA 路由感知**：pushState/replaceState/popstate 上报 URL 变化
- **视口变化感知**：窗口缩放/移动端旋转时上报新 viewport + 重新推断设备类型（防抖 300ms），诊断横屏布局错乱时 AI 能看到真实视口
- **环形缓冲区**：server 内存保留最近 500 条日志 / 100 条网络 / 50 条错误
- **静态资源缓存**：sdk.js/index.html 强制 no-cache（诊断工具不能用旧版），带 hash 的构建产物长缓存 + ETag 304
- **WS 背压保护**：broadcast 检查 `bufferedAmount`，慢客户端（VPN/弱网）积压超 1MB 时自动关闭该连接，防止单个慢消费者拖垮 server 内存；send 带回调避免竞态抛异常
- **exec 异步超时**：永不 resolve 的代码（如 `new Promise(() => {})`）由 SDK 端 9s 超时兜底（早于 server 10s），干净回传 + 释放 exec 日志捕获队列，不靠 server 干等导致 promise 泄漏
- **HTTP body 上限**：POST body 超 2MB 返回 413（诊断代码实际几 KB，留充足余量），防止超大/恶意请求撑爆内存；客户端中断时 readBody 正常 resolve 不泄漏 promise
- **最近下线设备历史**：设备掉线后保留摘要到 `recentlyOffline`（上限 10，含下线时刻/URL/错误数），AI 调 `/api/devices` 能区分"从未接入"和"接入过但掉了"，不误判诊断方向；重连后自动移除

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
# 1. 查看在线设备（有错误的自动置顶）
node tools/skill/scripts/clarosight.mjs devices

# 2. 取页面快照（AI 友好的 compact 文本）
node tools/skill/scripts/clarosight.mjs snapshot <id>

# 3. 执行诊断代码（支持 stdin 传复杂多行代码）
echo 'return { title: document.title, url: location.href }' | node tools/skill/scripts/clarosight.mjs exec <id>

# 4. 查看错误 / 日志 / 网络
node tools/skill/scripts/clarosight.mjs errors <id>
node tools/skill/scripts/clarosight.mjs logs <id>
node tools/skill/scripts/clarosight.mjs network <id>   # 含关键请求头/响应头

# 一键诊断聚合（错误 + 失败网络 + 快照，AI 最高效入口）
node tools/skill/scripts/clarosight.mjs inspect <id>

# 5. 生成接入片段
node tools/skill/scripts/clarosight.mjs inject bookmarklet
```

详见 [tools/skill/SKILL.md](tools/skill/SKILL.md)。

### 控制台 UI

浏览器打开 `http://localhost:8080` —— Vue3 + Tailwind 的设备调试控制台（**Tab 数量徽标**：Console/Network/Errors tab 实时显示条数，Errors 有错误时红色高亮，一眼定位问题面板）：

- **设备列表**：搜索筛选、设备类型图标（📱手机/📲平板/🖥️桌面）、错误红条高亮
- **Console 面板**：级别筛选（全部/ERROR/WARN/INFO/DEBUG）+ 关键词搜索 + **自动滚动到最新**（智能：向上翻看历史时不强制拉回）+ **清空视图**（🚫 隐藏当前日志专注新产生，server 缓冲不变）
- **Network 面板**：主从布局，**时间戳列**（与 console 日志交叉对比时序），点击请求查看请求体/响应体详情，**一键复制为 cURL**（远程请求本地/AI 复现），URL/方法/状态码搜索过滤，**状态筛选**（全部/成功/失败，快速隔离 4xx/5xx 异常请求）
- **Errors 面板**：含堆栈展示（可折叠）+ source map 解析后的原始源码位置，message/堆栈/源码位置搜索过滤
- **Snapshot 面板**：compact 文本格式，**行级搜索过滤**（输入元素名/idx/状态 token 只显示匹配行，快速定位），**一键复制**（粘贴给 AI/存档），带刷新按钮
- **Exec 面板**：直接执行诊断 JS（Ctrl+↵，Tab 缩进），**执行结果分块展示**（返回值 + 执行期间日志分开，失败红色高亮），**执行后快照默认折叠**（点击展开，不挤占返回值视线），**执行历史侧栏**（点击回填，localStorage 持久化）
- **✨ AI 诊断上下文**：一键聚合错误+快照+网络+日志为 markdown，复制给任意 AI agent
- **🌙/☀️ 深色模式**：跟随系统偏好，localStorage 持久化

## 项目结构

```
clarosight/
├── packages/
│   ├── shared/          # 共享协议类型（device/console/server 三方消息契约）
│   ├── server/          # Node server：WS 中转 + HTTP API + 静态资源
│   └── sdk/             # 注入 SDK（IIFE 单文件）：采集 + exec + 重连
├── apps/
│   └── console/         # Vue3 + TS + Tailwind 控制台 UI
├── tools/
│   └── skill/           # AI skill：SKILL.md + CLI 脚本
├── examples/
│   └── test-page.html   # 测试页（含交互/搜索/网络/错误场景）
└── scripts/
    └── headless-test.mjs # 无头浏览器端到端测试（63 项）
```

整个项目用 [VitePlus](https://viteplus.dev/) 统一管理 —— `vp pack` 打包库、`vp build` 构建应用、`catalog:` 统一版本。

## HTTP API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/devices` | 在线设备 + 最近下线设备（`{ devices, recentlyOffline }`） |
| GET | `/api/devices/:id/snapshot` | compact 快照（text/plain，AI 直接读） |
| POST | `/api/devices/:id/exec` | 在设备页面执行 JS（`{code: "..."}`） |
| GET | `/api/devices/:id/logs?since=N` | console 日志（游标分页） |
| GET | `/api/devices/:id/network?since=N` | network 记录（HAR 风格，游标分页） |
| GET | `/api/devices/:id/errors` | 错误记录 |
| POST | `/api/devices/:id/tags` | 修改设备标签/备注（`{tags?: string[], note?: string}`） |
| GET | `/inject/bookmarklet` | 生成 bookmarklet 注入片段 |
| GET | `/inject/userscript` | 生成 userscript 注入片段 |
| POST | `/api/echo` | 回显端点（测试 POST body 采集） |

## 端到端测试

```bash
# 类型检查
pnpm typecheck

# 启动 server
node packages/server/dist/bin/clarosight.mjs --port 8083

# 运行无头测试（puppeteer-core + 系统 chromium）
CLAROSIGHT_SERVER=http://localhost:8083 pnpm test
```

CI（GitHub Actions）在每次 push/PR 时自动运行类型检查 + 构建 + 63 项无头测试，见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。

63 项测试覆盖：控制台 UI 渲染、SDK 连接、设备类型识别、SPA 路由上报、exec/snapshot/click/type、快照表单状态采集（含当前聚焦元素）、exec 错误含 stack、exec 异步超时保护（永不 resolve 的代码 9s 兜底）、console 采集、日志限流、network 采集（含 POST body + 关键请求头/响应头）、HTTP body 上限保护（超大 POST 返回 413）、error 采集、资源加载失败不计入 errorCount、WS 实时推送、多设备并发、设备搜索、AI 诊断上下文、bookmarklet 注入、断线重连（历史保留）、WS broadcast 背压保护（慢客户端不拖垮 server）、SDK 离线缓冲（断线期间数据不丢失）、最近下线设备历史（AI 区分"没接入"vs"接入过但掉了"）、设备标签/备注、source map 解析、iframe 元素采集、错误堆栈折叠 + 搜索过滤、Tab 数量徽标（Errors 红色高亮）、exec 执行历史、复制为 cURL、network 列表时间戳列、skill CLI（network headers + inspect 聚合）、深色模式、Network 状态筛选（全部/成功/失败三态隔离异常请求）、Console 清空视图（隐藏当前日志，新日志正常出现）、SDK 视口变化上报（resize/旋转后 server 收到新 viewport）、Snapshot 面板搜索过滤 + 一键复制。

## License

MIT
