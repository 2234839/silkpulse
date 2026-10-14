# Elements 面板升级：桥接 Chrome DevTools 官方 Elements 面板

## 目标

用 Chrome DevTools 官方 Elements 面板替换/增强现有轻量版 `ElementPanel` 的 DOM 树+样式体验，
接入方式与 Vue/React DevTools 相同——通过 devtools-relay 做一层桥接（dock 模式）。

## 背景/约束

- Chrome DevTools 前端开源（`ChromeDevTools/devtools-frontend`，Apache 2.0），但 Elements 面板
  消费 CDP `DOM.*`/`CSS.*` 域消息，这些域的真实实现在 Blink C++ 层（InspectorDOMAgent），
  **官方没有页面内 JS 后端**——iframe 进 frontend 容易，没人应答协议。
- `liriliri/chobitsu`（MIT）：Chrome DevTools 协议的纯 JS 实现，跑在目标页面内应答
  `DOM/CSS/Runtime/Overlay` 等域，API：`chobitsu.sendRawMessage(json)` / `chobitsu.setOnMessage(fn)`。
- `liriliri/chii`（MIT，同作者）：chobitsu + 官方 devtools-frontend 的完整远程调试器，
  证明这条链路可行。其发布物 `public/front_end/`（14MB）就是官方 frontend 构建产物，
  其中 `entrypoints/chii_app` 支持 **embedded 模式**（`#?embedded=<origin>` hash +
  postMessage 通信，不需要 WebSocket）。
- 参考实现：`maitrungduc1410/devtools-frontend-demo`（frontend iframe + chobitsu，
  postMessage 双向透传原始 CDP JSON 字符串）。

## 方案

```
控制台 DevToolsPanel dock iframe          server                目标页 SDK
┌─────────────────────────┐         ┌──────────┐      ┌────────────────────┐
│ /plugins/chrome-devtools │ postMsg │ devtools │ postMsg│ chobitsu-bridge.ts │
│ index.html → chii_app.js │◄───────►│ -relay   │◄─────►│ (加载 chobitsu.js, │
│ (embedded 模式)          │  (WS)   │  透传    │  (WS) │  应答 CDP 域)      │
└─────────────────────────┘         └──────────┘      └────────────────────┘
```

消息格式：双向都是**原始 CDP JSON 字符串**（chii embedded 模式原生格式），relay 纯透传。

- 握手：host HTML（index.html）onload 后向 parent 发 `{event:"__silkpulse_frontend_ready__"}`
  → dock `encodeFromClient` 转 `{activate:true}` → SDK 收到后懒加载 chobitsu →
  发 enable 序列（Network/Runtime/Debugger/DOMStorage/DOM/CSS/Overlay.enable）→
  向 frontend 发 `Page.frameNavigated` + `DOM.documentUpdated`（demo 验证过的序列）。
- SDK 侧 chobitsu 未就绪前到达的 frontend 消息先缓冲，加载完成后 flush。
- dock 注册在 `devtools-docks.ts`（plugin: "elements"），`isSupported` 恒 true
  （任何 DOM 页都能用），注册表首位 → 无框架页面的默认 dock。

## 资产供给

`scripts/vendor-chrome-devtools.mjs`：从 npm registry 拉 `chii` tarball 提取
`public/front_end` → `packages/server/public/plugins/chrome-devtools/front_end`，
拉 `chobitsu` tarball 提取 `dist/chobitsu.js` → 同目录，并生成 host `index.html`。
version.json 记录来源版本；build-plugins.mjs 注册 `chrome` builder（增量跳过）。
public/plugins/ 已 gitignore，随 deploy rsync 上线（与 vue/react 产物同机制）。

## 已知取舍

- chobitsu 是 CDP 的第三方再实现：Elements 主链路（DOM 树/样式/盒模型/计算样式）覆盖良好，
  高级特性（断点、profiler 等其他面板）不在本需求范围，面板可能报协议不支持属预期。
- frontend 14MB 静态资产：server 按需加载，iframe 打开时才拉取。
- 现有 ElementPanel（布局预览/实时画面/诊断卡）保留并存，不冲突。

## 状态

- [x] 方案调研（chii/chobitsu/demo 三源交叉验证）
- [x] vendor 脚本 + 资产落位（`scripts/vendor-chrome-devtools.mjs`，chii 1.15.5 / chobitsu 1.8.6）
- [x] SDK chobitsu-bridge（懒加载，仅打开面板时下载 448KB bundle）
- [x] console elements dock（注册表首位 = 无框架页默认 dock）
- [x] **Element 页签直接替换为官方面板**（2026-10-14，gs 拍板）：DevToolsPanel 加
  `lockedPlugin` 属性（锁定单 dock、隐藏切换条、不受框架探测影响），ConsoleApp
  Element 页签渲染 `<DevToolsPanel locked-plugin="elements">`；旧 ElementPanel.vue
  不再被引用（文件保留未删，布局预览/实时画面/Alt 点选等能力如需回迁可恢复）
- [x] 本地 E2E（2026-10-14）：DOM 树/样式/盒模型/Computed 页签全部工作，官方 Elements 面板完整渲染
- [x] **Console 页签也替换为官方面板**（2026-10-14，gs 拍板方案 1）：Console 页签渲染
  `<DevToolsPanel locked-plugin="elements" focus-panel="console">`（与 Element 页签共用同一
  frontend 实例，锁定 dock 不切换）；DevToolsPanel 新增 `focusPanel` 属性——链路首次接通时
  向 iframe 宿主发 `__silkpulse_switch_panel__`，宿主脚本在 shadow DOM 里用完整鼠标事件序列
  （mousedown/mouseup/click，带中点坐标）点击对应面板页签，实现连上即自动聚焦控制台
- [x] **网络数据适配接入官方 Network 面板**（2026-10-14，gs 拍板：两套网络面板并存）：
  chobitsu-bridge 的 network adapter 把 log-collector 的 network 条目合成为 CDP 事件
  （`Network.requestWillBeSent` / `responseReceived` / `loadingFinished` / `loadingFailed`，
  requestId = `net${seq}`），仅 activated 时合成（面板未开零开销）；SilkPulse 自有
  NetworkPanel 保留并存，两边同时可见
- [x] **日志接入官方 Console 面板**（2026-10-14）：log-collector 的 LogEntry 由
  `feedLogEntry` 合成为 `Runtime.consoleAPICalled`（type 映射 info/warn→warning/error/…，
  executionContextId=1）作为唯一数据源；chobitsu 自带 console hook 的事件在 setOnMessage
  出口丢弃（双路同发会导致每条日志重复两条）
- [x] Console 日志 E2E（2026-10-14）：console.log/warn/error 全部到达官方 Console 面板，
  级别徽标正确、无重复；JavaScript 上下文显示 top

### 验证方法

设备页注入 `sdk.js` → 控制台 DevTools 面板 → Elements dock →
应看到目标页完整 DOM 树 + Styles/盒模型（截图已核：h1 选中、盒模型 677×162 正确渲染）。

### 坑

- enable 序列响应用 `tmp` 前缀 id，chobitsu onMessage 里必须过滤（frontend 没见过这些 id，
  透传会刷 `Protocol Error: the message with wrong id`）
- host 页设 `#?embedded=` hash 要用 `history.replaceState`（`location.replace` 在文档加载中
  会 abort 当前导航，devtools 网络面板报 ERR_ABORTED）
- frontend iframe 重载后 activate 会重发，SDK 侧每次激活都要重发
  `Page.frameNavigated` + `DOM.documentUpdated`，否则重载后树空白
- chii frontend 的 embedded 连接类（`ms`）按 `e.origin === targetOrigin` 过滤入站消息，
  targetOrigin = `#?embedded=` 参数 = **控制台 origin**（从 ancestorOrigins 取，不能用 server origin）
- **Console 面板必须有 JS 执行上下文才接受日志**：chobitsu 对 `Runtime.enable` 的
  `executionContextCreated` 推送时机不可靠，面板会一直显示「JavaScript 上下文：未选择」并
  静默丢弃所有 consoleAPICalled。解法：激活时手工合成
  `Runtime.executionContextCreated`（id=1, name=top, isDefault），`feedLogEntry` 的
  executionContextId 与之对应
- 预 enable 序列**不要包含 Runtime.enable**：与手工合成 context 冲突时序不可控，Runtime
  域留给 frontend 自己 enable
- 宿主脚本切换面板页签：devtools frontend 的 tabbed-pane 忽略 `el.click()`，必须派发带
  clientX/Y 的完整 mousedown/mouseup/click 序列；页签栏在 shadow DOM 里，需递归遍历 shadowRoot
- `vendor-chrome-devtools.mjs` 的 host HTML 生成抽成 `writeHostPage()`，增量跳过路径也要
  重写 host（host 增强不应要求重拉 14MB 资产）
- 官方 Console 只显示连接建立后的日志（frontend 重载/握手窗口内的日志会丢），历史日志看
  SilkPulse 自有 Console/Errors 面板
