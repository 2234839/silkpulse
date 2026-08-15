# uWS PoC —— 复刻 silkpulse 压测语义的 uWebSockets.js 实现

**用途**：与 ws 库版 server 做同负载 A/B 对比（2026-08-15 实测决策，数据见 `docs/capacity-report-2026-08-14.md`）。

## 运行

```bash
# 独立沙盒安装（不进主项目依赖；Node ABI 变化需重装）
mkdir -p /tmp/uws-poc && cd /tmp/uws-poc
pnpm init
pnpm add github:uNetworking/uWebSockets.js#v20.52.0
cp <repo>/poc/uws/* .

# 启动（默认 8082；UWS_COMPRESS=shared|dedicated|none）
PORT=8082 UWS_COMPRESS=shared node server.mjs

# 冒烟（协议链路：register/log/subscribe/扇出/exec）
node smoke.cjs

# A/B 压测（与 ws 基线同参数）
cd <repo>
SILKPULSE_TEST_URL=http://localhost:8082 SILKPULSE_ADMIN_KEY=none \
  node --max-old-space-size=4096 scripts/load-test.mjs \
  --skip-ramp --devices 2000 --consoles 10 --per-console 5 --logs 3 --duration 30

# 公平 CPU 采样（含 uWS 原生线程；ELU 只测 JS 线程会严重低估 uWS 工作量）
node cpumon.cjs <PID> 45
```

## 复刻的语义（对齐真实 server）

- `/ws/device`：register（设备表 + device-list 广播）/ log（环形缓冲 500 + 扇出）/ exec 指令下发
- `/ws/console`：subscribe/unsubscribe 订阅表、device-list/online 推送
- `/api/health`：RSS / eventLoopUtilPct / fanout 四指标（同口径）
- `/api/devices/:id/exec`：pendingExecs + 10s 超时
- 背压：getBufferedAmount > 1MB 关闭（对齐 MAX_BUFFERED）

## uWS API 关键差异（迁移时的高危点，PoC 里都踩过）

1. `res.upgrade()` 第 5 参必须是 upgrade handler 的 `context` 参数（传别的会 socket hang up）
2. 任何异步 handler 返回前必须 `res.onAborted(() => {})`，否则进程直接 abort（`Returning from a request handler without responding or attaching an abort handler is forbidden!`）
3. `res.end()` 后 res 不可再碰；响应状态/头必须在 end 前写
4. message 回调的 data 是 ArrayBuffer，需 `Buffer.from(data)`
5. 静态文件/大响应没有 node:http 的流式 res，需自行分块
