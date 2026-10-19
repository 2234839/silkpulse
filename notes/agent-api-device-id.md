# agent API deviceId 前缀匹配

## 需求：exec/snapshot 等接口支持 deviceId 前缀匹配 [[agent-api.device-id-prefix]]

背景：用户反馈「exec/snapshot 需用完整 deviceId，文档说的 ID 前缀匹配实测不生效」。

根因：文档（SKILL.md、SDK 复制的 agent 提示词、skill-template.ts）均宣称「id 支持前缀匹配」，但该逻辑只在 skill CLI 脚本（tools/skill/scripts/silkpulse.mjs 的 resolveDeviceId）里实现；服务端 `/api/agent/devices/:id/*` 只做 `registry.get(deviceId)` 精确匹配，HTTP 直调时前缀必然 404。

方案：把前缀解析下沉到服务端 agent-api.ts（resolveAgentDevice）：
- 完整 id 精确命中优先；
- 否则在当前鉴权可见范围（项目密钥限定 projectId）内取唯一前缀匹配；
- 多个匹配 → 400 列出候选，0 个匹配 → 404 原提示。

实现见 [agent-api.ts](../packages/server/src/agent-api.ts)

### 验收
- `GET /api/agent/devices/<前缀>/exec` 等所有 `:id` 路由：唯一前缀命中正常执行，多前缀报 400 列候选，无命中报 404。
- 项目密钥下前缀匹配不会跨项目命中。
- 文档宣称的前缀匹配行为与实际一致（HTTP 直调、SDK 复制提示词、CLI 三条链路统一）。
