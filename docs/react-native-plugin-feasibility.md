# React Native 插件支持可行性调研

> 调研日期：2026-08-14。仅调研结论，未改任何代码。
> 背景：silkpulse 已支持 Web 目标页（Vue/React DevTools 桥接），评估接入 RN 目标的可行性与路径。

---

## 一、总结论

**可行，且架构上比 Web 版 React 桥更简单**，但 RN 探针的注入方式与 Web 完全不同，必须放弃"eval IIFE"思路。

两条主线：

1. **探针主线（推荐，分两期）**：编译期打包 RN SDK + 远程开关初始化
2. **注入等价物**：OTA 热更新下发含探针的 bundle（而非 eval）

---

## 二、现有架构对 RN 的适配度

```
现有架构（几乎不动）              RN 新增
┌──────────┐  devtools-relay   ┌──────────────┐
│  server  │◄────纯透传───────►│ console iframe│
└────┬─────┘                   └──────────────┘
     │ WS /ws/device（零改动）
     ▼
┌──────────────┐  connectToDevTools socket=代理
│  rn-sdk 包    │────────────────────────────► react-devtools-core Agent
└──────────────┘
```

| 模块 | 复用度 | 说明 |
|---|---|---|
| server `devtools-relay` | ✅ 零改动 | 纯透传，`DevToolsPluginId` 加 `'react-native'` 即可 |
| shared 协议类型 | ⚠️ 小改 | `DeviceInfo` 的 `url/title/icon/viewport` 在 RN 无意义，加 `platform` 字段并放宽 |
| `ws-client.ts` | ⚠️ 大部分复用 | RN 有 `WebSocket/setTimeout`；`sessionStorage`（deviceId 持久化）、`bufferedAmount`（背压）不存在，需条件分支 |
| `log-collector` | ✅ 直接复用 | 纯 console hook，RN 的 console 是 polyfill 同样可 hook |
| `network-collector` | ⚠️ 需审查 | RN 有 `fetch/XMLHttpRequest` 可 hook；**Hermes 无 `URL` 类**，URL 解析需 polyfill |
| `error-catcher` | ❌ 重写 | `window.onerror` → RN 用 `ErrorUtils.setGlobalHandler` |
| snapshot / dom-watcher / mouse-tracker / screen-capture | ❌ 不可用 | RN 无 DOM、无 `getDisplayMedia`（截图可选依赖 `react-native-view-shot`） |
| `exec-runner` | ❌ 根本性障碍 | 见下文 Hermes 无 eval |

## 三、三个硬约束

### 1. Hermes 无 `eval` / `new Function`（最硬）

- Hermes 为 AOT 字节码 + 安全，**引擎级移除**动态代码执行，调用直接抛错
- RN 0.70+ 默认、新架构强制 Hermes，是当今线上主流
- JSC 可 eval，但只是"已有代码"的能力——RN 没有 script/bookmarklet/userscript 这类运行时加载点，bundle 编译期锁定，**eval IIFE 注入这条路在 RN 上是死的**
- **exec 通道出路**：降级为注册制受限 API——App 侧主动注册诊断函数，AI 按名调用：
  ```ts
  silkpulse.registerApi('getCartState', () => useCartStore.getState())
  ```
  与项目 AI-native 定位吻合：暴露有语义的业务诊断接口，且 release 构建更安全。

### 2. react-devtools-core 版本匹配

- Web 版 frontend/backend 均为自构建 7.0.1，版本锁死一致
- RN 场景 backend 版本由 **App 内的 react-devtools-core** 决定（RN 0.7x 内置 4.x/5.x），与控制台 frontend 7.x 跨大版本，Wall 协议不保证兼容
- **出路**：`plugins/` 按版本放多份 frontend（`plugins/react-native/v4/`、`v5/`、`v7/`），backend 连上后上报版本，控制台按版本挂载对应 iframe；`sync-devtools-clients.mjs` 扩展同步逻辑

### 3. 环境差异面大

`location.href` / `document.title` / `navigator.userAgent` / `sessionStorage` 均不存在。
DeviceInfo RN 化：`Dimensions.get('window')` + `Platform.OS` + `expo-constants`（或原生 `ReactNative.PlatformConstants`）。

## 四、RN DevTools 桥接反而更简单的点

对照 Web 版 `react-devtools-bridge.ts` 的三大难题：

| Web 方案的难题 | RN 场景 |
|---|---|
| hook 必须在 react-dom 加载前同步存在（stub 方案） | ❌ 不需要——RN renderer（dev 模式）自己装 hook |
| backend 700KB 异步 fetch + new Function 加载 | ❌ 不需要——metro 静态打包 `react-devtools-core` |
| stub 收集 renderer/fiberRoots 再 replay | ❌ 不需要——renderer 早已 attach 到 hook |

RN SDK 只需调 `react-devtools-core` 的：

```ts
connectToDevTools({ socket: 自定义代理, resolveRNStyle, isAppCommand })
```

把它的 WebSocket 消息代理到 silkpulse 的 `devtools-relay`（`plugin: 'react-native'`）。
前端复用 `react-devtools-inline` frontend（同一份源码，自带 RN 支持：style editor 走 `resolveRNStyle`）。

⚠️ `__DEV__` guard 必须做——release 构建中 renderer 剥离 devtools hook，`connectToDevTools` 整段不执行；
但 console/error/network 采集在 release 依然可用——**这是 silkpulse 的差异化价值**（metro 在开发者机器上，silkpulse 让用户设备上报时也能看到）。

## 五、"运行时注入"在 RN 世界的真实等价物

| 路径 | 原理 | 等效于 Web 的 | 覆盖面 |
|---|---|---|---|
| **OTA 热更新**（CodePush / Expo Updates / Sophix） | 下发含探针的新 bundle 整体替换 | 最接近 userscript（事后补装探针） | 装了 OTA 框架的 App |
| **CDP 调试通道**（`Runtime.evaluate`） | 真正意义的运行时 eval 任意 IIFE | 最接近 devtools console | 仅 dev/可调试构建 |
| **编译期打包**（npm 依赖 + 远程开关） | 探针随 App 发版 | 不等效，但最可靠 | 全量 |

- Hermes 无 eval 指 JS 层无 eval；但 Hermes inspector 协议的 `Runtime.evaluate` 可运行时注入执行任意 JS（metro 调试即靠它），**这是唯一能"eval IIFE"的通道**
- 若 silkpulse 做一层 CDP 中继（server 转发 CDP 消息，绕过"metro 必须在开发者本机"），可对用户设备上的 debug 包远程注入探针——与远程诊断定位契合，但只覆盖 debug 包
- ⚠️ iOS 审核（guideline 2.5.2）禁止动态下发可执行代码；CodePush 类框架是默许例外，裸"拉远程 JS 执行"有下架风险

## 六、关于 react-native-debugger 的说明

react-native-debugger 是本地 Electron 调试器（装在开发者电脑，通过 `adb reverse` 连真机 8081），架构假设"开发者在设备旁边"。silkpulse 价值场景是远程/线上（用户设备可能在异地，无法建 localhost 隧道），**不能复用其本体**，但可借鉴思路：让 App 内 `react-devtools-core` 的 WS 消息改走云端中继，控制台复用同一份 frontend。

## 七、工作量估算（若立项）

| 部分 | 内容 | 规模 |
|---|---|---|
| `packages/rn-sdk`（新包） | ws-client 复用改造 + console/error/network 采集 + devtools socket 代理 + 注册制 API | ~800–1200 行 |
| `packages/shared` | `DeviceInfo` 加 `platform`、`DevToolsPluginId` 加值 | ~30 行 |
| `packages/server` | 类型联动，透传逻辑零改动 | ~0 行 |
| `apps/console` | `DevToolsPanel.vue` 注册插件 + RN 设备卡片微调 | ~100 行 |
| `plugins/react-native/` | 多版本 frontend + `sync-devtools-clients.mjs` 扩展 | ~100 行 |
| 验证 | examples 最小 Expo app；headless 测试不可复用（无 DOM），需 RN 侧手测 | — |

## 八、风险与开放问题

1. **RN 0.76+ 官方转向 React Native DevTools（CDP 协议）**——绑定 metro 本地 CDP server，与远程场景不匹配；**不走 CDP 方向**，坚持 `react-devtools-core` Wall 协议直连。需验证最新 RN 里 `connectToDevTools({ socket })` 自定义 socket 注入是否仍受支持
2. **frontend 多版本维护成本**：React 18/19 时代 RN 项目并存，可能需同时伺服 2–3 个 frontend 版本
3. **WebSocket 二进制帧**：Wall 消息是文本 JSON，RN WS 支持，无障碍；但 RN WS 无 `bufferedAmount`，SDK 背压逻辑需容错
4. **网络采集 URL 解析**：Hermes 无 `URL`，需 `whatwg-url` polyfill 或手写轻量解析

## 九、建议路线（两期）

- **一期（核心价值，低风险）**：RN SDK 的 console + error + network 采集 + 注册制诊断 API——不依赖 react-devtools，先打通"远程真机日志诊断"闭环
- **二期（锦上添花，高复杂度）**：react-devtools 桥接 + 多版本 frontend 伺服——组件树/状态查看；PageSpy 对 RN 支持仅到日志级别，组件树是差异化亮点
