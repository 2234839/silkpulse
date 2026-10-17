# AI 能力暴露现状梳理

目标：梳理 SilkPulse 目前把调试能力给 AI（agent）用的两条链路——「哪些 DevTools 能力已暴露」和「HTTP API 入口有哪些」，并标出尚未暴露的缺口。

## 问题 1：VTools / React DevTools / Chrome DevTools 能力是否已给 AI 用 [[ai.devtools-capability]]

结论：**部分已暴露，走 SDK 页内辅助函数（exec 内调用），控制台专属的完整 DevTools 面板能力未直接暴露。**

已暴露（agent 在 `/exec` 的 code 里调用 `__silkpulse_*` 辅助函数，无需控制台打开）：
- React DevTools：`__silkpulse_devtools_tree/inspect/set` —— 组件树、读 props/state/hooks、改 state（走页内 react-devtools backend 本地直调，等效 setState；首次调用自动激活 backend）
- Vue DevTools（VTools）：同上四个函数通吃 Vue —— 直接读写组件实例响应式对象（setupState/data/props），走 devtools-core 本地直调
- Chrome DevTools 能力（经自研采集而非 CDP 转发）：console 日志、错误（含 source map 解析）、网络请求列表、DOM 元素树/样式、快照、截图、点击/输入/设值

未暴露的缺口：
- 官方 DevTools 前端（chii embedded 的 Elements 面板、Network Messages/EventStream 页签等）只在控制台可用，agent 没有 CDP 端点（如 `Network.getResponseBody` 这类按 requestId 回查 body 的能力目前 agent 不可调）
- WS/SSE 帧 inspect（ws-frame/sse-event sink）只在控制台 Messages 页签呈现，agent HTTP API 无对应端点
- CSS 规则查询 `/api/devices/:id/element/styles` 只在内部 API，agent API 未收录进 skill 模板

实现：[[packages/sdk/src/devtools-helpers.ts]]、[[packages/sdk/src/react-devtools-bridge.ts]]、[[packages/sdk/src/devtools-bridge.ts]]、[[packages/sdk/src/chobitsu-bridge.ts]]

### 验收
- 每项「已暴露」能力有对应的 `__silkpulse_*` 函数或 HTTP 端点可指认
- 缺口清单与代码现状一致（不虚报已实现项）

验证：`.claude/replay/verify-devtools-agent-api.mjs`（2026-10-17 全部断言通过）

## 需求：AI 通过 HTTP API 查看指定组件（如 View）的信息 [[ai.component-query]]

场景：agent 通过 HTTP API 定位页面上某个组件（如 `View`），查看它的组件树位置、props/state/hooks 全量信息。

现状（已实现，exec 组合调用）：
1. `GET /api/agent/devices` 拿设备 id
2. `POST /:id/exec` 执行 `await __silkpulse_devtools_tree()` → `{ framework, tree: [{ name, idx, id, children }] }`
3. 按组件名（React displayName / Vue name）在树中定位，拿 `idx`
4. `POST /:id/exec` 执行 `await __silkpulse_devtools_inspect(idx)` → props/state/hooks 全量
5. 可选 `__silkpulse_devtools_set(idx, type, path, value, hookID?)` 修改并触发重渲染

已知边界：React 多 renderer 页面只取第一个 renderer；Vue template 定义无 name 的根组件显示 Anonymous（id 仍有效）。

待实现（缺口）：组件查询没有专用 HTTP 端点，agent 需要自己拼 JS 代码字符串。规划专用端点：
- `GET /api/agent/devices/:id/component/tree` → 组件树 JSON（内部调 devtools_tree）
- `GET /api/agent/devices/:id/component/inspect?idx=N` → 单组件全量数据（内部调 devtools_inspect）
并同步收录进 `/api/skill/silkpulse` 的 API 表。

实现：[[packages/sdk/src/devtools-helpers.ts]]、[[packages/server/src/agent-api.ts]]

### 验收
- agent 仅凭 skill 模板文档（不看源码）即可完成「定位 View 组件 → 读其 props/state」全流程
- 专用端点落地后，同样流程不需要 exec 拼 JS

## 问题 2：是否有 HTTP API 供 AI 调用 [[ai.http-api]]

结论：**有，双入口。**

- `/api/agent/*`（`packages/server/src/agent-api.ts`）：agent 专用 REST，统一精简输出。鉴权同内部 API（Bearer key / ?key=），匿名 401
  - `GET /api/agent/devices` 精简设备列表
  - `GET /:id/inspect` 一键诊断聚合（错误 + 失败请求 + 快照，最高效入口）
  - `GET /:id/snapshot|logs|errors|network`（支持 `?limit=`，text/plain）
  - `GET /:id/screenshot?idx=&format=&quality=&scale=`（二进制图片）
  - `GET /:id/element/tree?idx=&shadow=1&filter=`（JSON，支持 gzip）
  - `POST /:id/exec`（body `{code}`，async 函数体；`?snapshot=0` 省 token）
- `/api/skill/silkpulse`（`packages/server/src/api.ts` + `packages/shared/src/skill-template.ts`）：渐进式 skill 文档，返回完整提示词模板（连接信息 + API 表 + 辅助函数清单 + 诊断流程），控制台「接入 Agent」弹窗与服务端共用同一份模板

实现：[[packages/server/src/agent-api.ts]]、[[packages/server/src/api.ts]]、[[packages/shared/src/skill-template.ts]]

### 验收
- skill 模板里的每个端点在 agent-api.ts 有对应实现
- 未收录进 skill 模板的能力（element/styles 等）在缺口清单中登记

验证：`.claude/replay/verify-devtools-agent-api.mjs`（2026-10-17 全部断言通过）
