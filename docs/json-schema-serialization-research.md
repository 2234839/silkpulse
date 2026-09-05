# JSON 序列化 schema 驱动库调研

> 调研日期：2026-08-15（同日补充 typia 章节）。仅调研结论 + benchmark 数据，未改任何业务代码。
> 背景：task.md 提出「JSON 序列化/反序列化在已知接口（schema）的情况下有库能提升性能，本项目能否使用」。

---

## 一、结论速览

**不建议引入。** 实测数据表明：在本项目的消息形态下，schema 驱动序列化库不快反慢，收益为负。

| 消息形态                            |  native | fast-json-stringify |      加速比 |
| ----------------------------------- | ------: | ------------------: | ----------: |
| log（168B，高频小消息）             |  391 ns |              254 ns | **1.54x ✓** |
| network（631B，动态 headers）       | 1128 ns |             2122 ns |     0.53x ✗ |
| network 完整 schema（公平最佳情况） | 1128 ns |             1587 ns |     0.71x ✗ |
| snapshot（20KB，200 元素）          |    66µs |                71µs |     0.93x ✗ |
| screen-frame（40KB dataURL）        |    24µs |                33µs |     0.75x ✗ |
| **混合负载（5 log + 1 network）**   | 3144 ns |             3414 ns | **0.92x ✗** |

环境：Node 24.3.0 本机，fast-json-stringify@5。

关键发现：**该方案只在「小对象 + 完整字面量 schema」场景快**（高频小 log 消息 1.5x）。本项目消息大头（network 动态键、snapshot 大对象、frame dataURL）全是它的慢路径，混合负载整体反而慢 8%。

---

## 二、这类库是什么、快在哪

你记忆中的方案是这一类库：

| 库                  | 思路                                                        | 状态                 |
| ------------------- | ----------------------------------------------------------- | -------------------- |
| fast-json-stringify | 编译期把 JSON Schema 编译成等价的 `JSON.stringify` 专用代码 | 活跃（Fastify 御用） |
| slow-json-stringify | 同思路，社区仿品                                            | 不活跃               |
| Ajv 序列化          | 同上，配 Fastify 使用                                       | 活跃                 |
| superjson / @podium | 超集序列化（Date/Map 等），目标不同                         | 活跃                 |

共同原理：**运行时跳过类型检查与属性枚举，直接按 schema 生成拼字符串代码**——只在「schema 完全字面量化、键固定、值类型固定」时成立。

## 三、本项目的消息形态 vs 库的快路径

`packages/shared/src/index.ts` 里的 `DeviceMessage` / `ServerToConsoleMessage` 是 tagged union（`type` 字段 + 多形态 payload）。逐条对照：

1. **`log`**：字段固定、全是原始类型 → 库的快路径，1.54x。✓
2. **`network`**：`requestHeaders`/`responseHeaders` 是**任意键值对**（浏览器决定），`requestBody` 是任意字符串 → 落入 `additionalProperties` 慢路径，0.53x。✗
3. **`snapshot`**：payload 是 `JSON.stringify` 的产品——键可变、含 undefined、嵌套对象。schema 只能写 `additionalProperties: true`（全遍历 + 类型探测）→ 0.93x，纯负收益。✗
4. **`screen-frame`**：97% 是 base64 dataURL 字符串。**字符串转义扫描是 stringify 的不可约成本**，任何库都省不掉 → 0.75x（库的函数调用层反而多一层开销）。✗
5. **`devtools-relay`**：payload 已是字符串（SuperJSON 信封），透传，无 stringify 大头。—
6. **server 端 `broadcast()`**：`JSON.stringify(msg)` 的 msg 是**转发场景重新组装的对象**（拼 deviceId 等字段）——对象形状由上游派生，schema 无法前置声明。✗

## 四、反序列化（parse）侧

- **没有生产可用的 schema 驱动 parse 提速库**。fast-json-stringify 只管 stringify；Ajv 的 JTD 政策是「serialize-only」。
- JSON.parse 在 V8 里已高度优化（快路径走 scanner，大消息线性扫描）。实测 log 消息 parse 仅 436ns，6000 msg/s 的 parse 总开销 ≈ 0.3% 事件循环，**不构成瓶颈**。
- 延迟 parse（只抽 `type` 字段路由）项目已在压测接收侧这么做（capacity 报告「接收侧免全文 JSON.parse」），生产 server 未这么做是正确的——server 要消费完整 payload 存环形缓冲。

## 五、对照容量报告验证

2026-08-14 容量报告：4000 设备在线、6k msg/s、事件循环利用率 64%。分项拆解 6k msg/s 的时间预算：

| 环节                                 |  估算占比 | 说明                    |
| ------------------------------------ | --------: | ----------------------- |
| WS 帧解包 + permessage-deflate 压缩  |      ~35% | 报告已定位的大头        |
| **JSON.parse 入站消息**              | **~0.3%** | 实测 436ns×6k ≈ 2.6ms/s |
| 业务逻辑（环形缓冲、registry、路由） |      ~20% |                         |
| broadcast stringify + send           |       ~8% | 多控制台扇出时线性放大  |
| HTTP 路由 + agent-api 序列化         |      余量 | p99 ≤13.5ms，非瓶颈     |

**stringify+parse 合计 < 1% 事件循环。** 就算引入库把 log 类 stringify 提速 1.5x，对总吞吐影响 < 0.1%。这不是当前瓶颈，也不是近期会撞到的瓶颈。

## 六、迁移成本（如果硬要上）

- shared 协议定义是 TS tagged union，需要手工维护**双份真相**（TS 类型 + JSON Schema），或引入 codegen（json-schema-to-ts 反向），任何协议演进都要同步两处，与「let it crash、快速迭代」的节奏冲突。
- 输出键序与 native 不同（实测不一致），`diff.ts` 用 `JSON.stringify` 做 style 对比的地方会被破坏。
- SDK 运行在浏览器，引入库增加 bundle ~15KB（gzip 前），IIFE 注入体积敏感。
- exec-runner 的 `serializeResult` 带自定义 replacer（bigint/Error/Date），schema 库不支持自定义 replacer，该路径完全不适配。

## 七、什么情况下值得重新评估

1. 消息速率从 6k msg/s 提升一个数量级（10 万+ msg/s），且消息形态转向固定小消息为主（纯 log 频发）；
2. 换到支持 JTD 的全链路方案且两端都换（远超当前需求）；
3. HTTP API 层换 Fastify 时顺带获得（不为此单独引入）。

## 八、附：复现方式

benchmark 脚本在 `/tmp/json-bench/`（临时，未入库）。核心对照：

```
log(168B)     native  391 ns/op
log(168B)     fast    254 ns/op   ← 唯一快路径
network(631B) native  1128 ns/op
network(631B) full-schema 1587 ns/op
mix(5log+1net) native 3144 ns/op
mix(5log+1net) fast   3414 ns/op  ← 整体更慢
```

核心认知：**schema 驱动序列化只优化「拼字符串时的类型分派」，不优化字符串本身的扫描与转义**。本项目的大头成本在字符串（dataURL、任意 header 键、快照文本），不在类型分派。真正的性能主线还是容量报告里的优先级：uWS → worker 分片 → 进程扩展。

---

# 补充调研：typia（2026-08-15 追加）

> 背景：追问「typia 呢」。typia 与 fast-json-stringify 思路同源，但有一个关键区别：
> **从 TS 类型直接编译期生成代码，不需要维护 JSON Schema 双份真相**——理论上消除了上一轮否决的主要迁移成本，值得单独验证。

## 九、typia 实测数据

typia 13.3.0（2026 年当前版），官方 `typia generate` 代码生成工作流（Go 原生编译器 + TS-Go），消息形态与前一轮 benchmark 完全同构：

| 消息形态                          |  native | typia 生成代码 |      加速比 |
| --------------------------------- | ------: | -------------: | ----------: |
| log（168B 固定字段）              |  421 ns |         208 ns | **2.02x ✓** |
| network（631B 动态 headers）      | 1165 ns |        2588 ns |     0.45x ✗ |
| snapshot（20KB 开放结构）         |    70µs |           48µs | **1.46x ✓** |
| screen-frame（40KB dataURL）      |    26µs |           59µs |     0.44x ✗ |
| parse log（校验式）               |  571 ns |         591 ns |     0.97x ✗ |
| **混合负载（5 log + 1 network）** | 3321 ns |        3903 ns | **0.85x ✗** |

正确性：四类消息输出与 native 全部一致（含 optional 字段、动态键、中文字符串）。

## 十、typia 数据解读

- **log 快 2 倍**（比 fast-json-stringify 的 1.54x 更快）：typia 的生成代码完全内联，无 schema 解释层。
- **snapshot 反而快 1.46x**：这是与 fast-json-stringify 的关键差异——typia 对 `Record<string, string>` 之外的开放对象也能生成合理的遍历代码，没有 `additionalProperties` 慢路径惩罚。
- **network（动态 headers）0.45x、frame（dataURL）0.44x，比 fast-json-stringify 还慢**：
  - network：`Record<string, string>` 的动态键索引访问，typia 生成的是逐键安全检查代码；
  - frame：40KB 字符串转义，typia 生成的 `_jsonStringifyString` 走自己的转义实现，比 V8 原生慢。
- **校验式 parse 无收益（0.97x）**：typia 的 `createAssertParse` 实际是 `JSON.parse` + 逐字段校验，校验是额外成本。反序列化提速的结论不变。
- **混合负载 0.85x**：本项目真实消息配比下整体仍慢 15%。

## 十一、typia 的工程成本（实测踩坑记录）

这一轮 benchmark 搭环境耗时远超预期，暴露的工程成本比性能差异更重要：

1. **typia 13 已完全放弃 TS transform 插件路线**，改为 `typia generate`（Go 编译器 + `@typescript/typescript-linux-x64` 原生 tsc 二进制）。旧的 `ts-patch` + `plugins` 配置全部失效，且错误信息晦涩（`no transform has been configured` / `path.join(undefined)`）。
2. **API 也变了**：`typia.stringify<T>()` → `typia.json.createStringify<T>()`（工厂函数），旧文档大量失效。
3. **工具链锁定**：需要 TS 6+、平台专属二进制包。本项目用 vite-plus（rolldown/vp pack）构建，引入 typia 意味着消息协议的构建链多一个 Go 工具依赖，CI 和 Docker 镜像都要跟着改。
4. **浏览器端（SDK）不适配**：`typia generate` 产出依赖 `typia/lib/internal/*` 运行时模块，SDK 是 IIFE 注入浏览器的，引入后 bundle 显著变大。

## 十二、typia 结论

**同样不引入，但否决理由与 fast-json-stringify 不同：**

- fast-json-stringify：schema 慢路径惩罚（性能否决为主 + 双份真相维护成本）
- typia：混合负载 0.85x（性能否决）+ 工具链重锤（Go 编译器/TS6 锁定/浏览器端不适配）

**typia 的正确使用场景**（本项目不具备）：字段完全固定的高频 RPC 消息（如内部微服务协议）、需要编译期类型安全校验的 API 边界、纯 Node 后端且已用 tsc 构建。若未来 exec 链路演进为高频固定 schema 的 RPC，typia 是比 fast-json-stringify 更好的选择。

## 十三、复现方式（typia 部分）

```
mkdir typia-bench && cd typia-bench
npm i typia ttsc typescript@6 @typescript/typescript-linux-x64 @types/node
# 模板文件写 typia.json.createStringify<T>() 工厂调用
npx typia generate --input src2 --output generated2
npx tsc -p tsconfig.dist.json && node dist2/main.typia.js
```

关键点：typia 13 必须用 `createStringify`/`createAssertParse` 工厂函数（直接调 `typia.json.stringify<T>()` 会报 no input value），生成步骤依赖 Go 工具链缓存（首次构建数分钟）。
