# 小程序（WeChat Mini Program）接入可行性调研

> 调研日期：2026-08-17。仅调研结论，未立项，未改代码。
> 背景：silkpulse 已支持 Web 目标页（Vue/React DevTools 桥接 + React Native 已完成
> 可行性调研），评估接入微信小程序场景的可行性与路径。

---

## 一、总结论

**可行，且比 RN 更"Web 相邻"**——小程序的逻辑层是纯 JSC/V8 JS 环境（**无 eval 限
制**这点与 Hermes 相反），渲染层是类 Web 环境。核心障碍不在引擎，而在**环境 API 差
异 + 传输通道 + 注入时机**，三者都有成熟解法。

两条主线（与 RN 调研同构）：

1. **探针主线（推荐）**：编译期打包 `mp-sdk` 包 + 远程开关初始化
2. **框架桥**：uni-app / Taro 项目的 Vue/React DevTools 桥（有现成方案，但独立于探针主线）

---

## 二、小程序运行环境关键事实（决定架构）

| 事实                                                                        | 影响                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 双线程架构：逻辑层（App Service，纯 JS，无 DOM/BOM）+ 渲染层（WebView）     | snapshot/dom-watcher/mouse-tracker **全灭**；console/network/error **可救** |
| 逻辑层是 JSC（iOS）/V8（Android/DevTools），**支持 eval**                   | exec 通道在开发版/体验版**可用**；线上版受「动态执行」合规限制              |
| 无 `window`/`document`，全局是 `wx` + `globalThis`（部分基础库）            | 采集器不能碰 DOM API，需环境探测分支                                        |
| 网络只有 `wx.request`/`wx.uploadFile`/`wx.connectSocket`，无 fetch/XHR      | network-collector **需重写**为 wx API hook                                  |
| console 是可重写的全局对象                                                  | log-collector **思路完全复用**                                              |
| 错误入口：`App.onError` + `App.onUnhandledRejection` + `wx.onError`         | error-catcher 需改为 App 生命周期包装                                       |
| storage 是 `wx.setStorageSync` 等                                           | storage-watcher 需 hook wx API（不是 localStorage）                         |
| 代码注入：**无 bookmarklet/userscript 等价物**，代码只能编译期打包进 bundle | 同 RN：IIFE 后注入死路，探针须打包进去                                      |
| 调试通道：微信开发者工具的 vConsole/Chrome DevTools 协议**不对第三方开放**  | 不能蹭官方调试通道，必须自建 WS 上报                                        |

## 三、传输通道（最关键的架构决策点）

小程序没有浏览器 WebSocket 的任意跨域能力，且**线上版 `wx.connectSocket` 要求
wss + 域名在「socket 合法域名」白名单**。三条路：

### 路径 A：wx.connectSocket 直连 server（推荐，开发/体验版）

- `wx.connectSocket({ url: 'wss://silkpulse.xxx/ws/device' })`
- 开发者工具中可勾选「不校验合法域名」，本地/内网联调零阻力
- 体验版需在小程序后台配置 socket 合法域名（需 HTTPS 备案域名——silkpulse 已有
  `silkpulse.heartstack.space`，加 wss 证书即可）
- **线上版限制**：正式版探针默认应关闭（远程开关控制），这也是业界通用做法

### 路径 B：HTTP 轮询降级（wx.request）

- server 已是 HTTP+WS 双协议，补一个 `/api/device/poll` 轮询端点即可
- 用于 wss 不可达或域名受限场景，exec 通道延迟高但可用

### 路径 C：本地中转（开发者工具场景专属）

- 开发者工具的逻辑层实际是 Node 环境，可写一个「工具插件」把数据桥到本机
  silkpulse server——体验最好但仅限开发期，可作为二期优化

**推荐：A 为主 + B 兜底，C 二期。**

## 四、模块适配清单

| 模块                                                                        | 复用度        | 小程序适配方案                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws-client.ts`                                                              | ⚠️ 大改       | 换 `wx.connectSocket`（onOpen/onMessage/onClose 回调风格，非 addEventListener）；无 `bufferedAmount` 背压，用队列长度自限；deviceId 持久化换 `wx.setStorageSync`                        |
| `log-collector.ts`                                                          | ✅ 思路全复用 | console 对象同样可重写（开发者工具里有 console；真机上基础库也提供）                                                                                                                    |
| `network-collector.ts`                                                      | ❌ 重写       | hook `wx.request`/`wx.uploadFile`/`wx.downloadFile`，参数结构不同（`{url, data, header, success}` 回调式），需包装成 Promise 或 Promise+回调双兼容；无 URL 类 → 手写解析或内置 polyfill |
| `error-catcher.ts`                                                          | ⚠️ 中改       | `App({ onError, onUnhandledRejection })` 包装 + `wx.onMemoryWarning`；无 window.onerror                                                                                                 |
| `storage-watcher.ts`                                                        | ⚠️ 中改       | hook `wx.setStorageSync`/`wx.removeStorageSync`；`getStorageInfoSync` 提供容量快照                                                                                                      |
| `snapshot.ts` / `dom-watcher.ts` / `mouse-tracker.ts` / `screen-capture.ts` | ❌ 不可用     | 无 DOM 无截图 API；二期可考虑「setData dump」作为弱快照（见下）                                                                                                                         |
| `exec-runner.ts`                                                            | ⚠️ 分版本     | 逻辑层 JSC/V8 支持 eval → 开发/体验版可用 eval 执行；**线上版禁用**（微信审核对动态执行有合规风险），用注册制 API 降级（同 RN 方案：`silkpulse.registerApi('getXxx', fn)`）             |
| `devtools-bridge.ts` / `react-devtools-bridge.ts`                           | ❌ 直接不可用 | 小程序自定义组件体系非 Vue/React 实例树（uni-app/Taro 例外，见第六节）                                                                                                                  |
| server `devtools-relay`                                                     | ✅ 零改动     | 若做框架桥，加 `DevToolsPluginId: 'mp'`                                                                                                                                                 |

### 弱快照设想（二期）：setData dump

小程序渲染由 `setData` 驱动，hook 页面/组件的 `setData` 可拿到「最后一次提交给渲染
层的数据」——虽非 DOM 快照，但对 AI 诊断「页面显示为什么不对」有相当价值：

```ts
/** hook setData 记录最后提交的渲染数据，作为小程序版弱快照 */
const origSetData = Page.prototype.setData;
Page.prototype.setData = function (data, cb) {
  record(this.route, data);
  return origSetData.call(this, data, cb);
};
```

## 五、探针形态与初始化

```ts
// packages/mp-sdk —— 小程序探针（新包，编译期打包进小程序）
import silkpulse from "@silkpulse/mp-sdk";

App({
  onLaunch() {
    /** 远程开关：正式环境默认关闭，避免审核与性能问题 */
    if (wx.getStorageSync("silkpulse:enabled")) {
      silkpulse.init({
        server: "wss://silkpulse.heartstack.space/ws/device",
        apiKey: "cs_live_xxx",
      });
    }
  },
});
```

- 新建 `packages/mp-sdk`（而非塞进现有 sdk）：环境 API 差异太大，强行同包会互相
  污染；但 log-collector 等纯逻辑模块可从 `packages/sdk` 直接复用源文件或抽到
  `packages/shared` 层
- 构建产物为 CommonJS/ESM 双格式（小程序 npm 支持"构建 npm"，或直接源码集成）

## 六、框架场景：uni-app / Taro（重要加分项）

大量小程序由 uni-app（Vue3）或 Taro（React）编译产出，这类项目逻辑层**保留了
框架运行时**：

- **Taro**：官方有 `@tarojs/plugin-html` 时代的 React DevTools 支持（Taro 3+ 支持
  react-devtools，通过 `@tarojs/react` 桥接）
- **uni-app**：HBuilderX 内置 Vue DevTools 支持，但真机/远程场景无现成方案
- 结合本项目已有的 Vue/React devtools 桥能力（`devtools-bridge.ts` /
  `react-devtools-bridge.ts`），可评估在小程序逻辑层内跑 devtools backend，数据走
  silkpulse WS 通道透传到 console——与 RN 调研的 `connectToDevTools` 代理方案同构
- **风险**：小程序逻辑层无 `__VUE_DEVTOOLS_GLOBAL_HOOK__` 注入时机（须编译期由
  探针先装 hook 再 import 框架）；Taro/uni 的 devtools 集成版本较旧，需验证 Wall
  协议兼容性（同 RN 的版本匹配问题）

## 七、分期建议

| 期  | 内容                                                                                                                  | 工作量估计                 |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| P1  | `mp-sdk` 探针：ws 通道 + console/network(wx.* hook)/error/storage 采集 + 远程开关 + 开发者工具联调打通                | 3~5 天                     |
| P2  | exec 注册制 API（线上版安全通道）+ setData 弱快照 + console 面板小程序适配（DeviceInfo 加 platform 字段，同 RN 方案） | 2~3 天                     |
| P3  | uni-app/Taro 框架 devtools 桥（复用现有 Vue/React 桥）                                                                | 1~2 周（版本兼容验证为主） |

## 八、合规与风险

1. **微信审核**：正式版包含探针需谨慎——动态执行（eval exec）有被拒风险，P1 先只
   面向开发/体验版；探针默认关闭 + 远程开关是底线设计
2. **性能**：逻辑层 hook 有微量开销，network hook 需注意大数据量上报截断（现有
   SDK 已有截断机制可复用）
3. **基础库兼容**：`wx.connectSocket`/storage API 在低版本基础库行为一致，风险低；
   `globalThis` 需基础库 2.11+，探针内避免依赖
4. **多端小程序**（支付宝/抖音/百度）：wx.* 换 my._/tt._/swan.*，建议探针做一层
   `adapter` 抽象（同 RN 的 connectToDevTools 代理思路），P1 只做微信
