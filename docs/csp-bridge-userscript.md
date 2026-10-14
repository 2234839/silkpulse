# userscript 全量 CSP 穿透（GM 桥接通道）

## 目标

强 CSP 站（`script-src` 与 `connect-src` 双限制）也能通过 Tampermonkey userscript 全功能接入 silkpulse，不再需要「配合剥 CSP 响应头的扩展」这种半吊子方案。

## 根因（为什么 GM_addElement 只解决了一半）

- `script-src` 拦 DOM 注入 → `GM_addElement`（扩展特权通道）解决 ✅
- `connect-src` 拦页面上下文发出的 WebSocket / fetch → 油猴没有 GM WebSocket API，SDK 在页面 realm 里 `new WebSocket()` 必被拦 ❌

## 方案：GM_xmlhttpRequest 承载的 HTTP 桥接传输

油猴的 `GM_xmlhttpRequest` 走扩展特权网络通道，**不受页面任何 CSP 指令约束**。三层改造：

```
SDK (页面 realm)  ──window.postMessage──  userscript 宿主 (TM 沙箱)
                                              ├─ POST /ws/device-bridge/register  建会话
                                              ├─ POST /ws/device-bridge/uplink    上行批量(50ms 聚合)
                                              └─ GET  /ws/device-bridge/stream    SSE 下行流
```

1. **server**：新增 `packages/server/src/bridge.ts`（会话管理 + BridgeConn）；`DeviceChannel`（从 ws-relay 抽出的设备消息处理）与 `DeviceConn` 连接抽象让 WS / HTTP 桥接共用全部业务逻辑；registry 解耦 SilkWs。
2. **SDK**：`ws-client` 引入 `DeviceSocket` 抽象（WsAdapter 包原生 WS）；`<html data-silkpulse-bridge>` 标记存在时自动切 `BridgeSocket`（`bridge-socket.ts`，postMessage 转发）。重连/离线缓冲/device-id-conflict 逻辑零改动复用。
3. **userscript**（server `buildUserscript` + console `InjectPanel.vue` 两份模板，v0.3.0）：内置宿主，`@grant GM_xmlhttpRequest` + `@connect <server host>`。

## 关键坑

- **grant 沙箱与页面是隔离世界**：宿主设 `window.xxx` 页面看不见，DOM 是唯一可靠共享通道 → 宿主标记写在 `<html data-silkpulse-bridge>`，SDK 检测它决定传输方式。
- **register 必须是桥接会话首条上行**（server 端 channel 依赖 register 建设备上下文）：宿主先 POST register（空 messages）建会话 → 通知页面 open → SDK 才发 register 走 uplink。页面 send 先于会话就绪的消息由 ws-client 既有 sendQueue 缓冲，天然有序。
- **会话重建不能向新 BridgeSocket 发 close**：SDK 重连 → 新 init → 宿主 `createSession()` 若静默销毁旧会话时误发 close，新连接立刻自杀形成死循环 → `dropSession(notify)` 参数区分。
- **SSE 中断探测不能只靠 onAborted**（http-helpers 的 onAborted 首个注册生效）：心跳写 `res.write` 抛错时兜底摘除 SSE，会话靠 30s 空闲超时销毁；销毁走 registry 既有 5s 宽限期，重连无缝续接。
- **SSE 流式下行依赖 TM ≥ 4.10**（onprogress 增量 responseText）；`GM_addElement`/`GM_xmlhttpRequest` 均仅 Tampermonkey 支持。
- 根 `copy:assets` 脚本还在拷已不存在的 `apps/console/dist/*`（console outDir 已直写 server/public）→ 已修正脚本对齐现状。

## 验证方法

1. `pnpm tsc --noEmit`（server/sdk/console 三包）+ `vp check` 全绿。
2. `vp run -r build` 成功，`packages/server/public/sdk.js` 含 `data-silkpulse-bridge` 标记检测代码。
3. 功能验证：访问 `http://localhost:8080/inject/userscript` 安装到 Tampermonkey（≥4.10）→ 打开任意强 CSP 页面（如 docs.qq.com）→ 控制台应看到设备上线、console/network/exec 全功能可用。
