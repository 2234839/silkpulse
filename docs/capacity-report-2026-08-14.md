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

- **不换通信层库**（Fastify/uWebSockets.js）：热点在 WS 扇出与压缩，不在 HTTP 路由（HTTP p99 ≤13.5ms）；换库零收益纯迁移风险。Fastify 实测对比已否决。
- **不做消息合并/裁剪**：合并（WS 本身 TCP 流式 + deflate 上下文跨帧共享）与裁剪（功能降级）都被否决。
- **背压上限维持 1MB**：保护慢消费者场景验证有效。
- 未来真撞 10k+ msg/s 或万级连接时，优先级：uWebSockets.js（连接密度）→ worker_threads 分片控制台 → 进程级水平扩展（registry 分片）。
