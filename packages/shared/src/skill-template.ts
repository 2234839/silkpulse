/**
 * Agent skill 提示词模板 —— 服务端 + 控制台共用
 *
 * 服务端在 /api/skill/clarosight 路由中用此模板按需返回文档，
 * 控制台在"接入 Agent"弹窗中也用同一份模板生成完整提示词。
 * 两端共用同一份模板，确保 agent 拿到的内容永远一致。
 *
 * 占位符：
 * - __SERVER_URL__ → 服务访问地址（如 https://clarosight.heartstack.space）
 * - __API_KEY__    → 用户密钥（超管密钥或项目密钥）
 */

/** 控制台地址用于 dashboard 链接等场景 */
const PLACEHOLDER_SERVER_URL = '__SERVER_URL__'
const PLACEHOLDER_API_KEY = '__API_KEY__'

/**
 * 完整的 agent 提示词模板（含占位符）
 *
 * 包含：连接信息、API 列表、exec 辅助函数、snapshot 阅读指南、诊断流程。
 * ~1500 字，agent 加载后即可通过 HTTP API 完整操作远程设备。
 */
export const SKILL_PROMPT_TEMPLATE = `# Clarosight —— 远程设备调试工具

你可以通过以下 HTTP API 直接调试远程设备（线上页面、用户浏览器等）。

## 连接信息

- Server: ${PLACEHOLDER_SERVER_URL}
- API Key: ${PLACEHOLDER_API_KEY}
- 所有请求需携带 Header: \`Authorization: Bearer ${PLACEHOLDER_API_KEY}\`
- 建议加 \`Accept-Encoding: gzip\` 头减少传输量

## API 列表

所有接口前缀：\`${PLACEHOLDER_SERVER_URL}/api/devices\`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | \`/<id>/inspect\` | **一键诊断聚合**（错误 + 失败网络 + 快照，最高效入口） |
| GET | \`/<id>/snapshot\` | 页面快照（AI 友好的 compact 文本） |
| GET | \`/<id>/logs?limit=20\` | 最近 N 条 console 日志 |
| GET | \`/<id>/errors?limit=10\` | 最近 N 条错误（带 source map 解析） |
| GET | \`/<id>/network?limit=10\` | 最近 N 条网络请求（含响应体） |
| POST | \`/<id>/exec\` | 在远程页面执行 JS 代码（body: \`{ "code": "..." }\`） |

查看所有在线设备：\`GET ${PLACEHOLDER_SERVER_URL}/api/devices\` → \`{ devices: [{ id, url, title }] }\`

### exec 示例

\`\`\`bash
curl -s -X POST -H "Authorization: Bearer ${PLACEHOLDER_API_KEY}" -H "Content-Type: application/json" \\
  -d '{"code":"return document.title"}' \\
  "${PLACEHOLDER_SERVER_URL}/api/devices/<deviceId>/exec"
\`\`\`

exec 的 code 作为 **async 函数体**执行，写 \`return\` 返回结果。

## exec 辅助函数（在远程页面上下文直接调用）

- \`__clarosight_click(idx)\` — 点击元素（用 snapshot 中的 idx）
- \`__clarosight_setValue(idx, val)\` — 设置表单值（兼容 Vue/React v-model）
- \`__clarosight_type(idx, text)\` — 逐字输入（触发 keydown/keyup）
- \`__clarosight_wait(ms)\` — 异步等待
- \`__clarosight_snapshot()\` — 取页面快照
- \`__clarosight_sourcemap(line, col, url?)\` — source map 解析（压缩代码定位源码）

## snapshot 阅读指南

\`\`\`
button #5 text=提交           ← idx=5 的按钮
input #4 #name ph:输入名字     ← idx=4 的输入框
select #9 check=bj:北京 <bj:北京|sh:上海>  ← 下拉框（setValue 传 value）
\`\`\`
\`#数字\` 是稳定 idx，跨快照不变，供 \`__clarosight_click(idx)\` 使用。

## 典型诊断流程

1. \`GET /api/devices\` → 拿到在线设备列表和 id
2. \`GET /<id>/inspect\` → 一键聚合诊断（最高效）
3. 需要深入时用 \`/<id>/logs|errors|network\` 逐项查看
4. \`POST /<id>/exec\` → 执行诊断代码定位问题

exec 超时 10 秒，长任务需拆分。`

/**
 * 渐进式加载的系统提示词模板（极短）
 *
 * 只有几十个 token，放在 agent 的系统提示词中。
 * agent 遇到需要远程调试前端/网页问题时，主动 curl 拉取完整 skill 文档。
 * 完整文档由服务端 /api/skill/clarosight?key=xx 端点返回。
 */
export const SKILL_SYSTEM_PROMPT_TEMPLATE = `你有一个远程调试工具 Clarosight 可用。

当用户遇到前端 / 网页 / 线上 bug 需要远程查看或调试时，先用 curl 拉取技能文档：

curl -s "${PLACEHOLDER_SERVER_URL}/api/skill/clarosight?key=${PLACEHOLDER_API_KEY}"

拉取后按文档中的 API 列表操作即可（查看在线设备、快照、日志、错误、网络请求、执行代码等）。
不需要时忽略此工具。`

/**
 * 渲染完整 skill 提示词：替换占位符为实际值
 *
 * @param serverUrl 服务访问地址（如 https://clarosight.heartstack.space）
 * @param apiKey    用户密钥
 * @returns 替换占位符后的完整提示词
 */
export function renderSkillPrompt(serverUrl: string, apiKey: string): string {
  return SKILL_PROMPT_TEMPLATE
    .replaceAll(PLACEHOLDER_SERVER_URL, serverUrl)
    .replaceAll(PLACEHOLDER_API_KEY, apiKey)
}

/**
 * 渲染渐进式加载的系统提示词：替换占位符为实际值
 *
 * @param serverUrl 服务访问地址
 * @param apiKey    用户密钥
 * @returns 替换占位符后的极短系统提示词
 */
export function renderSkillSystemPrompt(serverUrl: string, apiKey: string): string {
  return SKILL_SYSTEM_PROMPT_TEMPLATE
    .replaceAll(PLACEHOLDER_SERVER_URL, serverUrl)
    .replaceAll(PLACEHOLDER_API_KEY, apiKey)
}
