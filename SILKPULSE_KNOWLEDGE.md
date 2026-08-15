# silkpulse 项目知识与避坑指南（压缩版）

> 一份从多次迭代实战中提炼的工程知识库。新会话/新协作者读这一份即可掌握所有非显而易见的约定、陷阱、命令。
> **原则：知之为知之是知也** —— 记录的都是踩过坑、验证过的事实，不是猜测。

---

## 0. 一句话定位

**silkpulse = PageSpy 的远程多端调试能力 + vite-plugin-pilot 的 AI-native 注入式哲学。**
让 AI agent 直接接入远程页面（线上 H5 / 移动端 / webview 等无法用本地 DevTools 调试的环境），完成"远程诊断 → 操作 → 验证"闭环。

**AI 接入方式 = skill + HTTP API（非 MCP）**。这是已敲定的核心决策。

---

## 1. 架构速记

```
远程设备 (SDK 注入)
  │  WS 上报：console/network/error/snapshot/exec-result
  └──────────┬─────────
        WebSocket
             ▼
silkpulse server (Node + TS)
  · 设备注册表 + 环形缓冲区（日志500/网络100/错误50）
  · WS 中继：设备 ↔ 控制台
  · HTTP API：AI skill 入口
  · 静态 serve：控制台 UI + sdk.js
      ├── HTTP API ──→ AI agent (skill CLI)
      └── WebSocket ──→ 控制台 UI (Vue3 + Tailwind v4)
```

**三路通信**：
- 设备 ↔ server：单条 WS 长连接（注册 + 流式上报 + 接收 exec 指令）
- 控制台 ↔ server：WS（实时渲染）
- AI ↔ server：纯 HTTP（同步请求-响应；exec 时 server 通过设备 WS 下发并等回传，用内存 promise 桥接）

---

## 2. Monorepo 结构

```
silkpulse/
├── packages/
│   ├── shared/   # 共享类型（三方消息契约）—— 仅类型，无运行时代码
│   ├── server/   # Node server：WS 中转 + HTTP API + 静态资源
│   └── sdk/      # 注入 SDK（IIFE 单文件）：采集 + exec + 重连
├── apps/
│   └── console/  # Vue3 + TS + Tailwind v4 控制台 UI
├── tools/
│   └── skill/    # AI skill：SKILL.md + CLI 脚本（silkpulse.mjs）
├── examples/
│   └── test-page.html   # 测试页（含全场景：交互/搜索/表单/网络/错误/键盘/iframe）
└── scripts/
    └── headless-test.mjs # 无头浏览器端到端测试（87 项断言场景）
```

用 [VitePlus](https://viteplus.dev/) 统一管理：`vp pack` 打包库、`vp build` 构建应用、`catalog:` 统一版本。

---

## 3. 必背命令（核心循环）

### 类型检查（改完 ts 必跑）
```bash
pnpm typecheck
# 或单包：pnpm tsc --noEmit -p packages/sdk/tsconfig.json
```

### 构建（⚠️ 必须根目录 `pnpm build`，见第 6 节陷阱）
```bash
pnpm build   # vp run -r build && pnpm run copy:assets
```

### 启动 server（测试用 8083，正式默认 8080）
```bash
# 正式
pnpm start
# 或 node packages/server/dist/bin/silkpulse.mjs --port 8083

# 测试时重启（杀掉旧实例）
kill $(lsof -ti :8083); sleep 1; node packages/server/dist/bin/silkpulse.mjs --port 8083 &
sleep 2  # 等 server 起来
```

### 无头测试
```bash
SILKPULSE_SERVER=http://localhost:8083 pnpm test
```

### 标准迭代循环（改代码后）
```bash
pnpm typecheck && pnpm build && \
  (kill $(lsof -ti :8083); sleep 1; node packages/server/dist/bin/silkpulse.mjs --port 8083 &) && \
  sleep 2 && SILKPULSE_SERVER=http://localhost:8083 pnpm test
```

### Git 提交（个人项目，直接提交 master，不开分支）
```bash
git add -A && git commit -m "feat(xxx): 描述"
```

---

## 4. 无头测试环境

- **puppeteer-core + 系统 chromium**（非 puppeteer 内置 Chromium）
- chromium 路径：`/usr/bin/chromium-browser`，探测顺序 `chromium-browser` → `chromium` → `google-chrome`
- 启动参数**必须**：`--no-sandbox --disable-gpu --disable-dev-shm-usage`（WSL2 / CI 环境）
- 可用 `CHROMIUM_PATH` 环境变量覆盖路径
- 测试从**项目根目录**运行，server 必须先起

---

## 5. SDK 辅助函数清单（exec 通道暴露给 AI 的页面级 API）

| 函数 | 说明 |
|---|---|
| `__silkpulse_click(idx)` | 点击元素 |
| `__silkpulse_setValue(idx, val)` | 设表单值，**支持 input/textarea/select/checkbox/radio** |
| `__silkpulse_type(idx, text)` | 逐字输入（keydown/keyup 序列，React 受控组件兼容） |
| `__silkpulse_pressKey(idx, key, mods?)` | 按键（Enter/Escape/方向键/组合键）；idx<0 对 activeElement |
| `__silkpulse_scroll(idx, x, y)` | 滚动（idx<0 滚窗口） |
| `__silkpulse_scrollIntoView(idx, block?)` | 滚入视野 |
| `__silkpulse_hover(idx)` | 悬停（mouseover/mouseenter） |
| `__silkpulse_wait(ms)` | 异步等待 |
| `__silkpulse_snapshot()` | 取快照 |
| `__silkpulse_sourcemap(line, col, sourceUrl?)` | source map 解析 |
| `__silkpulse_sourcemapStack(frames[])` | 批量解析堆栈 |
| `__silkpulse_storage(type?)` | 查询 localStorage/sessionStorage/cookie |

**实现要点**：
- `setValue` / `type` 对 input/textarea/select 用**原生 setter**（`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set`）绕过 React/Vue 对 `el.value` 的 setter 覆盖，否则受控组件不生效
- checkbox/radio 用 `checked` 原生 setter + 派发 click+change（框架常绑这两类事件）
- radio 的 val 有值即选中（同组互斥自动生效）

---

## 6. 🚨 工程陷阱（踩过坑的，必读）

### 陷阱 1：console 构建产物不生效（最高频）
**症状**：改了 `apps/console/` 代码，重启 server 后 UI 没变化，或测试失败。
**根因**：server 服务的是 `packages/server/public/`，不是 `apps/console/dist/`。
- `cd apps/console && pnpm build` 只更新 `apps/console/dist/` → **无效**
- 必须**根目录 `pnpm build`**，它跑 `copy:assets`：
  ```
  cp packages/sdk/dist/index.iife.js packages/server/public/sdk.js
  cp -r apps/console/dist/* packages/server/public/
  ```
- `copy:assets` 只增不删 → `server/public/assets/` 会**积累过时产物**，必要时手动清理 `packages/server/public/assets/` 后重新构建

### 陷阱 2：serializeResult 截断导致快照解析失败
**症状**：页面元素增多后，server 日志报 `[快照解析失败]`。
**根因**：`__silkpulse_snapshot()` 的 JSON 超过截断阈值被截断 → `JSON.parse` 失败。
**修复**：`MAX_RESULT_LEN` 从 4000 提升到 **20000**（典型快照 2-8KB，大页面 15KB+，20K 既能容纳完整快照又能挡住 `return document` 失误）。

### 陷阱 3：v-model 覆盖光标/选区
**症状**：exec 编辑器 Tab 缩进后光标位置错乱。
**根因**：`requestAnimationFrame` 回调在 Vue 的 DOM 更新**之前**执行，v-model 同步 textarea.value 时覆盖了 rAF 设置的选区。
**修复**：改用 **`nextTick()`**（在 Vue DOM 更新**之后**执行），稳定恢复光标/选区。

### 陷阱 4：FormData POST 崩溃 server
**症状**：`/api/echo` 收到 FormData multipart body 时 server 崩溃（Node 未捕获异常），日志：`SyntaxError: No number after minus in JSON at position 1`（对应 `------WebKitFormBoundary...`）。
**根因**：`JSON.parse(body)` 无 try-catch。
**修复**：echo 端点 try-catch 包裹 `JSON.parse`，非 JSON 时回退原始文本。
**教训**：所有 `JSON.parse` 都必须有 try-catch（exec/tags 已有；ws-relay 已有；snapshot-text 已有 —— 全部已审计）。

### 陷阱 5：iframe 测试 flaky
**症状**：固定 `sleep 800ms` 后 iframe 内元素仍找不到。
**修复**：改**轮询**（20 次重试 × 100ms，检查 `ifr.contentDocument.querySelector('#iframe-btn')`），不依赖固定延时。

### 陷阱 6：page.keyboard 受信任事件 vs dispatchEvent
测试键盘交互时，用 `page.keyboard`（puppeteer 受信任事件）比手动 `dispatchEvent` 更接近真实用户。调试 handler 执行可通过 `document.body.dataset.tabdbg = 'xxx'` 追踪。

### 陷阱 7：exec 序列化的字符串带引号
`serializeResult` 用 `JSON.stringify`，所以**字符串结果会被加引号**。测试用 `includes()` 检查，不要用严格相等。

### 陷阱 8：exec 代码含 `return` 时必须是「return 表达式」
`handleExec` 检测 code 含 `\breturn\b` → 包成 `new Function('return (async () => { code })()')`。若写成 `(() => {...})()`（IIFE 作表达式语句、无外层 return）→ 返回 **undefined**。正确写法：`return (() => {...})()` 或 `return expr`。纯表达式（无 return）走间接 eval 自动返回值。

### 陷阱 9：snap chromium 多 tab 下 puppeteer 观测通道不可靠
矩阵测试 6 case 的 `page.evaluate` 偶发 `querySelector('#id')` 返回 null（同帧 `querySelectorAll('button')` 却正常）、`page.click` 报 `Cannot read properties of undefined (reading 'startsWith')` / `Runtime.callFunctionOn timed out`。**单 tab 完全正常**，多 tab / 长连跑下 snap chromium 150 的 CDP 上下文偶发漂移。对策：验证脚本对目标页的**读和写都走 device exec 通道**（WS，与 SDK 同上下文），puppeteer 只负责开页/导航/注入，不做断言观测。

### 陷阱 10：React 后注入恢复的三个坑（react-devtools-bridge.ts）
1. **`__reactContainer$` 挂的是 HostRoot fiber（tag=3）不是 FiberRoot**——取 `fiber.stateNode` 才是 FiberRoot（有 `containerInfo`/`current` 等字段）
2. **不能用 `stateNode.current === container` 做身份校验**——commit 后 double buffering 使 `root.current` 切到 alternate fiber，容器标记仍是初始 fiber，恒 false。正确判据：`'current' in fiber.stateNode`（backend `recordMount` 按 `fiber.stateNode` 即真实 FiberRoot 做 `rootToFiberInstanceMap` 的 key）
3. **hooks 重放需要 `currentDispatcherRef`**——backend bundle 自带 react 副本与页面 react-dom 的 internals 不同源，inspect hooks 时报 `#321 Invalid hook call`。合成 renderer 必须补 `currentDispatcherRef: reactGlobal internals 的 ReactCurrentDispatcher`（React 18 key：`__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`；React 19：`__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`）

### 陷阱 11：React 生产构建 set 是官方级限制，如实报错
react-dom prod 的 inject 对象 `overrideHookState/overrideProps/scheduleUpdate` 全为 `null`（源码证实，官方扩展同此限制）。`setReact` 检测 `typeof renderer.overrideHookState !== 'function'` 时返回明确 error「目标页 React 是生产构建（bundleType=0）…」，**不要假成功**。树/inspect（只读）/点击交互在 prod 全部正常。

### 陷阱 12：frameworks 探测时序——真实 vite build SPA 先注入必踩
script 标签先注入时 SDK 在 `<head>` 同步执行，vite build 的 Vue/React app（ESM chunk 异步加载）**尚未 mount**，`collectDeviceInfo` 探到 `frameworks=[]` 上报后**永远没人重报**（只有 SPA 路由变化才重报）。控制台面板据 frameworks 判「不支持」直接不加载 client iframe，页面 app 起来后也无法自愈——用户看到的就是「vue build 的页面不支持」。修复：SDK 探测用**自适应间隔 setTimeout 链**（未探到框架 1s 高频，探到后 5s 低频兜底，变化才上报稳态零流量）；面板侧 `watch(frameworks)` 时 `reloadIframe()` 重新握手。验证脚本：`scripts/diag-vite-spa-preinject.mjs`（用 console 自身当目标页——它就是真实 Vue vite build 产物）。

---

## 7. compact 快照文本规则（测试匹配必读）

- **交互元素**（button/input/select/a/option）：显示 `idx`，**不显示 id**
- **非交互元素**：有 id 时显示 id
- **input** 显示 `ph:<placeholder>` → 测试通过 **placeholder 文本**匹配，不要用 id
- **头部含视口尺寸**：`# viewport: 375×667`
- **select 选项**：`<bj:北京|sh:上海|gz:广州>`（value:text 双标注）
- **表单状态**：disabled/readonly/required/indeterminate/aria-disabled/aria-expanded/当前 focus

匹配示例：
- select：`/select #(\d+)[^\n]*city/`
- checkbox：`/input #(\d+)[^\n]*check[^\n]*同意条款/`（交互元素，用 label 文本）
- radio：`/input #(\d+)[^\n]*(?:type:radio|radio)[^\n]*专业版/`

---

## 8. server 可靠性设计要点（已实现，别回退）

- **WS 背压保护**：broadcast 检查 `bufferedAmount`，慢客户端积压 >1MB 自动关闭，防拖垮内存；send 带回调避免竞态抛异常
- **SDK 离线缓冲**：启动期 + 断线期数据暂存内存队列（上限 200 条），重连后 flush，不丢早期错误
- **断线重连**：指数退避 1s/2s/4s...30s；重连定时器跟踪 + disconnect 清理（防幽灵 WS）；重连后历史缓冲完整保留
- **exec 超时**：SDK 端 9s（早于 server 10s），永不 resolve 的代码（`new Promise(() => {})`）有兜底；正常完成 clearTimeout（防 unhandledrejection 被 error-catcher 误报）；设备掉线立即 reject pending exec + clearTimeout
- **exec 日志截断**：海量日志保留头 100 + 尾 100 + 中间省略标注，防 WS 帧撑爆
- **HTTP body 上限**：POST >2MB 返回 413；客户端中断 readBody 正常 resolve 不泄漏 promise
- **错误风暴去重**：循环错误首现秒到，后续聚合"重复 N 次"汇总；errorCount 反映真实总数
- **资源加载失败**（404 图片/脚本）不计入 errorCount，降级为快照提示
- **日志限流**：滑动窗口 50 条/秒（error 级不限流）
- **最近下线设备历史**：`recentlyOffline`（上限 10），AI 区分"从未接入"vs"接入过但掉了"
- **WebSocket 采集**：WS 连接作为 NetworkEntry（protocol:'ws'），帧增量更新（seq 关联，与 log-repeat 同模式）；单连接帧上限 50 FIFO，单帧 data 截断 500，Blob 消息异步读 text；排除 SDK 自身 /ws/device 连接（避免采集调试通道）

---

## 9. CLAUDE.md 工程约定（摘自全局指令）

- **中文沟通**，"知之为知之是知也"
- **Git 直接提交当前分支（master）**，个人项目无 PR，不开分支
- **TypeScript**：禁止 `as` 改对象类型（尤其 `as any`）；改完 ts 跑 `pnpm tsc --noEmit`
- **let it crash**：开发阶段快速失败，不过度用 try（除非设计需要，如 JSON.parse）
- **不主动做运行时测试** —— 但本项目用户明确要求无头浏览器验证，属例外
- **迭代优于下标**：`for of` 替代 `for i++`
- **JSDoc**：`/** */` 放在变量/参数/函数/属性**上方**，不写 `@param`/`@returns`
- **只要最佳方案**，不要回退方案
- Tailwind v4 用 **oklch** 色彩空间，非 rgb

---

## 10. 当前状态（截至 2026-08-15）

- 分支：`master`，已迭代至 53+ 轮
- 最近提交：**Vue/React DevTools 后注入桥接恢复（矩阵 36/36 全绿）**——8 场景矩阵（Vue dev/prod × React prod × 先/后注入）全通过：available 探测、组件树、inspect state/hooks、set 写入（React prod 如实报能力受限）、恢复后交互。React 后注入修复三层 bug（HostRoot fiber 语义 → FiberRoot 身份 double buffering → hooks 重放 currentDispatcherRef 不同源 #321，详见陷阱 10/11）。console DevTools 面板新增「不支持框架」提示（探测结果 frameworks 为空或不含当前插件时显示 🚫 明确文案，不再无限「连接中…」，已浏览器实测三种场景）
- 前一轮：inspect CLI WebSocket 连接独立段（WS 条目从失败/慢请求分析中分离，不再被 readyState=0 误判为失败）；WebSocket 采集（连接/send/recv/close 帧时间线）；连续重复日志聚合（repeat 计数）；network 详情 JSON body 格式化；__silkpulse_storage 查询 localStorage/sessionStorage/cookie；inspect 失败请求段附带响应体；__silkpulse_click 触发完整鼠标事件序列（覆盖 mousedown 自定义组件）；setValue 支持 checkbox/radio + 修复 radio 同组互斥；FormData body 采集 + echo 非 JSON 不崩溃；errors 复制全部按钮；pressKey + 截断阈值提升；source map fetch 超时；Tab 缩进；inspect 聚合；scroll/hover；exec 日志截断；setValue 支持 select；Request body 采集
- 测试：无头测试 **94 项**全通过
- network 面板支持 WebSocket：WS 连接作为 network 条目，点击展示 send/recv/event 帧时间线（对齐 DevTools WS Messages）
- `__silkpulse_setValue` 已支持 checkbox/radio（含 radio 同组互斥，合成事件下手动取消同组）
- `__silkpulse_click` 触发 mouseover→mousedown→mouseup→click 完整序列（覆盖 div[role=button] 监听 mousedown 的自定义组件）

---

## 11. 持续改进方向（/loop 哲学）

用户的持续指令：**"不断完善此项目，并使用无头浏览器进行真实验证，不要再询问我，不要切换 plan 模式"**。

迭代模式：
1. 发现能力差距 / 陷阱
2. 实现（遵循 CLAUDE.md 约定）
3. `pnpm typecheck`
4. **根目录 `pnpm build`**（不是 apps/console）
5. 重启 8083 server
6. `SILKPULSE_SERVER=http://localhost:8083 pnpm test`
7. 更新 README（测试数 + 功能描述）
8. 直接提交 master

每轮聚焦一个可验证的小改进，用无头测试兜底正确性。
