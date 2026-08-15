# silkpulse 单进程容量压测报告

> 日期：2026-08-14 · 环境：本机 Linux（WSL/容器），server 单进程 Node 24，`--max-old-space-size=2048`
> 压测脚本：`scripts/load-test.mjs`（模拟设备 WS + 模拟控制台 WS + HTTP 轮询/exec）
> 消息模型：真实产品形态——每个控制台只订阅自己观看的少量设备（默认 3 台），非全量扇出。

## 结论速览

| 规模（设备在线） | register p99 | 日志洪峰 | 扇出送达 | exec QPS（p99） | HTTP 轮询 p99 | server RSS | 事件循环利用率 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 32ms | 1k/s | 精确 100% | — | 6.9ms | 107MB | 52%（扇出） |
| 500 | 59ms | 4.9k/s | 精确 100% | — | 9.8ms | 255MB | 58% |
| 1000 | 65ms | 4.9k/s | 精确 100% | 2049（18ms） | 7.9ms | 341MB | 60% |
| 2000 | 128ms | 5.8k/s | 精确 100% | 2006（18ms） | 10.5ms | 417MB | 67% |
| 4000 | 227ms | 5.6k/s | 精确 100% | 2007（18ms） | 13.5ms | 484MB | 64% |

- **连接数不是瓶颈**：4000 设备 + 10 控制台在线，server RSS 484MB（约 100KB/连接增量），利用率 64%。先到顶的是压测客户端自身（1.28GB）。
- **消息速率是主要成本**：恒定 ~6k msg/s 入站下，利用率稳定在 63~67%，与连接数无关（2000↔4000 对比）。其中大头是 permessageDeflate 对每条消息×每连接的压缩。
- **背压保护按设计工作**：全量扇出压力测试（10 控制台×全订阅 500 设备 = 5 万 msg/s 出站）触发 MAX_BUFFERED=1MB 关闭慢消费者，保护 server 不被拖垮——这是保护机制生效，不是缺陷。
- **exec 链路规模无关**：2000 QPS、p99 18ms，从 1000 到 4000 设备在线几乎无变化。

## 容量答案

> **单进程可稳定支撑 4000+ 设备同时在线、每秒 6000+ 条设备消息、每台控制台实时订阅自己观看的设备。**

按真实产品形态（几十~几百台设备、少数控制台、每控制台看 1~5 台），当前架构余量在 10 倍以上。

## 已做的改动（本轮）

1. **删除 IP 限流**（`auth.ts`）：与远程调试产品形态冲突（设备常在同一 NAT 出口），安全边界由密钥承担。
2. **`/api/health` 指标修正**（`api.ts`）：
   - `monitorEventLoopDelay` 在本机 idle 也报 ≥resolution（timer 精度问题），不可信 → 换 `eventLoopUtilization`（增量窗口，实测 idle=0%、busy=27% 精确）。
   - 新增 `fanoutSent/skippedClosed/skippedProject/backpressureClosed` 广播计数（来自 `ws-relay.ts` 的 `fanoutStats`），用于区分"server 截断"与"客户端收不动"。
3. **压测脚本完善**（`load-test.mjs`）：
   - 控制台订阅模型改真实形态（`--per-console N`，默认 5）
   - 控制台接收计数改对象引用（修"0 条广播"bug）
   - 模拟设备实现 exec 响应（协议 `result` 为嵌套 `ExecResult`）
   - 接收侧免全文 JSON.parse（正则抽 type）

## 决策记录

- ~~**不换通信层库**（uWebSockets.js）~~ → **已实测推翻，见下方「uWS 实测决策（2026-08-15）」**。
- **不做消息合并/裁剪**：合并（WS 本身 TCP 流式 + deflate 上下文跨帧共享）与裁剪（功能降级）都被否决。
- **背压上限维持 1MB**：保护慢消费者场景验证有效。
- 未来真撞 10k+ msg/s 或万级连接时，优先级：uWebSockets.js（连接密度）→ worker_threads 分片控制台 → 进程级水平扩展（registry 分片）。

## uWS 实测决策（2026-08-15）

同负载 A/B（`scripts/load-test.mjs` 同参数打真实 server 与 uWS PoC，uWS PoC 复刻压测路径全部语义：register/环形缓冲 500/扇出/背压 1MB/exec 10s 超时/health 同口径，`SHARED_COMPRESSOR` 压缩已协商验证）：

| 指标（2000 设备 / 6k msg/s / 10 控制台 × 5 订阅） | ws（现役） | uWS PoC | 差异 |
|---|---|---|---|
| 进程总 CPU avg（外部 /proc 采样，含原生线程） | 80.2% | 14.3% | **-66pp** |
| 事件循环利用率（洪峰段） | 75-92% | 8% | JS 线程让出 I/O 给 C++ |
| 洪峰后 server RSS | 512-549MB | 245-279MB | **-50%** |
| 广播送达率 | 30%（1338/4450，严重掉帧） | **100%**（4400/4400） | ws 已饱和丢消息 |
| exec QPS（并发 10） | 2006 | 3332 | +66% |
| exec p99 | 18.3ms | 10.8ms | -41% |
| HTTP 轮询 p99 | 24.1ms | —（PoC 未实现该路由） | — |

4000 设备 / 12k msg/s：uWS CPU avg=30.6%（45s 窗口）、ELU 17%、RSS 392MB、送达率 100%、exec 3236 QPS——**ws 在此规模已无法完成洪峰段**（OOM 边界）。

**结论：uWS 优势确凿，值得迁移**。但迁移成本同样确凿：
- `index.ts` HTTP 层 + upgrade 鉴权整体重写（uWS 的 res/req 生命周期与 node:http 完全不同：异步 handler 必须挂 onAborted、无流式 res、headers 写法不同）
- `ws-relay.ts` 的 `ws.send`/`bufferedAmount`/ping-pong 心跳全部换 uWS API（getBufferedAmount/cork/drained 回调）
- `api.ts`（1282 行）的路由层需适配（node:http ServerResponse → uWS HttpResponse）
- Docker 增加平台特定二进制（uws_linux_x64_137.node 按 Node ABI 锁定，升级 Node 需重装）
- 94 项回归需全量重验

**迁移判定（2026-08-15 更新）：已完成生产迁移。** HTTP/WS 层全量重写为 uWebSockets.js v20.52.0（commit 66448b7），路由逻辑一行不漏，94 项回归全绿。生产实测（2000 设备 / 6k msg/s / 30s）：

| 指标 | ws 版（迁移前） | uWS 版（生产实测） | 变化 |
|---|---|---|---|
| 事件循环利用率（洪峰） | 80.2% | **9.3-9.5%** | **-88%** |
| 洪峰后 server RSS | 512-549MB | **261-299MB** | **-48%** |
| 广播送达率 | 30% | **100%**（174000 发送 / 4350 精确送达） | 消灭掉帧 |
| exec QPS（并发 10） | 2006 | **3535** | +76% |
| exec p99 | 18.3ms | **11.0ms** | -40% |
| HTTP 轮询 p99 | 24.1ms | 11.0ms | -54% |
| register 风暴（2000 台） | — | p50=25.7ms p99=74ms，4.2s 全量在线 | — |

架构要点：
- `src/uws/http-helpers.ts`：Ctx 模型（同步缓存 url/method/headers——uWS req 异步即失效）、onAborted 标记、writeResponse cork 批写
- `src/uws/ws-socket.ts`：SilkWs 包装（readyState/send/end 兼容层）+ WsUserData 承载 upgrade→open 的 authCtx/url 传递（uWS 官方 UserData 模式）
- 心跳语义变更：uWS `idleTimeout:32 + sendPingsAutomatically` 替代旧 30s 应用层 ping 循环；console 侧 25s `{type:'ping'}→{type:'pong'}` 保留
- 已知 trade-off：uWS 不支持 permessage-deflate（WS 消息不压缩，作者设计哲学）；部署产物需带 `node_modules/uWebSockets.js`（原生 .node 二进制，按 Node ABI 锁定）

PoC 复刻件：`/tmp/uws-poc/server.mjs`（可独立运行复现全部数据）。
