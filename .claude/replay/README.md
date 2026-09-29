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
