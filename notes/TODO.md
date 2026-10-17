# TODO

> 由 `pact todo` 生成，勿手改。按 diff 组织：每块只列差异行（+ 新 / - 旧），实现后 `pact todo --done <块ID>` 标记完成。已删除的块用 `pact todo --clean <块ID>` 清理记录。共 1 项待办。

## 新增：[需求：AI 通过 HTTP API 查看指定组件（如 View）的信息](agent-capabilities.md)

- 块 ID: `agent-capabilities.md#ai.component-query`

```diff
+ 场景：agent 通过 HTTP API 定位页面上某个组件（如 `View`），查看它的组件树位置、props/state/hooks 全量信息。
+ 
+ 现状（已实现，exec 组合调用）：
+ 1. `GET /api/agent/devices` 拿设备 id
+ 2. `POST /:id/exec` 执行 `await __silkpulse_devtools_tree()` → `{ framework, tree: [{ name, idx, id, children }] }`
+ 3. 按组件名（React displayName / Vue name）在树中定位，拿 `idx`
+ 4. `POST /:id/exec` 执行 `await __silkpulse_devtools_inspect(idx)` → props/state/hooks 全量
+ 5. 可选 `__silkpulse_devtools_set(idx, type, path, value, hookID?)` 修改并触发重渲染
+ 
+ 已知边界：React 多 renderer 页面只取第一个 renderer；Vue template 定义无 name 的根组件显示 Anonymous（id 仍有效）。
+ 
+ 待实现（缺口）：组件查询没有专用 HTTP 端点，agent 需要自己拼 JS 代码字符串。规划专用端点：
+ - `GET /api/agent/devices/:id/component/tree` → 组件树 JSON（内部调 devtools_tree）
+ - `GET /api/agent/devices/:id/component/inspect?idx=N` → 单组件全量数据（内部调 devtools_inspect）
+ 并同步收录进 `/api/skill/silkpulse` 的 API 表。
+ 
+ 实现：[[packages/sdk/src/devtools-helpers.ts]]、[[packages/server/src/agent-api.ts]]
+ ### 验收
+ - agent 仅凭 skill 模板文档（不看源码）即可完成「定位 View 组件 → 读其 props/state」全流程
+ - 专用端点落地后，同样流程不需要 exec 拼 JS
```
