# Devframe 借鉴改造：auth 安全传递 + DevToolsDock 协议统一

> 来源：2026-09-29 对 devframe（https://github.com/devframes/devframe）的整体源码分析。
> 结论：RPC 协议**不换**（官方 devtools frontend 硬性要求 SuperJSON/wall 格式）；auth 抄 2 个设计；
> vue/react devtools 面板抽成统一的 DevToolsDock 注册协议。

## 目标

1. **auth token 支持 URL fragment 传递**：console 分享/书签场景 token 走 `#token=...`（fragment 不进
   server 日志、Referer、浏览器历史），替代/兼容现有 `?token=` query 传递。
2. **BroadcastChannel 兄弟 tab token 共享**：同浏览器多开 console tab，一次输入 key 全部生效。
3. **抽象 DevToolsDock 统一注册协议**：vue / react devtools relay 面板统一为一个注册接口，
   新框架 devtools 接入 = 注册一个对象；预留未来 `createPluginFromDevframe` 挂进 Vite DevTools 生态的薄适配层。

## 约束

- 官方 devtools frontend 的消息格式（SuperJSON 信封 / react-devtools wall）不可改动。
- `?token=` query 传递必须保持兼容（现有用户链接不失效）。
- 三种身份（admin / project / playground）× HTTP × `/ws/console` × 设备 WS 鉴权矩阵行为不变。

## 方案

### A. auth fragment token（对应 auth.ts）

- console 侧：启动时优先从 `location.hash` 解析 `#token=...`，解析后立即 `history.replaceState`
  清掉 fragment（防历史同步泄漏），再写入与 query 同源的存储位。
- server 侧：`extractQueryParam(url, "token")` 逻辑不变（server 永远看不到 fragment，无需改）；
  改的是**客户端从 hash 注入到 WS 连接 token 参数的路径**。
- 断言：改造后 server 访问日志、Referer 头中不出现 token。

### B. BroadcastChannel tab 共享（参考 devframe `devframe-auth` channel）

- console 新建 `BroadcastChannel("silkpulse-auth")`：一个 tab 鉴权成功后广播 token；
  其他 tab 收到后更新本地凭据并重连 WS。
- 登出/失效同样广播。

### C. DevToolsDock 协议

```ts
interface DevToolsDock {
  /** 框架标识：devtools-relay 的 plugin 字段（"vue" | "react" | ...） */
  plugin: string;
  /** 面板 iframe / SPA 挂载点标识 */
  panelId: string;
  /** 该 dock 是否可用（如页面检测到 Vue app） */
  probe: (info: DeviceInfo) => boolean;
  /** 生命周期：面板激活 / 刷新 / 停用 */
  onActivate / onRefresh / onDeactivate
}
```

- vue/react 现有 relay 逻辑各自实现该接口，console 面板注册表统一驱动。
- 刷新指令 `__silkpulse_refresh__`、重激活（react 的 muteActiveWall/reactivate）收进各实现。

## 验证方法（2026-09-29 已全量验证）

- [x] `pnpm tsc --noEmit -p apps/console / packages/server / packages/sdk` 零错误（全仓根 tsc 的 24 个错误均为存量：根 tsconfig moduleResolution 与各包不一致 + node_modules 声明缺失，与本次无关）
- [x] `scripts/headless-test.mjs` 94/94 通过（顺带修复存量断言 [93]：AI 上下文弹窗已重构为 assemble() 四段 section，测试断言没跟上，已对齐）
- [x] `scripts/devtools-matrix-test.mjs` 36/36 通过（vue/react × dev/prod × 先/后注入全矩阵，DevToolsDock 重构零回归）
- [x] 鉴权矩阵：admin/project/playground × HTTP(401/200) × /ws/console(拒/纳) 全通过（`.claude/replay/auth-fragment-broadcast.mjs`）
- [x] fragment：`#key=` 注入后地址栏清空（含 router 初始化后不回写）、localStorage 落库；`?key=` 兼容路径不回归
- [x] BroadcastChannel：key-updated 兄弟 tab 采纳、key-cleared 同步登出
- [ ] 安全断言（server 日志/Referer 无 token）：fragment 不发网络请求，结构性保证；待生产部署后抽查一次访问日志确认

## 坑与根因（已踩）

1. **vue-router 会把初始 URL 写回来**：`createWebHistory` 初始化时记住含 hash 的地址栏 URL，首次导航 ready 后 `replaceState` 回去——`restoreKeyFromUrl` 里清一次 hash 会被 router 复原。修复：清除动作在 `setTimeout(0)`（router 首次导航后）兜底再清一次（useAuth.ts `clearUrlKey`）。
2. **8080 上 server 服务的 console 是旧构建**：验证 console 侧新代码必须起 console vite dev（代理 /api /ws 到 8080），对 dev 端口跑断言；直接对 8080 跑会验到旧代码得出假失败。
3. **headless-test 的 DEMO_URL 只带 projectId 不带 apiKey**：demo 注入逻辑要求两者同时出现才注入 data-* 属性，本机 server 未配 SILKPULSE_ADMIN_KEY 时 SDK 无凭据 → 设备不上线。跑测试需 `SILKPULSE_ADMIN_KEY` 同时配给 server 进程和测试脚本（值必须一致）。
4. **WS 测试断言双触发**：`ws.onopen` 主动 close 后 `onclose` 也会触发，Promise resolve 两次会输出两条矛盾断言——断言脚本要做 settled 去重。

## 明确不做

- 整体迁移到 devframe（它是本地 dev、1:1、同源模型，与 silkpulse 远程注入 + 多设备聚合定位冲突）
- 替换 devtools-relay 消息协议为 birpc

## 补充坑（2026-09-29 集成浏览器可视化测试发现）

5. **vite dev 的 /plugins 代理缺口**：console dev server proxy 原来只有 /api /ws /sdk.js，`/plugins/*/index.html`（devtools client iframe 资源）被 SPA fallback 返回 console 首页 → iframe 里是控制台自己，DevTools 握手永远「连接中」。生产不受影响（server 直接 serve public），矩阵测试（跑构建产物）未暴露。修复：`apps/console/vite.config.ts` proxy 增加 `/plugins`。教训：dev/prod 资源路由差异必须有一条对 dev server 的可视化链路验证。

### 可视化全量测试记录（2026-09-29，集成浏览器手动链路）

- fragment `#key=` 注入 → 地址栏清空 + localStorage 落库 + 直接进入已登录态 ✓
- UI 登录（真实输入密钥点登录按钮）✓；退出按钮登出 ✓
- 双 tab：A 登出 → B 经 BroadcastChannel 同步登出（WS 凭据失效重连被拒）✓；B 登录 → A 同步进入已登录态 ✓
- 采纳新 key 后 WS 3 秒窗口内零 auth failed（重连成功）✓
- DevTools Vue 真实链路：目标页（vue-test-page）→ 面板「已连接」→ 组件树 <Root>/<UserCard> + 全量 state ✓；目标页交互（+1×3）→ 面板 count 实时同步 3 ✓；⟳ 刷新 → 树重新 flush ✓
- 不支持框架的页面（纯静态 demo）：显示「当前页面不支持 Vue/React DevTools」且不挂 iframe（v-else 分支）✓
