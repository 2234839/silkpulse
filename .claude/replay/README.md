# 回放脚本集（断言式验证）

标准场景回归脚本，输出红/绿 + 失败原因。运行前需 server 在 8080 且带鉴权环境变量（值与测试脚本一致）：

```bash
SILKPULSE_ADMIN_KEY=xxx SILKPULSE_PLAYGROUND_KEY=yyy node packages/server/dist-bin/silkpulse.mjs --static packages/server/public
```

## auth-fragment-broadcast.mjs

- 对应需求：`docs/devframe-adoption.md`（auth fragment 注入 + BroadcastChannel tab 共享）
- 断言内容：HTTP/WS 鉴权矩阵（无 token/错误 token/两密钥）、`#key=` fragment 用后即清、`?key=` 兼容、key-updated/key-cleared 跨 tab 采纳
- 运行：`SILKPULSE_SERVER=http://localhost:5199 SILKPULSE_ADMIN_KEY=... SILKPULSE_PLAYGROUND_KEY=... node .claude/replay/auth-fragment-broadcast.mjs`（**必须对 console vite dev 端口跑**，8080 上是旧构建会假失败；console vite 需另起：`cd apps/console && npx vite --port 5199`）
- 历史根因：vue-router createWebHistory 会把初始 hash 写回（见 doc 坑 1）

## verify-devtools-agent-api.mjs

- 对应需求：`notes/agent-capabilities.md`（ai.component-query / ai.devtools-capability）
- 断言内容：skill 文档含 DevTools 辅助函数说明、组件查询流程、Chrome DevTools 面板映射 → 设备上线 → `__silkpulse_devtools_available()` vue:true → `__silkpulse_devtools_tree()` 组件树非空 → `__silkpulse_devtools_inspect(idx)` 读到 props/state
- 运行：server 8080 运行 + `cd examples && python3 -m http.server 9099` 后 `node .claude/replay/verify-devtools-agent-api.mjs`
- 历史根因：
  - 设备上线 ≠ Vue 已挂载：unpkg 加载 + createApp 有延迟，available/tree 需轮询重试，否则 vue:false 假阴性
  - 已关闭连接的设备会残留 `/api/agent/devices` 列表直到超时，逐台 exec 探活后再用
